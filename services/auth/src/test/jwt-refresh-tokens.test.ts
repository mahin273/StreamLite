import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { ProblemDetailsFilter } from '@streamlite/http';
import { createAuthDatabase, type AuthDatabase } from '../store/database.js';
import { AuthModule } from '../auth.module.js';
import { TokenKeyManager } from '../security/token-key-manager.js';
import { JwtService } from '../security/jwt.service.js';
import { UserRepository } from '../store/user.repository.js';
import { Argon2Hasher } from '../security/argon2-hasher.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';

function extractCookie(
  headers: OutgoingHttpHeaders,
  name: string,
): string {
  const setCookie = headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of cookies) {
    if (typeof c === 'string' && c.startsWith(`${name}=`)) {
      const match = c.match(new RegExp(`^${name}=([^;]+)`));
      if (match) return match[1]!;
    }
  }
  throw new Error(`Cookie ${name} not found in response headers`);
}

function getCookieAttributes(
  headers: OutgoingHttpHeaders,
  name: string,
): string {
  const setCookie = headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of cookies) {
    if (typeof c === 'string' && c.startsWith(`${name}=`)) {
      return c;
    }
  }
  throw new Error(`Cookie ${name} not found in response headers`);
}

describe('Two-Tier JWTs, JWKS & Refresh Token Rotation (Integration)', () => {
  let app: NestFastifyApplication;
  let db: AuthDatabase;
  let keyManager: TokenKeyManager;
  let jwtService: JwtService;
  let userRepo: UserRepository;
  let hasher: Argon2Hasher;
  let rateLimiter: RateLimiterService;

  before(async () => {
    const dbInstance = createAuthDatabase({
      connectionString:
        process.env['AUTH_DB_URL'] || 'postgres://auth:10273@localhost:5438/auth_db',
      maxConnections: 5,
    });
    db = dbInstance.db;

    const adapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(
      AuthModule.register({
        connectionString:
          process.env['AUTH_DB_URL'] || 'postgres://auth:10273@localhost:5438/auth_db',
        maxConnections: 5,
      }),
      adapter,
      { logger: false },
    );

    // Register Fastify cookie plugin
    await app.register(fastifyCookie as never);
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    keyManager = app.get(TokenKeyManager);
    jwtService = app.get(JwtService);
    userRepo = app.get(UserRepository);
    hasher = app.get(Argon2Hasher);
    rateLimiter = app.get(RateLimiterService);
  });

  after(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(async () => {
    // Clean up test tables between test runs
    await rateLimiter.resetAll();
    await db.deleteFrom('refresh_tokens').execute();
    await db.deleteFrom('outbox').execute();
    await db.deleteFrom('email_tokens').execute();
    await db.deleteFrom('profiles').execute();
    await db.deleteFrom('users').execute();
  });

  describe('RFC 7517 JWKS Endpoint & Ed25519 Key Management', () => {
    it('should export valid Ed25519 public keys via GET /.well-known/jwks.json', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/jwks.json',
      });

      assert.strictEqual(res.statusCode, 200);
      const jwks = res.json();
      assert.ok(Array.isArray(jwks.keys), 'JWKS must contain keys array');
      assert.ok(jwks.keys.length >= 1, 'Must have at least one active key');

      const primaryKey = jwks.keys[0];
      assert.strictEqual(primaryKey.kty, 'OKP', 'Must use Octet Key Pair (OKP) format');
      assert.strictEqual(primaryKey.crv, 'Ed25519', 'Must use Curve25519');
      assert.strictEqual(primaryKey.alg, 'EdDSA', 'Must specify EdDSA algorithm');
      assert.strictEqual(primaryKey.use, 'sig', 'Must specify sig use');
      assert.ok(typeof primaryKey.kid === 'string' && primaryKey.kid.length > 0, 'Must have kid');
      assert.ok(typeof primaryKey.x === 'string' && primaryKey.x.length > 0, 'Must have public x coordinate');
    });

    it('should issue and verify two-tier Ed25519 JWTs with kid header', async () => {
      const accountToken = await jwtService.issueAccountToken({
        userId: '11111111-1111-1111-1111-111111111111',
        role: 'viewer',
        emailVerified: true,
        sessionId: 'session-abc-123',
      });

      assert.ok(accountToken.token.length > 50);
      assert.strictEqual(accountToken.expiresIn, 600);

      // Verify token payload
      const verified = await jwtService.verifyToken(accountToken.token);
      assert.strictEqual(verified.sub, '11111111-1111-1111-1111-111111111111');
      assert.strictEqual(verified.role, 'viewer');
      assert.strictEqual(verified.email_verified, true);
      assert.strictEqual(verified.sid, 'session-abc-123');

      // Issue profile token
      const profileToken = await jwtService.issueProfileToken({
        userId: '11111111-1111-1111-1111-111111111111',
        role: 'viewer',
        emailVerified: true,
        sessionId: 'session-abc-123',
        profileId: '22222222-2222-2222-2222-222222222222',
        ageLimit: 16,
      });

      const verifiedProfile = await jwtService.verifyToken(profileToken.token);
      assert.strictEqual(verifiedProfile.pid, '22222222-2222-2222-2222-222222222222');
      assert.strictEqual(verifiedProfile.age, 16);
    });

    it('should rotate signing key and export multiple active public keys in JWKS', async () => {
      const newKey = await keyManager.rotateSigningKey();
      assert.ok(newKey.kid.startsWith('k_'));

      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/jwks.json',
      });
      assert.strictEqual(res.statusCode, 200);
      const jwks = res.json();
      assert.ok(jwks.keys.length >= 2, 'JWKS should contain rotated keys');
      const found = (jwks.keys as Array<{ kid: string }>).find((k) => k.kid === newKey.kid);
      assert.ok(found, 'Rotated key must be present in JWKS');
    });
  });

  describe('Login & Token Issuance (POST /auth/login)', () => {
    it('should authenticate user and return access token + HttpOnly SameSite=Strict cookie', async () => {
      const email = 'alice.login@streamlite.dev';
      const password = 'StrongPassword#2026';
      const passwordHash = await hasher.hash(password);

      // Seed user
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

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email,
          password,
        },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.accessToken, 'Must return accessToken');
      assert.strictEqual(body.expiresIn, 600);
      assert.strictEqual(body.user.id, user.id);
      assert.strictEqual(body.user.email, email);
      assert.strictEqual(body.user.role, 'viewer');

      // Verify Set-Cookie header attributes
      const cookieStr = getCookieAttributes(res.headers, 'refreshToken');
      assert.ok(cookieStr.includes('HttpOnly'), 'Cookie must be HttpOnly');
      assert.ok(cookieStr.toLowerCase().includes('samesite=strict'), 'Cookie must be SameSite=Strict');
      assert.ok(cookieStr.includes('Path=/api/v1/auth'), 'Cookie must be scoped to Path=/api/v1/auth');

      // Verify token in DB
      const rawRefreshToken = extractCookie(res.headers, 'refreshToken');
      const tokenHash = createHash('sha256').update(rawRefreshToken).digest();
      const dbToken = await userRepo.findRefreshTokenByHash(tokenHash);

      assert.ok(dbToken, 'Refresh token must be stored in DB');
      assert.strictEqual(dbToken.user_id, user.id);
      assert.strictEqual(dbToken.revoked_at, null);
      assert.ok(dbToken.family_id, 'Must have a family_id');

      // Verify the returned accessToken cryptographically
      const verified = await jwtService.verifyToken(body.accessToken);
      assert.strictEqual(verified.sub, user.id);
      assert.strictEqual(verified.email_verified, true);
      assert.strictEqual(verified.sid, dbToken.family_id);
    });

    it('should reject invalid password with 401 Unauthorized', async () => {
      const email = 'bob.invalid@streamlite.dev';
      const passwordHash = await hasher.hash('CorrectPassword#2026');

      await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'viewer',
          status: 'active',
        })
        .execute();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email,
          password: 'WrongPassword#123',
        },
      });

      assert.strictEqual(res.statusCode, 401);
      const body = res.json();
      assert.strictEqual(body.code, 'UNAUTHORIZED');
      assert.strictEqual(body.detail, 'Invalid email or password');
    });

    it('should reject non-existent email with 401 Unauthorized (anti-enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'nonexistent@streamlite.dev',
          password: 'SomePassword#123',
        },
      });

      assert.strictEqual(res.statusCode, 401);
      const body = res.json();
      assert.strictEqual(body.code, 'UNAUTHORIZED');
      assert.strictEqual(body.detail, 'Invalid email or password');
    });
  });

  describe('Sliding-Window Refresh Token Rotation (POST /auth/refresh)', () => {
    it('should rotate refresh token in same family and return new access token', async () => {
      const email = 'carol.refresh@streamlite.dev';
      const password = 'Password#12345';
      const passwordHash = await hasher.hash(password);

      await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'creator',
          status: 'active',
          email_verified_at: new Date(),
        })
        .execute();

      // 1. Initial Login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      assert.strictEqual(loginRes.statusCode, 200);
      const token1 = extractCookie(loginRes.headers, 'refreshToken');

      // 2. Perform Refresh
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: {
          cookie: `refreshToken=${token1}`,
        },
      });

      assert.strictEqual(refreshRes.statusCode, 200);
      const refreshBody = refreshRes.json();
      assert.ok(refreshBody.accessToken, 'Must return new access token');
      assert.strictEqual(refreshBody.expiresIn, 600);

      const token2 = extractCookie(refreshRes.headers, 'refreshToken');
      assert.notStrictEqual(token1, token2, 'Must issue a rotated, distinct refresh token');

      // Verify token1 is revoked and replaced_by points to token2
      const hash1 = createHash('sha256').update(token1).digest();
      const hash2 = createHash('sha256').update(token2).digest();

      const dbToken1 = await userRepo.findRefreshTokenByHash(hash1);
      const dbToken2 = await userRepo.findRefreshTokenByHash(hash2);

      assert.ok(dbToken1?.revoked_at !== null, 'Token 1 must be marked revoked');
      assert.strictEqual(dbToken1?.replaced_by, dbToken2?.id, 'Token 1 replaced_by must point to Token 2');
      assert.strictEqual(dbToken2?.revoked_at, null, 'Token 2 must be active');
      assert.strictEqual(dbToken1?.family_id, dbToken2?.family_id, 'Both tokens must share the exact same family_id');
    });

    it('should detect token reuse and immediately revoke all tokens in the family', async () => {
      const email = 'dave.stolen@streamlite.dev';
      const password = 'Password#54321';
      const passwordHash = await hasher.hash(password);

      await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'viewer',
          status: 'active',
        })
        .execute();

      // 1. Login -> gets token1
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      const token1 = extractCookie(loginRes.headers, 'refreshToken');

      // 2. Legitimate Refresh -> token1 is replaced by token2
      const refreshRes1 = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie: `refreshToken=${token1}` },
      });
      assert.strictEqual(refreshRes1.statusCode, 200);
      const token2 = extractCookie(refreshRes1.headers, 'refreshToken');

      // 3. Attack Simulation: Attacker tries to replay token1
      const replayRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie: `refreshToken=${token1}` },
      });

      assert.strictEqual(replayRes.statusCode, 401);
      const replayBody = replayRes.json();
      assert.strictEqual(replayBody.code, 'UNAUTHORIZED');
      assert.ok(replayBody.detail.includes('Token reuse detected'), 'Must state token reuse detected');

      // 4. Verify all tokens in the family are now revoked!
      const hash2 = createHash('sha256').update(token2).digest();
      const dbToken2 = await userRepo.findRefreshTokenByHash(hash2);
      assert.ok(dbToken2?.revoked_at !== null, 'Token 2 must have been revoked as part of family breach');

      // 5. Legitimate user trying to refresh with token2 also fails now
      const legitimateSubsequentRefresh = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie: `refreshToken=${token2}` },
      });

      assert.strictEqual(legitimateSubsequentRefresh.statusCode, 401);
    });

    it('should reject refresh when cookie is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
      });

      assert.strictEqual(res.statusCode, 401);
      const body = res.json();
      assert.strictEqual(body.detail, 'Refresh token is missing');
    });
  });

  describe('Logout & Session Invalidation', () => {
    it('should revoke session refresh token on POST /auth/logout', async () => {
      const email = 'eve.logout@streamlite.dev';
      const password = 'Password#99999';
      const passwordHash = await hasher.hash(password);

      await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'viewer',
          status: 'active',
        })
        .execute();

      // Login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      const token = extractCookie(loginRes.headers, 'refreshToken');

      // Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: `refreshToken=${token}` },
      });

      assert.strictEqual(logoutRes.statusCode, 200);

      // Verify token in DB is revoked
      const tokenHash = createHash('sha256').update(token).digest();
      const dbToken = await userRepo.findRefreshTokenByHash(tokenHash);
      assert.ok(dbToken?.revoked_at !== null, 'Token must be marked revoked');

      // Trying to refresh with logged-out token must fail
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie: `refreshToken=${token}` },
      });
      assert.strictEqual(refreshRes.statusCode, 401);
    });

    it('should revoke all user sessions on POST /auth/logout-all', async () => {
      const email = 'frank.logoutall@streamlite.dev';
      const password = 'Password#88888';
      const passwordHash = await hasher.hash(password);

      await db
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: 'viewer',
          status: 'active',
        })
        .execute();

      // Login Session 1 (Device A)
      const loginRes1 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      const token1 = extractCookie(loginRes1.headers, 'refreshToken');
      const accessToken = loginRes1.json().accessToken;

      // Login Session 2 (Device B)
      const loginRes2 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      const token2 = extractCookie(loginRes2.headers, 'refreshToken');

      // Call logout-all using Bearer JWT
      const logoutAllRes = await app.inject({
        method: 'POST',
        url: '/auth/logout-all',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      assert.strictEqual(logoutAllRes.statusCode, 200);

      // Verify both sessions are revoked
      const hash1 = createHash('sha256').update(token1).digest();
      const hash2 = createHash('sha256').update(token2).digest();

      const dbToken1 = await userRepo.findRefreshTokenByHash(hash1);
      const dbToken2 = await userRepo.findRefreshTokenByHash(hash2);

      assert.ok(dbToken1?.revoked_at !== null, 'Device A session must be revoked');
      assert.ok(dbToken2?.revoked_at !== null, 'Device B session must be revoked');
    });
  });
});
