import { z } from 'zod';

export const KafkaConfigSchema = z.object({
  brokers: z
    .array(z.string().min(1))
    .min(1)
    .default(() => {
      const env = process.env['KAFKA_BROKERS'];
      return env ? env.split(',').map((b) => b.trim()) : ['localhost:19092'];
    }),
  clientId: z.string().default(() => process.env['KAFKA_CLIENT_ID'] || 'streamlite'),
  connectionTimeout: z.number().int().positive().default(5000),
  requestTimeout: z.number().int().positive().default(30000),
  retryMaxAttempts: z.number().int().nonnegative().default(5),
});

export type KafkaConfig = z.infer<typeof KafkaConfigSchema>;

export function loadKafkaConfig(overrides?: Partial<KafkaConfig>): KafkaConfig {
  return KafkaConfigSchema.parse(overrides || {});
}
