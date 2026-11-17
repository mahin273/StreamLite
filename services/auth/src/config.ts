import { z } from 'zod';

export const AuthConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3001),
  dbUrl: z.string().default('postgres://auth:10273@localhost:5438/auth_db'),
  dbMaxConnections: z.coerce.number().int().positive().default(10),
  argon2MaxConcurrent: z.coerce.number().int().positive().default(4),
  uvThreadpoolSize: z.coerce.number().int().positive().default(8),
  smtpHost: z.string().default('localhost'),
  smtpPort: z.coerce.number().int().positive().default(1025),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  emailFrom: z.string().default('StreamLite <no-reply@streamlite.dev>'),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  jwtIssuer: z.string().default('streamlite-auth'),
  jwtAudience: z.string().default('streamlite-api'),
  jwtExpiresIn: z.string().default('10m'),
  keyEncryptionSecret: z
    .string()
    .min(16)
    .default('streamlite-signing-key-secret-32-chars-long!'),
  cookieSecret: z.string().default('streamlite-cookie-secret-min-32-chars-long!'),
  refreshExpiresInDays: z.coerce.number().int().positive().default(30),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const AUTH_CONFIG = 'AUTH_CONFIG';

export function loadAuthConfig(): AuthConfig {
  return AuthConfigSchema.parse({
    port: process.env['AUTH_PORT'] || process.env['PORT'],
    dbUrl: process.env['AUTH_DB_URL'],
    dbMaxConnections: process.env['AUTH_DB_MAX_CONNECTIONS'],
    argon2MaxConcurrent: process.env['ARGON2_MAX_CONCURRENT'],
    uvThreadpoolSize: process.env['UV_THREADPOOL_SIZE'],
    smtpHost: process.env['MAILPIT_SMTP_HOST'] || process.env['SMTP_HOST'],
    smtpPort: process.env['MAILPIT_SMTP_PORT'] || process.env['SMTP_PORT'],
    smtpUser: process.env['SMTP_USER'],
    smtpPass: process.env['SMTP_PASS'],
    emailFrom: process.env['EMAIL_FROM'],
    nodeEnv: process.env['NODE_ENV'],
    jwtIssuer: process.env['JWT_ISSUER'],
    jwtAudience: process.env['JWT_AUDIENCE'],
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'],
    keyEncryptionSecret: process.env['AUTH_KEY_ENCRYPTION_SECRET'],
    cookieSecret: process.env['COOKIE_SECRET'],
    refreshExpiresInDays: process.env['REFRESH_EXPIRES_IN_DAYS'],
  });
}
