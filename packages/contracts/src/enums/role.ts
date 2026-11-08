import { z } from 'zod';

export const RoleEnum = z.enum(['viewer', 'creator', 'admin']);

export type Role = z.infer<typeof RoleEnum>;
