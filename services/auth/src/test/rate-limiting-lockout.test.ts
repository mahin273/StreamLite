import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { ProblemDetailsFilter } from '@streamlite/http';
import { createAuthDatabase, type AuthDatabase } from '../store/database.js';
import { AuthModule } from '../auth.module.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';
import { UserRepository } from '../store/user.repository.js';
import { Argon2Hasher } from '../security/argon2-hasher.js';

describe('Rate Limiting & Account Lockout (Integration)', () => {
  let app: NestFastifyApplication;
  let db: AuthDatabase;
  let rateLimiter: RateLimiterService;
  let userRepo: UserRepository;
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
      new FastifyAdapter({ trustProxy: true }),
      { logger: false },
    );

    await app.register(fastifyCookie as never);
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    rateLimiter = app.get(RateLimiterService);
    userRepo = app.get(UserRepository);
    hasher = app.get(Argon2Hasher);
  });

  after(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(async () => {
    await rateLimiter.resetAll();
    await db.deleteFrom('refresh_tokens').execute();
    await db.deleteFrom('outbox').execute();
    await db.deleteFrom('email_tokens').execute();
    await db.deleteFrom('profiles').execute();
    await db.deleteFrom('users').execute();
  });

  describe('Redis Distributed Rate Limiting', () => {
    it('should throttle login attempts after 5 failures per (email + IP) with HTTP 429 and Retry-After', async () => {
      const email = 'target.user@streamlite.dev';
      const ip = '198.51.100.1';

      // 1. Send 5 failed login attempts
      for (let i = 1; i <= 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: 'WrongPassword#1' },
          headers: {
            'x-forwarded-for': ip,
          },
        });
        assert.strictEqual(res.statusCode, 401, `Attempt ${i} should fail with 401`);
      }

      // 2. The 6th attempt must trigger rate limiting (HTTP 429)
      const blockedRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'WrongPassword#1' },
        headers: {
          'x-forwarded-for': ip,
        },
      });

      assert.strictEqual(blockedRes.statusCode, 429);
      const body = blockedRes.json();
      assert.strictEqual(body.code, 'TOO_MANY_REQUESTS');
      assert.ok(body.detail.includes('Too many login attempts'));
      assert.ok(blockedRes.headers['retry-after'], 'Must contain Retry-After header');

      // 3. A different IP attempting to login with the same email is NOT blocked (lockout griefing defense)
      const differentIpRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'WrongPassword#1' },
        headers: {
          'x-forwarded-for': '198.51.100.99',
        },
      });
      assert.strictEqual(differentIpRes.statusCode, 401, 'Different IP should receive 401, not 429');
    });

    it('should throttle registration attempts after 5 requests per IP with HTTP 429', async () => {
      const ip = '203.0.113.42';

      // 1. Send 5 registration requests
      for (let i = 1; i <= 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            email: `newuser${i}@streamlite.dev`,
            password: 'StrongPassword#2026',
            displayName: `User ${i}`,
          },
          headers: {
            'x-forwarded-for': ip,
          },
        });
        assert.strictEqual(res.statusCode, 202);
      }

      // 2. The 6th registration from the same IP must be throttled
      const throttledRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'blocked.user@streamlite.dev',
          password: 'StrongPassword#2026',
          displayName: 'Blocked User',
        },
        headers: {
          'x-forwarded-for': ip,
        },
      });

      assert.strictEqual(throttledRes.statusCode, 429);
      const body = throttledRes.json();
      assert.strictEqual(body.code, 'TOO_MANY_REQUESTS');
      assert.ok(body.detail.includes('Too many registration attempts'));
      assert.ok(throttledRes.headers['retry-after']);
    });

    it('should throttle forgot password requests after 3 requests per email with HTTP 429', async () => {
      const email = 'spammed.victim@streamlite.dev';

      // 1. Send 3 forgot password requests
      for (let i = 1; i <= 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/forgot-password',
          payload: { email },
        });
        assert.strictEqual(res.statusCode, 202);
      }

      // 2. The 4th request must be throttled
      const throttledRes = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });

      assert.strictEqual(throttledRes.statusCode, 429);
      const body = throttledRes.json();
      assert.strictEqual(body.code, 'TOO_MANY_REQUESTS');
      assert.ok(body.detail.includes('Too many password reset requests'));
      assert.ok(throttledRes.headers['retry-after']);
    });
  });

  describe('PostgreSQL Exponential Account Lockout', () => {
    it('should lock user account after 5 consecutive failed logins with exponential delay', async () => {
      const email = 'lockout.target@streamlite.dev';
      const validPassword = 'CorrectPassword#2026';
      const passwordHash = await hasher.hash(validPassword);

      // Seed active user
      const user = await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'viewer',
          status: 'active',
          email_verified_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 1. Simulate 5 failed logins across different IPs to avoid hitting IP rate limits
      for (let i = 1; i <= 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: 'WrongPassword#999' },
          headers: {
            'x-forwarded-for': `10.0.0.${i}`,
          },
        });
        assert.strictEqual(res.statusCode, 401);
      }

      // 2. Verify user in database is now locked with locked_until set
      const lockedUser = await userRepo.findById(user.id);
      assert.strictEqual(lockedUser?.status, 'locked');
      assert.strictEqual(lockedUser?.failed_logins, 5);
      assert.ok(lockedUser?.locked_until !== null, 'locked_until must be set');

      const lockDurationMs = new Date(lockedUser.locked_until).getTime() - Date.now();
      assert.ok(
        lockDurationMs > 13 * 60 * 1000 && lockDurationMs <= 15 * 60 * 1000,
        `Expected ~15 minutes lock delay, got ${lockDurationMs} ms`,
      );

      // 3. Attempting to login with CORRECT password while locked must fail with 401 and generic message
      const attemptWhileLocked = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: validPassword },
        headers: {
          'x-forwarded-for': '10.0.0.254',
        },
      });

      assert.strictEqual(attemptWhileLocked.statusCode, 401);
      const lockedBody = attemptWhileLocked.json();
      assert.ok(lockedBody.detail.includes('Account is temporarily locked'));

      // 4. Manually advance locked_until to the past (simulating lock expiration)
      await db
        .updateTable('users')
        .set({
          locked_until: new Date(Date.now() - 1000),
        })
        .where('id', '=', user.id)
        .execute();

      // 5. Successful login after lock expires unlocks account and resets counters
      const successfulLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: validPassword },
        headers: {
          'x-forwarded-for': '10.0.0.254',
        },
      });

      assert.strictEqual(successfulLogin.statusCode, 200);
      const unlockedUser = await userRepo.findById(user.id);
      assert.strictEqual(unlockedUser?.status, 'active');
      assert.strictEqual(unlockedUser?.failed_logins, 0);
      assert.strictEqual(unlockedUser?.locked_until, null);
    });

    it('should exponentially increase lockout duration on repeated lockouts', async () => {
      const email = 'exponential.target@streamlite.dev';
      const passwordHash = await hasher.hash('SomeSecretPassword#1');

      const user = await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'viewer',
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 5 failures: 15 minutes
      const res5 = await userRepo.recordFailedLogin(user.id, 5);
      assert.strictEqual(res5.failedLogins, 1); // 1st failure

      // Manually set failed_logins = 4, then record 5th
      await db.updateTable('users').set({ failed_logins: 4 }).where('id', '=', user.id).execute();
      const res5th = await userRepo.recordFailedLogin(user.id, 5);
      assert.strictEqual(res5th.failedLogins, 5);
      assert.strictEqual(res5th.isLocked, true);
      const delay5th = new Date(res5th.lockedUntil!).getTime() - Date.now();
      assert.ok(delay5th > 13 * 60 * 1000 && delay5th <= 15 * 60 * 1000, '5 failures -> 15 min');

      // 6th failure: 30 minutes
      const res6th = await userRepo.recordFailedLogin(user.id, 5);
      assert.strictEqual(res6th.failedLogins, 6);
      const delay6th = new Date(res6th.lockedUntil!).getTime() - Date.now();
      assert.ok(delay6th > 28 * 60 * 1000 && delay6th <= 30 * 60 * 1000, '6 failures -> 30 min');

      // 7th failure: 60 minutes
      const res7th = await userRepo.recordFailedLogin(user.id, 5);
      assert.strictEqual(res7th.failedLogins, 7);
      const delay7th = new Date(res7th.lockedUntil!).getTime() - Date.now();
      assert.ok(delay7th > 58 * 60 * 1000 && delay7th <= 60 * 60 * 1000, '7 failures -> 60 min');

      // 8th failure: 120 minutes (capped)
      const res8th = await userRepo.recordFailedLogin(user.id, 5);
      assert.strictEqual(res8th.failedLogins, 8);
      const delay8th = new Date(res8th.lockedUntil!).getTime() - Date.now();
      assert.ok(delay8th > 115 * 60 * 1000 && delay8th <= 120 * 60 * 1000, '8+ failures -> 120 min');
    });
  });
});
