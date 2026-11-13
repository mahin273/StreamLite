import pg from 'pg';
const { types, Pool } = pg;
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

// Parse PostgreSQL int8 (bigint / bigserial, OID 20) as JavaScript Number (Design_Doc.md Section 6.1)
types.setTypeParser(20, (val: string) => Number(val));

export type AuthDatabase = Kysely<DB>;

export interface DatabaseConfig {
  connectionString?: string | undefined;
  maxConnections?: number | undefined;
}

export function createAuthDatabase(config?: DatabaseConfig): {
  db: AuthDatabase;
  pool: pg.Pool;
} {
  const connectionString =
    config?.connectionString ||
    process.env['AUTH_DB_URL'] ||
    'postgres://auth:10273@localhost:5438/auth_db';

  const pool = new Pool({
    connectionString,
    max: config?.maxConnections ?? 10,
  });

  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DB>({ dialect });

  return { db, pool };
}
