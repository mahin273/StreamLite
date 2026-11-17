import { Injectable, Inject } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { AuthDatabase } from './database.js';
import type { Users, EmailTokens } from './types.js';

export const AUTH_DATABASE = 'AUTH_DATABASE';
export type User = Selectable<Users>;
export type EmailToken = Selectable<EmailTokens>;

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
}
