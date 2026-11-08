import { z } from 'zod';

export const CursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>;

export const createPaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}
