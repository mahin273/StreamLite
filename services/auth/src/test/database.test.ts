import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthDatabase, type AuthDatabase } from '../store/database.js';

describe('Auth Database & Migrations (Integration)', () => {
  let db: AuthDatabase;

  before(async () => {
    const instance = createAuthDatabase({
      connectionString:
        process.env['AUTH_DB_URL'] || 'postgres://auth:10273@localhost:5438/auth_db',
      maxConnections: 5,
    });
    db = instance.db;
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Clean up test tables between runs
    await db.deleteFrom('audit_log').execute();
    await db.deleteFrom('refresh_tokens').execute();
    await db.deleteFrom('profiles').execute();
    await db.deleteFrom('users').execute();
  });

  it('should enforce case-insensitive email uniqueness via citext', async () => {
    const emailUpper = `User.${randomUUID()}@StreamLite.DEV`;
    const emailLower = emailUpper.toLowerCase();

    // Insert user with mixed/uppercase email
    const inserted = await db
      .insertInto('users')
      .values({
        email: emailUpper,
        password_hash: '$argon2id$test_hash',
        role: 'viewer',
        status: 'active',
      })
      .returning(['id', 'email', 'role', 'status'])
      .executeTakeFirstOrThrow();

    assert.ok(inserted.id);
    assert.strictEqual(inserted.email, emailUpper);

    // Query using all-lowercase email
    const found = await db
      .selectFrom('users')
      .select(['id', 'email', 'role'])
      .where('email', '=', emailLower)
      .executeTakeFirst();

    assert.ok(found, 'citext must find the user when queried with lowercase email');
    assert.strictEqual(found.id, inserted.id);

    // Attempt to insert duplicate with different case -> must reject
    await assert.rejects(
      async () => {
        await db
          .insertInto('users')
          .values({
            email: emailLower,
            password_hash: '$argon2id$duplicate_hash',
            role: 'viewer',
            status: 'active',
          })
          .execute();
      },
      (err: unknown) => {
        // Postgres unique violation code is 23505
        return (err as { code?: string }).code === '23505';
      },
      'citext must enforce uniqueness regardless of case',
    );
  });

  it('should cascade delete profiles when the parent user is deleted', async () => {
    const user = await db
      .insertInto('users')
      .values({
        email: `profile-test-${randomUUID()}@streamlite.dev`,
        password_hash: '$argon2id$test_hash',
        role: 'viewer',
        status: 'active',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const profile = await db
      .insertInto('profiles')
      .values({
        user_id: user.id,
        name: 'Main Profile',
        is_kids: false,
        age_limit: 18,
      })
      .returning(['id', 'user_id', 'name'])
      .executeTakeFirstOrThrow();

    assert.strictEqual(profile.user_id, user.id);

    // Delete user
    await db.deleteFrom('users').where('id', '=', user.id).execute();

    // Verify profile was automatically cascade-deleted
    const profileLookup = await db
      .selectFrom('profiles')
      .selectAll()
      .where('id', '=', profile.id)
      .executeTakeFirst();

    assert.strictEqual(profileLookup, undefined, 'Profile must be cascade-deleted');
  });

  it('should parse BIGSERIAL / int8 (OID 20) as JavaScript Number in audit_log', async () => {
    const insertedLog = await db
      .insertInto('audit_log')
      .values({
        action: 'user.login.success',
        ip: '192.168.1.100',
        user_agent: 'StreamLite-Client/1.0',
        meta: JSON.stringify({ provider: 'password', mfa: false }),
      })
      .returning(['id', 'action', 'ip', 'at'])
      .executeTakeFirstOrThrow();

    assert.strictEqual(typeof insertedLog.id, 'number', 'OID 20 parser must convert int8 to number');
    assert.strictEqual(insertedLog.action, 'user.login.success');
    assert.strictEqual(insertedLog.ip, '192.168.1.100');
  });

  it('should store and query binary SHA-256 token hashes via bytea', async () => {
    const user = await db
      .insertInto('users')
      .values({
        email: `token-test-${randomUUID()}@streamlite.dev`,
        password_hash: '$argon2id$test_hash',
        role: 'viewer',
        status: 'active',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const rawToken = randomUUID();
    const tokenHash = createHash('sha256').update(rawToken).digest();
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db
      .insertInto('refresh_tokens')
      .values({
        user_id: user.id,
        family_id: familyId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        ip: '127.0.0.1',
        user_agent: 'Mozilla/5.0',
      })
      .execute();

    // Query token by its binary hash
    const foundToken = await db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    assert.ok(foundToken, 'Must find token by binary SHA-256 hash');
    assert.strictEqual(foundToken.user_id, user.id);
    assert.strictEqual(foundToken.family_id, familyId);
    assert.ok(Buffer.isBuffer(foundToken.token_hash));
    assert.strictEqual(foundToken.token_hash.toString('hex'), tokenHash.toString('hex'));
  });
});
