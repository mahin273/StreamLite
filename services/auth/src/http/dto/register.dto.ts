import { z } from 'zod';
import { isCommonPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../../security/password-rules.js';

export const RegisterDtoSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address')
    .max(255, 'Email must not exceed 255 characters')
    .trim(),
  password: z
    .string({ required_error: 'Password is required' })
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(MAX_PASSWORD_LENGTH, `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`)
    .refine((val) => !isCommonPassword(val), {
      message: 'Password is too common; please choose a stronger passphrase',
    }),
  displayName: z
    .string({ required_error: 'Display name is required' })
    .min(2, 'Display name must be at least 2 characters')
    .max(50, 'Display name must not exceed 50 characters')
    .trim(),
});

export type RegisterDto = z.infer<typeof RegisterDtoSchema>;

export const RegisterResponseSchema = z.object({
  message: z.string(),
});

export type RegisterResponseDto = z.infer<typeof RegisterResponseSchema>;

export const GENERIC_REGISTRATION_MESSAGE =
  'If your account is eligible, a verification email has been dispatched.';
