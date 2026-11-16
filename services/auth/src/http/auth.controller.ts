import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from '@streamlite/http';
import { AuthService } from '../domain/auth.service.js';
import {
  RegisterDtoSchema,
  type RegisterDto,
  type RegisterResponseDto,
} from './dto/register.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(RegisterDtoSchema))
  async register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }
}
