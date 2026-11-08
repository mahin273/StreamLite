import { z } from 'zod';

export const BlobConfigSchema = z.object({
  endpoint: z
    .string()
    .url()
    .default(process.env['S3_ENDPOINT'] || 'http://localhost:8333'),
  publicEndpoint: z
    .string()
    .url()
    .default(process.env['S3_PUBLIC_ENDPOINT'] || 'http://localhost:8333'),
  region: z.string().default(process.env['S3_REGION'] || 'us-east-1'),
  accessKeyId: z.string().default(process.env['S3_KEY'] || 'streamlite_dev_key'),
  secretAccessKey: z.string().default(process.env['S3_SECRET'] || 'streamlite_dev_secret'),
  forcePathStyle: z.boolean().default(true),
});

export type BlobConfig = z.infer<typeof BlobConfigSchema>;

export function loadBlobConfig(overrides?: Partial<BlobConfig>): BlobConfig {
  return BlobConfigSchema.parse(overrides || {});
}
