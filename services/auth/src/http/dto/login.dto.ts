import { z } from 'zod';

export const LoginSchema = z
  .object({
    email: z.string().trim().email({ message: 'Must be a valid email address' }),
    password: z.string().min(1, { message: 'Password is required' }),
  })
  .strict();

export type LoginDto = z.infer<typeof LoginSchema>;

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}
