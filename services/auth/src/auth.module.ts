import { type DynamicModule, Module } from '@nestjs/common';
import { createAuthDatabase, type DatabaseConfig } from './store/database.js';
import { AUTH_DATABASE, UserRepository } from './store/user.repository.js';
import { Argon2Hasher } from './security/argon2-hasher.js';
import { AuthService } from './domain/auth.service.js';
import { AuthController } from './http/auth.controller.js';
import { EmailService } from './email/email.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_DATABASE,
      useFactory: () => {
        const { db } = createAuthDatabase();
        return db;
      },
    },
    UserRepository,
    Argon2Hasher,
    EmailService,
    AuthService,
  ],
  exports: [AUTH_DATABASE, UserRepository, Argon2Hasher, EmailService, AuthService],
})
export class AuthModule {
  static register(config?: DatabaseConfig): DynamicModule {
    const { db, pool } = createAuthDatabase(config);

    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        {
          provide: AUTH_DATABASE,
          useValue: db,
        },
        {
          provide: 'AUTH_POOL',
          useValue: pool,
        },
        UserRepository,
        Argon2Hasher,
        EmailService,
        AuthService,
      ],
      exports: [AUTH_DATABASE, 'AUTH_POOL', UserRepository, Argon2Hasher, EmailService, AuthService],
    };
  }
}
