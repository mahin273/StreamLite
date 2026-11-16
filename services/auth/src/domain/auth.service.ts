import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Argon2Hasher } from '../security/argon2-hasher.js';
import { UserRepository } from '../store/user.repository.js';
import {
  type RegisterDto,
  type RegisterResponseDto,
  GENERIC_REGISTRATION_MESSAGE,
} from '../http/dto/register.dto.js';
import { logger } from '@streamlite/logger';

@Injectable()
export class AuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly hasher: Argon2Hasher,
  ) {}

  async register(dto: RegisterDto, traceId?: string): Promise<RegisterResponseDto> {
    const existing = await this.userRepository.findByEmail(dto.email);

    if (existing) {
      logger.info({ email: dto.email }, 'Registration attempted for existing account (anti-enumeration active)');

      // Constant-time dummy hash prevents response time analysis from leaking account existence
      await this.hasher.hashDummy();

      return {
        message: GENERIC_REGISTRATION_MESSAGE,
      };
    }

    // Hash password with memory-hard Argon2id (concurrency protected by semaphore)
    const passwordHash = await this.hasher.hash(dto.password);

    // Generate secure 256-bit token for email verification
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest();
    const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hour expiry

    await this.userRepository.createRegisteredUser({
      email: dto.email,
      passwordHash,
      displayName: dto.displayName,
      tokenHash,
      rawToken,
      tokenExpiresAt,
      traceId,
    });

    logger.info({ email: dto.email }, 'User registered successfully; verification email enqueued in outbox');

    return {
      message: GENERIC_REGISTRATION_MESSAGE,
    };
  }
}
