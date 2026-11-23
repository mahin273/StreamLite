import { type DynamicModule, Module } from '@nestjs/common';
import { createAuthDatabase, type DatabaseConfig, AUTH_DB } from './store/database.js';
import { AUTH_DATABASE, UserRepository } from './store/user.repository.js';
import { Argon2Hasher } from './security/argon2-hasher.js';
import { TokenKeyManager } from './security/token-key-manager.js';
import { JwtService } from './security/jwt.service.js';
import { RateLimiterService } from './security/rate-limiter.service.js';
import { AuthService } from './domain/auth.service.js';
import { AuthController } from './http/auth.controller.js';
import { JwksController } from './http/jwks.controller.js';
import { EmailService } from './email/email.service.js';
import { loadAuthConfig, type AuthConfig, AUTH_CONFIG } from './config.js';

export { AUTH_CONFIG };

export interface AuthModuleOptions extends DatabaseConfig {
  authConfig?: AuthConfig;
}

@Module({
  controllers: [AuthController, JwksController],
  providers: [
    {
      provide: AUTH_DATABASE,
      useFactory: () => {
        const { db } = createAuthDatabase();
        return db;
      },
    },
    {
      provide: AUTH_DB,
      useExisting: AUTH_DATABASE,
    },
    {
      provide: AUTH_CONFIG,
      useFactory: () => loadAuthConfig(),
    },
    UserRepository,
    Argon2Hasher,
    EmailService,
    TokenKeyManager,
    JwtService,
    RateLimiterService,
    AuthService,
  ],
  exports: [
    AUTH_DATABASE,
    AUTH_DB,
    AUTH_CONFIG,
    UserRepository,
    Argon2Hasher,
    EmailService,
    TokenKeyManager,
    JwtService,
    RateLimiterService,
    AuthService,
  ],
})
export class AuthModule {
  static register(options?: AuthModuleOptions): DynamicModule {
    const { db, pool } = createAuthDatabase(options);
    const authConfig = options?.authConfig ?? loadAuthConfig();

    return {
      module: AuthModule,
      controllers: [AuthController, JwksController],
      providers: [
        {
          provide: AUTH_DATABASE,
          useValue: db,
        },
        {
          provide: AUTH_DB,
          useValue: db,
        },
        {
          provide: 'AUTH_POOL',
          useValue: pool,
        },
        {
          provide: AUTH_CONFIG,
          useValue: authConfig,
        },
        UserRepository,
        Argon2Hasher,
        EmailService,
        TokenKeyManager,
        JwtService,
        RateLimiterService,
        AuthService,
      ],
      exports: [
        AUTH_DATABASE,
        AUTH_DB,
        'AUTH_POOL',
        AUTH_CONFIG,
        UserRepository,
        Argon2Hasher,
        EmailService,
        TokenKeyManager,
        JwtService,
        RateLimiterService,
        AuthService,
      ],
    };
  }
}
