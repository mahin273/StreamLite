import { Injectable, Inject } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { AuthDatabase } from './database.js';
import type { Users } from './types.js';

export const AUTH_DATABASE = 'AUTH_DATABASE';
export type User = Selectable<Users>;

export interface CreateRegisteredUserParams {
  email: string;
  passwordHash: string;
  displayName: string;
  tokenHash: Buffer;
  rawToken: string;
  tokenExpiresAt: Date;
  traceId?: string | undefined;
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
}
