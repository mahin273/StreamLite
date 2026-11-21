import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UsePipes,
  Req,
  Res,
  Inject,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ZodValidationPipe, UnauthorizedError } from '@streamlite/http';
import { AuthService } from '../domain/auth.service.js';
import { JwtService } from '../security/jwt.service.js';
import { UserRepository } from '../store/user.repository.js';
import { AUTH_CONFIG, type AuthConfig } from '../config.js';
import {
  RegisterDtoSchema,
  type RegisterDto,
  type RegisterResponseDto,
} from './dto/register.dto.js';
import {
  VerifyEmailDtoSchema,
  ResendVerificationDtoSchema,
  ForgotPasswordDtoSchema,
  ResetPasswordDtoSchema,
  type VerifyEmailDto,
  type ResendVerificationDto,
  type ForgotPasswordDto,
  type ResetPasswordDto,
} from './dto/email-verification.dto.js';
import {
  LoginSchema,
  type LoginDto,
  type LoginResponse,
  type RefreshResponse,
} from './dto/login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly userRepository: UserRepository,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(RegisterDtoSchema))
  async register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(VerifyEmailDtoSchema))
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    return this.authService.verifyEmail(dto);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(ResendVerificationDtoSchema))
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<{ message: string }> {
    return this.authService.resendVerification(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(ForgotPasswordDtoSchema))
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ResetPasswordDtoSchema))
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    return this.authService.resetPassword(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<LoginResponse> {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ip, userAgent);

    const cookiePath = process.env['COOKIE_PATH'] || '/api/v1/auth';
    const isProd = this.config?.nodeEnv === 'production';

    res.setCookie('refreshToken', result.rawRefreshToken, {
      httpOnly: true,
      secure: isProd || true, // Cookies Secure on localhost work in modern browsers (Design Doc 7.2)
      sameSite: 'strict',
      path: cookiePath,
      maxAge: (this.config?.refreshExpiresInDays ?? 30) * 24 * 60 * 60,
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<RefreshResponse> {
    const rawRefreshToken =
      req.cookies?.['refreshToken'] ||
      (req.headers['x-refresh-token'] as string | undefined);

    if (!rawRefreshToken) {
      throw new UnauthorizedError('Refresh token is missing');
    }

    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.refresh(rawRefreshToken, ip, userAgent);

    const cookiePath = process.env['COOKIE_PATH'] || '/api/v1/auth';
    const isProd = this.config?.nodeEnv === 'production';

    res.setCookie('refreshToken', result.newRawRefreshToken, {
      httpOnly: true,
      secure: isProd || true,
      sameSite: 'strict',
      path: cookiePath,
      maxAge: (this.config?.refreshExpiresInDays ?? 30) * 24 * 60 * 60,
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ message: string }> {
    const rawRefreshToken =
      req.cookies?.['refreshToken'] ||
      (req.headers['x-refresh-token'] as string | undefined);

    if (rawRefreshToken) {
      await this.authService.logout(rawRefreshToken);
    }

    const cookiePath = process.env['COOKIE_PATH'] || '/api/v1/auth';
    res.clearCookie('refreshToken', { path: cookiePath });

    return { message: 'Logged out successfully' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ message: string }> {
    let userId: string | null = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const payload = await this.jwtService.verifyToken(token);
        userId = payload.sub;
      } catch {
        // Bearer token verification failed, try fallback
      }
    }

    if (!userId) {
      const rawRefreshToken =
        req.cookies?.['refreshToken'] ||
        (req.headers['x-refresh-token'] as string | undefined);

      if (rawRefreshToken) {
        const tokenHash = createHash('sha256').update(rawRefreshToken).digest();
        const record = await this.userRepository.findRefreshTokenByHash(tokenHash);
        if (record) {
          userId = record.user_id;
        }
      }
    }

    if (!userId) {
      throw new UnauthorizedError('Authentication required to logout all sessions');
    }

    await this.authService.logoutAll(userId);

    const cookiePath = process.env['COOKIE_PATH'] || '/api/v1/auth';
    res.clearCookie('refreshToken', { path: cookiePath });

    return { message: 'All sessions logged out successfully' };
  }
}
