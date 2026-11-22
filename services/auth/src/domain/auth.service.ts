import { Injectable, Inject, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Argon2Hasher } from '../security/argon2-hasher.js';
import { JwtService } from '../security/jwt.service.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';
import { UserRepository } from '../store/user.repository.js';
import { AUTH_CONFIG, type AuthConfig } from '../config.js';
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
import type { LoginDto, LoginResponse, RefreshResponse } from '../http/dto/login.dto.js';
import { BadRequestError, UnauthorizedError } from '@streamlite/http';
import { logger } from '@streamlite/logger';

export interface LoginResult extends LoginResponse {
  rawRefreshToken: string;
}

export interface RefreshResult extends RefreshResponse {
  newRawRefreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly hasher: Argon2Hasher,
    private readonly jwtService: JwtService,
    private readonly rateLimiter: RateLimiterService,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
  ) {}

  async register(
    dto: RegisterDto,
    ip?: string,
    traceId?: string,
  ): Promise<RegisterResponseDto> {
    // Rate limit registration by IP (5 attempts / hour)
    await this.rateLimiter.consumeRegister(ip ?? 'unknown');

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
    // Rate limit forgot password requests by email (3 requests / hour)
    await this.rateLimiter.consumeForgotPassword(dto.email);

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

  /**
   * Authenticates user credentials with Argon2id and issues a 10-minute Ed25519 access JWT
   * alongside a sliding 30-day rotating refresh token family.
   */
  async login(
    dto: LoginDto,
    ip?: string,
    userAgent?: string,
  ): Promise<LoginResult> {
    const clientIp = ip ?? 'unknown';

    // 1. Pre-flight rate limiting check by (email + IP)
    await this.rateLimiter.consumeLogin(dto.email, clientIp);

    const user = await this.userRepository.findByEmail(dto.email);

    if (!user || user.status === 'deleted' || user.deleted_at) {
      logger.info({ email: dto.email }, 'Login attempted for non-existent user');
      // Constant-time dummy hash to resist timing-based account enumeration
      await this.hasher.hashDummy();
      throw new UnauthorizedError('Invalid email or password');
    }

    // 2. Pre-flight account lockout check (prevents executing expensive Argon2 on locked accounts)
    if (user.status === 'locked' && user.locked_until && new Date(user.locked_until) > new Date()) {
      logger.warn({ email: dto.email, userId: user.id }, 'Login attempted on locked user account');
      throw new UnauthorizedError('Account is temporarily locked due to too many failed attempts');
    }

    const passwordMatches = await this.hasher.verify(user.password_hash, dto.password);
    if (!passwordMatches) {
      logger.info({ email: dto.email, userId: user.id }, 'Invalid password supplied');
      const lockoutRes = await this.userRepository.recordFailedLogin(
        user.id,
        this.config?.accountLockoutThreshold ?? 5,
      );
      if (lockoutRes.isLocked) {
        logger.warn(
          {
            email: dto.email,
            userId: user.id,
            failedLogins: lockoutRes.failedLogins,
            lockedUntil: lockoutRes.lockedUntil,
          },
          'Account locked due to consecutive failed login attempts',
        );
      }
      throw new UnauthorizedError('Invalid email or password');
    }

    if (user.failed_logins > 0 || user.status === 'locked') {
      await this.userRepository.resetFailedLogins(user.id);
    }

    // Clear Redis rate limit counter on successful login
    await this.rateLimiter.resetLogin(dto.email, clientIp);

    // Generate fresh session and rotating refresh token family
    const familyId = randomUUID();
    const tokenId = randomUUID();
    const rawRefreshToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest();
    const days = this.config?.refreshExpiresInDays ?? 30;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await this.userRepository.createRefreshToken({
      id: tokenId,
      userId: user.id,
      familyId,
      tokenHash,
      expiresAt,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    const isEmailVerified = Boolean(user.email_verified_at);
    const { token: accessToken, expiresIn } = await this.jwtService.issueAccountToken({
      userId: user.id,
      role: user.role,
      emailVerified: isEmailVerified,
      sessionId: familyId,
    });

    logger.info({ userId: user.id, familyId }, 'User logged in successfully; tokens issued');

    return {
      accessToken,
      expiresIn,
      rawRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * Rotates a sliding refresh token within its family, returning a new access token
   * and a new refresh token. Detects token reuse (stolen token attacks) and immediately
   * revokes the entire family.
   */
  async refresh(
    rawRefreshToken: string,
    ip?: string,
    userAgent?: string,
  ): Promise<RefreshResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedError('Refresh token is missing');
    }

    const tokenHash = createHash('sha256').update(rawRefreshToken).digest();
    const record = await this.userRepository.findRefreshTokenByHash(tokenHash);

    if (!record) {
      logger.warn('Refresh attempted with unknown token hash');
      throw new UnauthorizedError('Invalid refresh token');
    }

    // AUTOMATIC REUSE DETECTION: Replay of an already-revoked token indicates theft!
    if (record.revoked_at !== null) {
      logger.error(
        { familyId: record.family_id, userId: record.user_id },
        'Stolen refresh token reuse detected! Immediately invalidating entire token family.',
      );
      await this.userRepository.revokeFamily(record.family_id);
      throw new UnauthorizedError('Token reuse detected; session revoked');
    }

    // Expiry check
    if (new Date(record.expires_at) <= new Date()) {
      logger.info({ familyId: record.family_id, userId: record.user_id }, 'Refresh token expired');
      throw new UnauthorizedError('Refresh token has expired');
    }

    // Ensure user remains active
    const user = await this.userRepository.findById(record.user_id);
    if (!user || user.status === 'deleted' || user.deleted_at) {
      throw new UnauthorizedError('User account is inactive or deleted');
    }

    if (user.status === 'locked' && user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new UnauthorizedError('Account is temporarily locked');
    }

    // Rotate within family
    const newTokenId = randomUUID();
    const newRawRefreshToken = randomBytes(32).toString('base64url');
    const newTokenHash = createHash('sha256').update(newRawRefreshToken).digest();
    const days = this.config?.refreshExpiresInDays ?? 30;
    const newExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await this.userRepository.rotateRefreshToken({
      oldTokenId: record.id,
      newTokenId,
      userId: record.user_id,
      familyId: record.family_id,
      newTokenHash,
      expiresAt: newExpiresAt,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    const isEmailVerified = Boolean(user.email_verified_at);
    const { token: accessToken, expiresIn } = await this.jwtService.issueAccountToken({
      userId: user.id,
      role: user.role,
      emailVerified: isEmailVerified,
      sessionId: record.family_id,
    });

    logger.info(
      { userId: user.id, familyId: record.family_id },
      'Refresh token rotated successfully within family',
    );

    return {
      accessToken,
      expiresIn,
      newRawRefreshToken,
    };
  }

  /**
   * Revokes the current session refresh token.
   */
  async logout(rawRefreshToken: string): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    const tokenHash = createHash('sha256').update(rawRefreshToken).digest();
    await this.userRepository.revokeRefreshToken(tokenHash);
    logger.info('Refresh token revoked successfully on logout');
  }

  /**
   * Revokes all active refresh tokens for the user across all devices.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.userRepository.revokeAllUserSessions(userId);
    logger.info({ userId }, 'All user sessions revoked successfully');
  }
}
