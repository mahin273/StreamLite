import { z } from 'zod';

export const FieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ProblemDetailsSchema = z.object({
  type: z.string().url().or(z.string().startsWith('https://')),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().min(1),
  code: z.string().min(1),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(FieldErrorSchema).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
