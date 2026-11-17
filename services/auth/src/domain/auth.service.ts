import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Argon2Hasher } from '../security/argon2-hasher.js';
import { UserRepository } from '../store/user.repository.js';
import {
  type RegisterDto,
  type RegisterResponseDto,
  GENERIC_REGISTRATION_MESSAGE,
} from '../http/dto/register.dto.js';
import {
  type VerifyEmailDto,
  type ResendVerificationDto,
  type ForgotPasswordDto,
  type ResetPasswordDto,
  GENERIC_VERIFICATION_SENT_MESSAGE,
  GENERIC_RESET_SENT_MESSAGE,
} from '../http/dto/email-verification.dto.js';
import { BadRequestError } from '@streamlite/http';
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

  async verifyEmail(dto: VerifyEmailDto): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(dto.token).digest();

    try {
      await this.userRepository.verifyEmailWithToken(tokenHash);
      logger.info('Email verified successfully');
      return { message: 'Email verified successfully. Your account is now active.' };
    } catch (err) {
      logger.warn({ err }, 'Email verification failed due to invalid or expired token');
      throw new BadRequestError('Invalid, expired, or already used verification token');
    }
  }

  async resendVerification(dto: ResendVerificationDto): Promise<{ message: string }> {
    const user = await this.userRepository.findByEmail(dto.email);

    if (!user || user.status !== 'pending_verification') {
      logger.info(
        { email: dto.email },
        'Resend verification requested for non-pending or non-existent email (anti-enumeration active)',
      );
      // Dummy hash equalizes timing
      await this.hasher.hashDummy();
      return { message: GENERIC_VERIFICATION_SENT_MESSAGE };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hour expiry

    await this.userRepository.createEmailTokenAndOutbox({
      userId: user.id,
      email: user.email,
      kind: 'verify_email',
      tokenHash,
      rawToken,
      expiresAt,
      topic: 'auth.email.verification',
    });

    logger.info({ email: user.email }, 'Fresh verification email enqueued in outbox');

    return { message: GENERIC_VERIFICATION_SENT_MESSAGE };
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const user = await this.userRepository.findByEmail(dto.email);

    if (!user || user.deleted_at !== null) {
      logger.info(
        { email: dto.email },
        'Password reset requested for non-existent email (anti-enumeration active)',
      );
      // Dummy hash equalizes timing
      await this.hasher.hashDummy();
      return { message: GENERIC_RESET_SENT_MESSAGE };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minute expiry for password reset

    await this.userRepository.createEmailTokenAndOutbox({
      userId: user.id,
      email: user.email,
      kind: 'reset_password',
      tokenHash,
      rawToken,
      expiresAt,
      topic: 'auth.email.reset_password',
    });

    logger.info({ email: user.email }, 'Password reset email enqueued in outbox');

    return { message: GENERIC_RESET_SENT_MESSAGE };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(dto.token).digest();
    const newPasswordHash = await this.hasher.hash(dto.newPassword);

    try {
      await this.userRepository.resetPasswordWithToken({
        tokenHash,
        newPasswordHash,
      });

      logger.info('Password reset successfully; sessions revoked');

      return {
        message: 'Password has been reset successfully. Please log in with your new password.',
      };
    } catch (err) {
      logger.warn({ err }, 'Password reset failed due to invalid or expired token');
      throw new BadRequestError('Invalid or expired password reset token');
    }
  }
}
