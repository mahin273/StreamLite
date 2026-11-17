import { z } from 'zod';
import { isCommonPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../../security/password-rules.js';

export const VerifyEmailDtoSchema = z.object({
  token: z
    .string({ required_error: 'Verification token is required' })
    .length(64, 'Verification token must be 64 hexadecimal characters')
    .regex(/^[0-9a-fA-F]+$/, 'Verification token must be a valid hex string'),
});

export type VerifyEmailDto = z.infer<typeof VerifyEmailDtoSchema>;

export const ResendVerificationDtoSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address')
    .max(255, 'Email must not exceed 255 characters')
    .trim(),
});

export type ResendVerificationDto = z.infer<typeof ResendVerificationDtoSchema>;

export const ForgotPasswordDtoSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address')
    .max(255, 'Email must not exceed 255 characters')
    .trim(),
});

export type ForgotPasswordDto = z.infer<typeof ForgotPasswordDtoSchema>;

export const ResetPasswordDtoSchema = z.object({
  token: z
    .string({ required_error: 'Reset token is required' })
    .length(64, 'Reset token must be 64 hexadecimal characters')
    .regex(/^[0-9a-fA-F]+$/, 'Reset token must be a valid hex string'),
  newPassword: z
    .string({ required_error: 'New password is required' })
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(MAX_PASSWORD_LENGTH, `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`)
    .refine((val) => !isCommonPassword(val), {
      message: 'Password is too common; please choose a stronger passphrase',
    }),
});

export type ResetPasswordDto = z.infer<typeof ResetPasswordDtoSchema>;

export const GENERIC_VERIFICATION_SENT_MESSAGE =
  'If your account is eligible, a verification email has been dispatched.';

export const GENERIC_RESET_SENT_MESSAGE =
  'If an account exists with this email, a password reset link has been dispatched.';
