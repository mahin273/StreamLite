import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { BlobConfig } from './config.js';

export interface S3Clients {
  s3Internal: S3Client;
  s3Public: S3Client;
}

export function createS3Clients(config: BlobConfig): S3Clients {
  const common: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },

    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };

  const s3Internal = new S3Client({
    ...common,
    endpoint: config.endpoint,
  });

  const s3Public = new S3Client({
    ...common,
    endpoint: config.publicEndpoint,
  });

  return { s3Internal, s3Public };
}
