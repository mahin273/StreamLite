import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ProblemDetailsFilter } from '@streamlite/http';
import { createAuthDatabase, type AuthDatabase } from '../store/database.js';
import { AuthModule } from '../auth.module.js';
import { Argon2Hasher } from '../security/argon2-hasher.js';
import { AsyncSemaphore } from '../security/semaphore.js';
import { isCommonPassword } from '../security/password-rules.js';
import { GENERIC_REGISTRATION_MESSAGE } from '../http/dto/register.dto.js';

describe('User Registration & Argon2id (Integration)', () => {
  let app: NestFastifyApplication;
  let db: AuthDatabase;

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
  });

  after(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(async () => {
    // Clean up test tables between test runs
    await db.deleteFrom('outbox').execute();
    await db.deleteFrom('email_tokens').execute();
    await db.deleteFrom('profiles').execute();
    await db.deleteFrom('users').execute();
  });

  describe('Security: Argon2Hasher & Semaphore', () => {
    it('should hash with Argon2id parameters and verify password correctly', async () => {
      const hasher = new Argon2Hasher({ memoryCost: 4096, timeCost: 1, parallelism: 1 });
      const password = 'SuperSecretPassword#2026';

      const hash = await hasher.hash(password);
      assert.ok(hash.startsWith('$argon2id$'), 'Must use Argon2id variant');

      const isValid = await hasher.verify(hash, password);
      assert.strictEqual(isValid, true, 'Valid password must verify');

      const isInvalid = await hasher.verify(hash, 'WrongPassword#123');
      assert.strictEqual(isInvalid, false, 'Invalid password must reject');
    });

    it('should throttle concurrent operations using AsyncSemaphore', async () => {
      const semaphore = new AsyncSemaphore(2);
      let concurrentActive = 0;
      let maxObservedConcurrent = 0;

      const worker = async () => {
        await semaphore.run(async () => {
          concurrentActive++;
          if (concurrentActive > maxObservedConcurrent) {
            maxObservedConcurrent = concurrentActive;
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
          concurrentActive--;
        });
      };

      await Promise.all([worker(), worker(), worker(), worker(), worker()]);

      assert.strictEqual(
        maxObservedConcurrent,
        2,
        'Semaphore must restrict concurrent operations to maxPermits',
      );
    });

    it('should identify common passwords from the blocklist', () => {
      assert.strictEqual(isCommonPassword('password123'), true);
      assert.strictEqual(isCommonPassword('PASSWORD1234'), true);
      assert.strictEqual(isCommonPassword('1234567890'), true);
      assert.strictEqual(isCommonPassword('streamlite123'), true);
      assert.strictEqual(isCommonPassword('ComplexAndUniquePassphrase#99'), false);
    });
  });

  describe('HTTP: POST /auth/register', () => {
    it('should successfully register a new user with default profile, token, and outbox event', async () => {
      const payload = {
        email: `alice.${randomUUID()}@streamlite.dev`,
        password: 'Correct-Horse-Battery-Staple#2026',
        displayName: 'Alice In Wonderland',
      };

      const fastify = app.getHttpAdapter().getInstance();
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload,
      });

      assert.strictEqual(response.statusCode, 202);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.message, GENERIC_REGISTRATION_MESSAGE);

      // Verify user in PostgreSQL
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('email', '=', payload.email)
        .executeTakeFirst();

      assert.ok(user, 'User record must exist in users table');
      assert.strictEqual(user.status, 'pending_verification');
      assert.strictEqual(user.role, 'viewer');
      assert.ok(user.password_hash.startsWith('$argon2id$'));

      // Verify default profile created
      const profile = await db
        .selectFrom('profiles')
        .selectAll()
        .where('user_id', '=', user.id)
        .executeTakeFirst();

      assert.ok(profile, 'Default profile must be created');
      assert.strictEqual(profile.name, payload.displayName);
      assert.strictEqual(profile.is_kids, false);
      assert.strictEqual(profile.age_limit, 18);

      // Verify email verification token created
      const tokenRow = await db
        .selectFrom('email_tokens')
        .selectAll()
        .where('user_id', '=', user.id)
        .executeTakeFirst();

      assert.ok(tokenRow, 'Email verification token must exist');
      assert.strictEqual(tokenRow.kind, 'verify_email');
      assert.ok(Buffer.isBuffer(tokenRow.token_hash));
      assert.ok(tokenRow.expires_at > new Date());

      // Verify outbox entry created
      const outboxRow = await db
        .selectFrom('outbox')
        .selectAll()
        .where('key', '=', user.id)
        .executeTakeFirst();

      assert.ok(outboxRow, 'Outbox row must be enqueued');
      assert.strictEqual(outboxRow.topic, 'auth.user.registered');
      assert.strictEqual(outboxRow.sent_at, null);
      const outboxPayload = outboxRow.payload as { userId: string; email: string; token: string };
      assert.strictEqual(outboxPayload.userId, user.id);
      assert.strictEqual(outboxPayload.email, user.email);
      assert.ok(typeof outboxPayload.token === 'string' && outboxPayload.token.length === 64);
    });

    it('should implement anti-enumeration: return HTTP 202 without revealing duplicate email', async () => {
      const email = `bob.${randomUUID()}@streamlite.dev`;
      const payload = {
        email,
        password: 'ValidPassword#12345678',
        displayName: 'Bob The Builder',
      };

      const fastify = app.getHttpAdapter().getInstance();

      // First registration
      const res1 = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload,
      });
      assert.strictEqual(res1.statusCode, 202);

      // Second registration with same email (mixed case)
      const res2 = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          ...payload,
          email: email.toUpperCase(),
        },
      });

      // Must return identical status and body
      assert.strictEqual(res2.statusCode, 202);
      assert.strictEqual(
        JSON.parse(res2.payload).message,
        JSON.parse(res1.payload).message,
      );

      // Database must have only 1 user with this email
      const users = await db
        .selectFrom('users')
        .selectAll()
        .where('email', '=', email)
        .execute();

      assert.strictEqual(users.length, 1, 'Duplicate user must not be created');
    });

    it('should reject passwords shorter than 10 characters with RFC 7807 problem details', async () => {
      const fastify = app.getHttpAdapter().getInstance();
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'shortpass@streamlite.dev',
          password: 'short',
          displayName: 'Shorty',
        },
      });

      assert.strictEqual(response.statusCode, 400);
      assert.strictEqual(response.headers['content-type'], 'application/problem+json; charset=utf-8');

      const body = JSON.parse(response.payload);
      assert.strictEqual(body.status, 400);
      assert.strictEqual(body.title, 'Validation Failed');
      assert.ok(Array.isArray(body.errors));
      assert.ok(body.errors.some((e: { field: string }) => e.field === 'password'));
    });

    it('should reject common passwords with RFC 7807 problem details', async () => {
      const fastify = app.getHttpAdapter().getInstance();
      const response = await fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'commonpass@streamlite.dev',
          password: 'password123',
          displayName: 'Common Person',
        },
      });

      assert.strictEqual(response.statusCode, 400);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.status, 400);
      assert.ok(
        body.errors.some(
          (e: { field: string; message: string }) =>
            e.field === 'password' && e.message.includes('too common'),
        ),
      );
    });
  });
});
