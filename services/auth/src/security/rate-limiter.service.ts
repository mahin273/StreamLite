import { Injectable, Inject, Optional, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { TooManyRequestsError } from '@streamlite/http';
import { logger } from '@streamlite/logger';
import { AUTH_CONFIG } from '../config.js';
import type { AuthConfig } from '../config.js';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly redisClient: Redis;
  private readonly isOwnedRedis: boolean;
  private readonly loginLimiter: RateLimiterRedis;
  private readonly registerLimiter: RateLimiterRedis;
  private readonly forgotPasswordLimiter: RateLimiterRedis;

  constructor(
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
    @Optional() @Inject(REDIS_CLIENT) externalRedis?: Redis,
  ) {
    if (externalRedis) {
      this.redisClient = externalRedis;
      this.isOwnedRedis = false;
    } else {
      const url =
        this.config?.redisUrl ||
        process.env['REDIS_URL'] ||
        'redis://localhost:6379';
      this.redisClient = new Redis(url, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.isOwnedRedis = true;
    }

    const loginPoints = this.config?.rateLimitLoginPoints ?? 5;
    const loginDuration = this.config?.rateLimitLoginDuration ?? 900; // 15 min

    const registerPoints = this.config?.rateLimitRegisterPoints ?? 5;
    const registerDuration = this.config?.rateLimitRegisterDuration ?? 3600; // 1 hr

    const forgotPoints = this.config?.rateLimitForgotPoints ?? 3;
    const forgotDuration = this.config?.rateLimitForgotDuration ?? 3600; // 1 hr

    this.loginLimiter = new RateLimiterRedis({
      storeClient: this.redisClient,
      keyPrefix: 'rl:login',
      points: loginPoints,
      duration: loginDuration,
    });

    this.registerLimiter = new RateLimiterRedis({
      storeClient: this.redisClient,
      keyPrefix: 'rl:register',
      points: registerPoints,
      duration: registerDuration,
    });

    this.forgotPasswordLimiter = new RateLimiterRedis({
      storeClient: this.redisClient,
      keyPrefix: 'rl:forgot',
      points: forgotPoints,
      duration: forgotDuration,
    });
  }

  /**
   * Consumes a rate limit point for login attempts by (email + IP) pair.
   * Throws HTTP 429 TooManyRequestsError if 5 attempts / 15 minutes is exceeded.
   */
  async consumeLogin(email: string, ip = 'unknown'): Promise<void> {
    const key = `${email.trim().toLowerCase()}:${ip}`;
    try {
      await this.loginLimiter.consume(key);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retrySec = Math.ceil(err.msBeforeNext / 1000) || 1;
        logger.warn(
          { email, ip, retrySec },
          'Login rate limit exceeded; rejecting request with HTTP 429',
        );
        throw new TooManyRequestsError(
          `Too many login attempts. Please try again in ${retrySec} seconds.`,
          retrySec,
        );
      }
      logger.error({ err, key }, 'Redis rate limiter encountered error on login consume');
      // Fail-open strategy on unexpected Redis error to avoid taking down auth
    }
  }

  /**
   * Clears the rate limit counter for an (email + IP) pair upon successful authentication.
   */
  async resetLogin(email: string, ip = 'unknown'): Promise<void> {
    const key = `${email.trim().toLowerCase()}:${ip}`;
    try {
      await this.loginLimiter.delete(key);
    } catch (err) {
      logger.warn({ err, key }, 'Failed to delete login rate limit key after success');
    }
  }

  /**
   * Consumes a rate limit point for user registrations by IP address.
   * Throws HTTP 429 TooManyRequestsError if 5 signups / hour is exceeded.
   */
  async consumeRegister(ip = 'unknown'): Promise<void> {
    const key = ip;
    try {
      await this.registerLimiter.consume(key);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retrySec = Math.ceil(err.msBeforeNext / 1000) || 1;
        logger.warn(
          { ip, retrySec },
          'Registration rate limit exceeded for IP; rejecting request with HTTP 429',
        );
        throw new TooManyRequestsError(
          'Too many registration attempts from this IP address. Please try again later.',
          retrySec,
        );
      }
      logger.error({ err, key }, 'Redis rate limiter encountered error on register consume');
    }
  }

  /**
   * Consumes a rate limit point for forgot password requests by target email.
   * Throws HTTP 429 TooManyRequestsError if 3 reset requests / hour is exceeded.
   */
  async consumeForgotPassword(email: string): Promise<void> {
    const key = email.trim().toLowerCase();
    try {
      await this.forgotPasswordLimiter.consume(key);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retrySec = Math.ceil(err.msBeforeNext / 1000) || 1;
        logger.warn(
          { email, retrySec },
          'Forgot password rate limit exceeded for email; rejecting request with HTTP 429',
        );
        throw new TooManyRequestsError(
          'Too many password reset requests for this email address. Please try again later.',
          retrySec,
        );
      }
      logger.error({ err, key }, 'Redis rate limiter encountered error on forgot password consume');
    }
  }

  /**
   * Resets all rate limit keys in Redis (primarily for test teardown and cleanup).
   */
  async resetAll(): Promise<void> {
    try {
      const keys = await this.redisClient.keys('rl:*');
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clear rate limit keys');
    }
  }

  /**
   * Cleanly closes the Redis connection on module destroy if owned by this service.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.isOwnedRedis && this.redisClient.status === 'ready') {
      await this.redisClient.quit();
    }
  }

  /**
   * Directly exposes the underlying Redis client for test cleanup or health checks.
   */
  getRedisClient(): Redis {
    return this.redisClient;
  }
}
