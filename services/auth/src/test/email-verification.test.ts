import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ProblemDetailsFilter } from '@streamlite/http';
import { createAuthDatabase, type AuthDatabase } from '../store/database.js';
import { AuthModule } from '../auth.module.js';
import { EmailService } from '../email/email.service.js';
import {
  GENERIC_VERIFICATION_SENT_MESSAGE,
  GENERIC_RESET_SENT_MESSAGE,
} from '../http/dto/email-verification.dto.js';
import { Argon2Hasher } from '../security/argon2-hasher.js';

describe('Email Verification & Password Reset (Integration)', () => {
  let app: NestFastifyApplication;
  let db: AuthDatabase;
  let emailService: EmailService;
  let hasher: Argon2Hasher;

  before(async () => {
    const dbInstance = createAuthDatabase({
      connectionString:
        process.env['AUTH_DB_URL'] || 'postgres://auth:10273@localhost:5438/auth_db',
      maxConnections: 5,
    });
    db = dbInstance.db;

    app = await NestFactory.create<NestFastifyApplication>(
      AuthModule.register({
        connectionString:
          process.env['AUTH_DB_URL'] || 'postgres://auth:10273@localhost:5438/auth_db',
        maxConnections: 5,
      }),
      new FastifyAdapter(),
      { logger: false },
    );

    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    emailService = app.get(EmailService);
    hasher = app.get(Argon2Hasher);
  });

  after(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(async () => {
    // Clear state between tests
    await db.deleteFrom('outbox').execute();
    await db.deleteFrom('refresh_tokens').execute();
    await db.deleteFrom('email_tokens').execute();
    await db.deleteFrom('profiles').execute();
    await db.deleteFrom('users').execute();
  });

  async function registerUser(email: string): Promise<{ userId: string; token: string }> {
    const fastify = app.getHttpAdapter().getInstance();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email,
        password: 'OriginalPassword#2026',
        displayName: 'Test User',
      },
    });
    assert.strictEqual(res.statusCode, 202);

    const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirstOrThrow();
    const outbox = await db
      .selectFrom('outbox')
      .selectAll()
      .where('key', '=', user.id)
      .where('topic', '=', 'auth.user.registered')
      .executeTakeFirstOrThrow();

    const payload = outbox.payload as { token: string };
    return { userId: user.id, token: payload.token };
  }

  describe('Email Verification Flow', () => {
    it('should verify email with valid token and transition user status to active', async () => {
      const email = `verify.${randomUUID()}@streamlite.dev`;
      const { userId, token } = await registerUser(email);

      const fastify = app.getHttpAdapter().getInstance();
      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.message, 'Email verified successfully. Your account is now active.');

      // Check user record
      const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
      assert.strictEqual(user.status, 'active');
      assert.ok(user.email_verified_at !== null, 'email_verified_at must be populated');

      // Check token record marked used
      const tokenRow = await db
        .selectFrom('email_tokens')
        .selectAll()
        .where('user_id', '=', userId)
        .where('kind', '=', 'verify_email')
        .executeTakeFirstOrThrow();

      assert.ok(tokenRow.used_at !== null, 'Token used_at must be populated');
    });

    it('should reject already used verification token (anti-replay)', async () => {
      const email = `replay.${randomUUID()}@streamlite.dev`;
      const { token } = await registerUser(email);
      const fastify = app.getHttpAdapter().getInstance();

      // First verification succeeds
      const res1 = await fastify.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token },
      });
      assert.strictEqual(res1.statusCode, 200);

      // Second verification attempt with same token fails
      const res2 = await fastify.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token },
      });

      assert.strictEqual(res2.statusCode, 400);
      const body = JSON.parse(res2.payload);
      assert.strictEqual(body.status, 400);
      assert.strictEqual(body.detail, 'Invalid, expired, or already used verification token');
    });

    it('should reject invalid hex token with 400 problem details', async () => {
      const fastify = app.getHttpAdapter().getInstance();
      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token: 'invalid_token' },
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.title, 'Validation Failed');
    });
  });

  describe('Resend Verification Flow', () => {
    it('should invalidate old token, generate new token, and enqueue outbox event', async () => {
      const email = `resend.${randomUUID()}@streamlite.dev`;
      const { userId, token: oldToken } = await registerUser(email);
      const fastify = app.getHttpAdapter().getInstance();

      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/resend-verification',
        payload: { email },
      });

      assert.strictEqual(res.statusCode, 202);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.message, GENERIC_VERIFICATION_SENT_MESSAGE);

      // Verify old token was marked used (invalidated)
      const tokens = await db
        .selectFrom('email_tokens')
        .selectAll()
        .where('user_id', '=', userId)
        .where('kind', '=', 'verify_email')
        .orderBy('expires_at', 'asc')
        .execute();

      assert.strictEqual(tokens.length, 2);
      assert.ok(tokens[0]?.used_at !== null, 'Older token must be invalidated');
      assert.strictEqual(tokens[1]?.used_at, null, 'New token must be unused');

      // Old token can no longer verify
      const failRes = await fastify.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token: oldToken },
      });
      assert.strictEqual(failRes.statusCode, 400);

      // New token from outbox can verify
      const newOutbox = await db
        .selectFrom('outbox')
        .selectAll()
        .where('key', '=', userId)
        .where('topic', '=', 'auth.email.verification')
        .executeTakeFirstOrThrow();

      const newToken = (newOutbox.payload as { token: string }).token;
      const successRes = await fastify.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token: newToken },
      });
      assert.strictEqual(successRes.statusCode, 200);
    });

    it('should implement anti-enumeration for non-existent email in resend', async () => {
      const fastify = app.getHttpAdapter().getInstance();
      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/resend-verification',
        payload: { email: 'nonexistent@streamlite.dev' },
      });

      assert.strictEqual(res.statusCode, 202);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.message, GENERIC_VERIFICATION_SENT_MESSAGE);
    });
  });

  describe('Forgot & Reset Password Flow', () => {
    it('should request reset, update password, revoke sessions, and send alert', async () => {
      const email = `reset.${randomUUID()}@streamlite.dev`;
      const { userId } = await registerUser(email);
      const fastify = app.getHttpAdapter().getInstance();

      // Seed an active refresh token to verify session revocation
      await db
        .insertInto('refresh_tokens')
        .values({
          user_id: userId,
          family_id: randomUUID(),
          token_hash: Buffer.from('dummy_refresh_hash'),
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          revoked_at: null,
        })
        .execute();

      // 1. Request password reset
      const forgotRes = await fastify.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });

      assert.strictEqual(forgotRes.statusCode, 202);
      const forgotBody = JSON.parse(forgotRes.payload);
      assert.strictEqual(forgotBody.message, GENERIC_RESET_SENT_MESSAGE);

      // Retrieve reset token from outbox
      const resetOutbox = await db
        .selectFrom('outbox')
        .selectAll()
        .where('key', '=', userId)
        .where('topic', '=', 'auth.email.reset_password')
        .executeTakeFirstOrThrow();

      const resetToken = (resetOutbox.payload as { token: string }).token;
      assert.ok(resetToken);

      // 2. Complete password reset
      const newPassword = 'BrandNewSecurePassword#2026';
      const resetRes = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: resetToken,
          newPassword,
        },
      });

      assert.strictEqual(resetRes.statusCode, 200);
      const resetBody = JSON.parse(resetRes.payload);
      assert.strictEqual(
        resetBody.message,
        'Password has been reset successfully. Please log in with your new password.',
      );

      // Verify user's new password in PostgreSQL
      const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
      const matchesNew = await hasher.verify(user.password_hash, newPassword);
      assert.strictEqual(matchesNew, true, 'New password must verify against stored hash');

      const matchesOld = await hasher.verify(user.password_hash, 'OriginalPassword#2026');
      assert.strictEqual(matchesOld, false, 'Old password must no longer match');

      // Verify active refresh token was revoked
      const sessions = await db
        .selectFrom('refresh_tokens')
        .selectAll()
        .where('user_id', '=', userId)
        .execute();

      assert.strictEqual(sessions.length, 1);
      assert.ok(sessions[0]?.revoked_at !== null, 'Active refresh tokens must be revoked on password reset');

      // Verify reset token cannot be reused
      const replayRes = await fastify.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          token: resetToken,
          newPassword: 'AnotherPassword#2026',
        },
      });
      assert.strictEqual(replayRes.statusCode, 400);

      // Verify password changed security alert outbox event
      const alertOutbox = await db
        .selectFrom('outbox')
        .selectAll()
        .where('key', '=', userId)
        .where('topic', '=', 'auth.email.password_changed')
        .executeTakeFirst();

      assert.ok(alertOutbox, 'Password changed security notification must be enqueued');
    });

    it('should implement anti-enumeration in forgot-password', async () => {
      const fastify = app.getHttpAdapter().getInstance();
      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'nonexistent@streamlite.dev' },
      });

      assert.strictEqual(res.statusCode, 202);
      const body = JSON.parse(res.payload);
      assert.strictEqual(body.message, GENERIC_RESET_SENT_MESSAGE);

      const outboxCount = await db
        .selectFrom('outbox')
        .select(db.fn.count('id').as('count'))
        .where('topic', '=', 'auth.email.reset_password')
        .executeTakeFirstOrThrow();

      assert.strictEqual(Number(outboxCount.count), 0, 'No outbox email should be queued for nonexistent user');
    });
  });

  describe('Mailpit SMTP Delivery Spike', () => {
    it('should deliver queued outbox emails to Mailpit over SMTP', async () => {
      const email = `mailpit.${randomUUID()}@streamlite.dev`;
      await registerUser(email);

      // Process pending emails from outbox
      const sentCount = await emailService.processOutboxBatch(db);
      assert.ok(sentCount >= 1, 'At least 1 email must be delivered to Mailpit');

      // Verify sent_at was populated
      const unsent = await db
        .selectFrom('outbox')
        .selectAll()
        .where('sent_at', 'is', null)
        .execute();

      assert.strictEqual(unsent.length, 0, 'All processed emails must have sent_at marked');
    });
  });
});
