import { z } from 'zod';

export const UserStatusEnum = z.enum(['pending_verification', 'active', 'locked', 'deleted']);

export type UserStatus = z.infer<typeof UserStatusEnum>;
