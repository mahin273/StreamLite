import { Injectable, Inject } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { AuthDatabase } from './database.js';
import type { Users, EmailTokens, RefreshTokens } from './types.js';

export const AUTH_DATABASE = 'AUTH_DATABASE';
export type User = Selectable<Users>;
export type EmailToken = Selectable<EmailTokens>;
export type RefreshToken = Selectable<RefreshTokens>;

export interface CreateRegisteredUserParams {
  email: string;
  passwordHash: string;
  displayName: string;
  tokenHash: Buffer;
  rawToken: string;
  tokenExpiresAt: Date;
  traceId?: string | undefined;
}

export interface CreateEmailTokenParams {
  userId: string;
  email: string;
  kind: 'verify_email' | 'reset_password';
  tokenHash: Buffer;
  rawToken: string;
  expiresAt: Date;
  topic: string;
}

export interface ResetPasswordParams {
  tokenHash: Buffer;
  newPasswordHash: string;
}

@Injectable()
export class UserRepository {
  constructor(@Inject(AUTH_DATABASE) private readonly db: AuthDatabase) {}

  async findByEmail(email: string): Promise<User | undefined> {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<User | undefined> {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async createRegisteredUser(params: CreateRegisteredUserParams): Promise<User> {
    return this.db.transaction().execute(async (trx) => {
      // 1. Insert user with pending_verification status
      const user = await trx
        .insertInto('users')
        .values({
          email: params.email,
          password_hash: params.passwordHash,
          role: 'viewer',
          status: 'pending_verification',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Insert primary profile with display name
      await trx
        .insertInto('profiles')
        .values({
          user_id: user.id,
          name: params.displayName,
          is_kids: false,
          age_limit: 18,
        })
        .execute();

      // 3. Insert email verification token
      await trx
        .insertInto('email_tokens')
        .values({
          user_id: user.id,
          kind: 'verify_email',
          token_hash: params.tokenHash,
          expires_at: params.tokenExpiresAt,
        })
        .execute();

      // 4. Enqueue outbox event for notification delivery
      await trx
        .insertInto('outbox')
        .values({
          topic: 'auth.user.registered',
          key: user.id,
          payload: {
            userId: user.id,
            email: user.email,
            token: params.rawToken,
          },
          trace_id: params.traceId ?? null,
          sent_at: null,
        })
        .execute();

      return user;
    });
  }

  /**
   * Atomically consumes a verification token and marks the corresponding user active.
   * Throws Error('INVALID_TOKEN') if the token is non-existent, expired, or already used.
   */
  async verifyEmailWithToken(tokenHash: Buffer): Promise<User> {
    return this.db.transaction().execute(async (trx) => {
      const token = await trx
        .updateTable('email_tokens')
        .set({ used_at: new Date() })
        .where('token_hash', '=', tokenHash)
        .where('kind', '=', 'verify_email')
        .where('used_at', 'is', null)
        .where('expires_at', '>', new Date())
        .returningAll()
        .executeTakeFirst();

      if (!token) {
        throw new Error('INVALID_OR_EXPIRED_TOKEN');
      }

      return trx
        .updateTable('users')
        .set({
          status: 'active',
          email_verified_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', token.user_id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * Invalidates any older pending tokens of the given kind for this user,
   * stores a new token, and queues an outbox event inside a single transaction.
   */
  async createEmailTokenAndOutbox(params: CreateEmailTokenParams): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Invalidate existing unused tokens of the same kind for this user
      await trx
        .updateTable('email_tokens')
        .set({ used_at: new Date() })
        .where('user_id', '=', params.userId)
        .where('kind', '=', params.kind)
        .where('used_at', 'is', null)
        .execute();

      // Insert fresh token
      await trx
        .insertInto('email_tokens')
        .values({
          user_id: params.userId,
          kind: params.kind,
          token_hash: params.tokenHash,
          expires_at: params.expiresAt,
        })
        .execute();

      // Enqueue notification outbox event
      await trx
        .insertInto('outbox')
        .values({
          topic: params.topic,
          key: params.userId,
          payload: {
            userId: params.userId,
            email: params.email,
            token: params.rawToken,
            kind: params.kind,
          },
          sent_at: null,
        })
        .execute();
    });
  }

  /**
   * Atomically verifies and consumes a password reset token, updates the user's password,
   * revokes all active refresh tokens for the user, and enqueues a security confirmation email.
   */
  async resetPasswordWithToken(params: ResetPasswordParams): Promise<User> {
    return this.db.transaction().execute(async (trx) => {
      // 1. Atomically consume the single-use reset token
      const token = await trx
        .updateTable('email_tokens')
        .set({ used_at: new Date() })
        .where('token_hash', '=', params.tokenHash)
        .where('kind', '=', 'reset_password')
        .where('used_at', 'is', null)
        .where('expires_at', '>', new Date())
        .returningAll()
        .executeTakeFirst();

      if (!token) {
        throw new Error('INVALID_OR_EXPIRED_TOKEN');
      }

      // 2. Update user password
      const user = await trx
        .updateTable('users')
        .set({
          password_hash: params.newPasswordHash,
          updated_at: new Date(),
        })
        .where('id', '=', token.user_id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // 3. Revoke all active sessions / refresh tokens
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', token.user_id)
        .where('revoked_at', 'is', null)
        .execute();

      // 4. Enqueue password-changed security notice in outbox
      await trx
        .insertInto('outbox')
        .values({
          topic: 'auth.email.password_changed',
          key: token.user_id,
          payload: {
            userId: token.user_id,
            email: user.email,
          },
          sent_at: null,
        })
        .execute();

      return user;
    });
  }

  /**
   * Resets failed login attempts for a user upon successful authentication
   * and restores status to active if previously locked.
   */
  async resetFailedLogins(userId: string): Promise<void> {
    await this.db
      .updateTable('users')
      .set({
        failed_logins: 0,
        locked_until: null,
        status: 'active',
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();
  }

  /**
   * Records a failed login attempt for a user and applies exponential account lockout
   * if failed attempts reach or exceed the threshold (default: 5).
   * Backoff: 5 failures -> 15 min, 6 failures -> 30 min, 7 failures -> 60 min, 8+ failures -> 120 min.
   */
  async recordFailedLogin(
    userId: string,
    lockoutThreshold = 5,
  ): Promise<{ failedLogins: number; isLocked: boolean; lockedUntil: Date | null }> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('users')
        .set((eb) => ({
          failed_logins: eb('failed_logins', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', userId)
        .returning(['failed_logins'])
        .executeTakeFirstOrThrow();

      const count = updated.failed_logins;
      if (count >= lockoutThreshold) {
        // Exponential backoff: 15m -> 30m -> 60m -> 120m max
        const exponent = Math.min(count - lockoutThreshold, 3);
        const lockDurationMinutes = 15 * Math.pow(2, exponent);
        const lockedUntil = new Date(Date.now() + lockDurationMinutes * 60 * 1000);

        await trx
          .updateTable('users')
          .set({
            status: 'locked',
            locked_until: lockedUntil,
            updated_at: new Date(),
          })
          .where('id', '=', userId)
          .execute();

        return { failedLogins: count, isLocked: true, lockedUntil };
      }

      return { failedLogins: count, isLocked: false, lockedUntil: null };
    });
  }

  /**
   * Increments failed logins counter.
   */
  async incrementFailedLogins(userId: string): Promise<number> {
    const res = await this.db
      .updateTable('users')
      .set((eb) => ({
        failed_logins: eb('failed_logins', '+', 1),
        updated_at: new Date(),
      }))
      .where('id', '=', userId)
      .returning(['failed_logins'])
      .executeTakeFirst();
    return res?.failed_logins ?? 0;
  }

  /**
   * Inserts a new refresh token record.
   */
  async createRefreshToken(params: {
    id?: string;
    userId: string;
    familyId: string;
    tokenHash: Buffer;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<RefreshToken> {
    return this.db
      .insertInto('refresh_tokens')
      .values({
        ...(params.id ? { id: params.id } : {}),
        user_id: params.userId,
        family_id: params.familyId,
        token_hash: params.tokenHash,
        expires_at: params.expiresAt,
        ip: params.ip ?? null,
        user_agent: params.userAgent ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Finds a refresh token by its SHA-256 binary hash.
   */
  async findRefreshTokenByHash(tokenHash: Buffer): Promise<RefreshToken | undefined> {
    return this.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
  }

  /**
   * Atomically marks the old refresh token as revoked/replaced, and inserts the new token
   * in the exact same family within a single database transaction.
   */
  async rotateRefreshToken(params: {
    oldTokenId: string;
    newTokenId: string;
    userId: string;
    familyId: string;
    newTokenHash: Buffer;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<RefreshToken> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('refresh_tokens')
        .set({
          revoked_at: new Date(),
          replaced_by: params.newTokenId,
        })
        .where('id', '=', params.oldTokenId)
        .execute();

      return trx
        .insertInto('refresh_tokens')
        .values({
          id: params.newTokenId,
          user_id: params.userId,
          family_id: params.familyId,
          token_hash: params.newTokenHash,
          expires_at: params.expiresAt,
          ip: params.ip ?? null,
          user_agent: params.userAgent ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * Revokes a specific refresh token by its hash.
   */
  async revokeRefreshToken(tokenHash: Buffer): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Revokes all refresh tokens belonging to a specific token family.
   * Invoked upon detecting reuse of an already-revoked refresh token.
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Revokes all active refresh tokens for a user across all sessions/devices.
   */
  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
