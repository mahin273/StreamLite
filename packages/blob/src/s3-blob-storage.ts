import {
  type S3Client,
  PutObjectCommand,
  type PutObjectCommandInput,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NotFoundError, InternalServerError } from '@streamlite/http';
import { logger } from '@streamlite/logger';
import { loadBlobConfig, type BlobConfig } from './config.js';
import { createS3Clients, type S3Clients } from './client.js';
import type {
  BlobStorage,
  CompletedPart,
  CompleteMultipartUploadResult,
  MultipartUploadResult,
  ObjectMetadata,
  PresignedUrlOptions,
  PutObjectResult,
} from './types.js';

interface S3ErrorLike {
  name?: string;
  $metadata?: {
    httpStatusCode?: number;
  };
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const s3Err = err as S3ErrorLike;
    return (
      s3Err.name === 'NoSuchKey' ||
      s3Err.name === 'NotFound' ||
      s3Err.$metadata?.httpStatusCode === 404
    );
  }
  return false;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class S3BlobStorage implements BlobStorage {
  private readonly config: BlobConfig;
  private readonly s3Internal: S3Client;
  private readonly s3Public: S3Client;

  constructor(configOverrides?: Partial<BlobConfig>) {
    this.config = loadBlobConfig(configOverrides);
    const clients: S3Clients = createS3Clients(this.config);
    this.s3Internal = clients.s3Internal;
    this.s3Public = clients.s3Public;
  }

  // 1. Presigning (Uses s3Public with host accessible to external clients)
  async getUploadUrl(
    bucket: string,
    key: string,
    options: PresignedUrlOptions = {},
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
      });

      return await getSignedUrl(this.s3Public, command, {
        expiresIn: options.expiresIn ?? 900,
      });
    } catch (err) {
      logger.error({ err, bucket, key }, 'Failed to generate presigned upload URL');
      throw new InternalServerError('Could not generate presigned upload URL');
    }
  }

  async getDownloadUrl(
    bucket: string,
    key: string,
    options: PresignedUrlOptions = {},
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      return await getSignedUrl(this.s3Public, command, {
        expiresIn: options.expiresIn ?? 900,
      });
    } catch (err) {
      logger.error({ err, bucket, key }, 'Failed to generate presigned download URL');
      throw new InternalServerError('Could not generate presigned download URL');
    }
  }

  // 2. Direct Server I/O (Uses s3Internal)
  async putObject(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array | string | NodeJS.ReadableStream | ReadableStream,
    contentType?: string,
  ): Promise<PutObjectResult> {
    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body as NonNullable<PutObjectCommandInput['Body']>,
        ...(contentType ? { ContentType: contentType } : {}),
      });

      const response = await this.s3Internal.send(command);
      return {
        ...(response.ETag ? { etag: response.ETag } : {}),
        ...(response.VersionId ? { versionId: response.VersionId } : {}),
      };
    } catch (err) {
      logger.error({ err, bucket, key }, 'Failed to put object into blob storage');
      throw new InternalServerError(`Failed to store object: ${key}`);
    }
  }

  async getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Internal.send(command);
      if (!response.Body) {
        throw new NotFoundError(`Object ${bucket}/${key} has an empty body`);
      }
      return response.Body as unknown as NodeJS.ReadableStream;
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      if (isNotFoundError(err)) {
        throw new NotFoundError(`Object not found: ${bucket}/${key}`);
      }
      logger.error({ err, bucket, key }, 'Failed to get object from blob storage');
      throw new InternalServerError(`Failed to read object: ${key}`);
    }
  }

  async getObjectAsBuffer(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.getObject(bucket, key);
    return streamToBuffer(stream);
  }

  async headObject(bucket: string, key: string): Promise<ObjectMetadata | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Internal.send(command);
      return {
        ...(response.ContentLength !== undefined ? { contentLength: response.ContentLength } : {}),
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        ...(response.ETag ? { etag: response.ETag } : {}),
        ...(response.LastModified ? { lastModified: response.LastModified } : {}),
      };
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return null;
      }
      logger.error({ err, bucket, key }, 'Failed to inspect object metadata');
      throw new InternalServerError(`Failed to inspect object: ${key}`);
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await this.s3Internal.send(command);
    } catch (err) {
      logger.error({ err, bucket, key }, 'Failed to delete object from blob storage');
      throw new InternalServerError(`Failed to delete object: ${key}`);
    }
  }

  // 3. Multipart Upload Lifecycle
  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType?: string,
  ): Promise<MultipartUploadResult> {
    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      });

      const response = await this.s3Internal.send(command);
      if (!response.UploadId) {
        throw new InternalServerError('Storage engine did not return an UploadId');
      }

      return { uploadId: response.UploadId };
    } catch (err) {
      logger.error({ err, bucket, key }, 'Failed to create multipart upload session');
      throw new InternalServerError(`Failed to create multipart upload for: ${key}`);
    }
  }

  async getUploadPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    options: PresignedUrlOptions = {},
  ): Promise<string> {
    try {
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      return await getSignedUrl(this.s3Public, command, {
        expiresIn: options.expiresIn ?? 900,
      });
    } catch (err) {
      logger.error(
        { err, bucket, key, uploadId, partNumber },
        'Failed to generate part upload URL',
      );
      throw new InternalServerError(`Failed to generate upload URL for part ${partNumber}`);
    }
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<CompleteMultipartUploadResult> {
    try {
      const sortedParts = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({
          PartNumber: p.partNumber,
          ETag: p.etag.startsWith('"') ? p.etag : `"${p.etag}"`,
        }));

      const command = new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts,
        },
      });

      const response = await this.s3Internal.send(command);
      return {
        bucket,
        key,
        ...(response.Location ? { location: response.Location } : {}),
        ...(response.ETag ? { etag: response.ETag } : {}),
      };
    } catch (err) {
      logger.error({ err, bucket, key, uploadId }, 'Failed to complete multipart upload');
      throw new InternalServerError(`Failed to assemble multipart upload for: ${key}`);
    }
  }

  async abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void> {
    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      });

      await this.s3Internal.send(command);
    } catch (err) {
      logger.error({ err, bucket, key, uploadId }, 'Failed to abort multipart upload');
      throw new InternalServerError(`Failed to abort multipart upload for: ${key}`);
    }
  }

  // 4. Bucket Administration
  async ensureBucketExists(bucket: string): Promise<void> {
    try {
      await this.s3Internal.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        try {
          await this.s3Internal.send(new CreateBucketCommand({ Bucket: bucket }));
          logger.info({ bucket }, 'Created blob storage bucket');
        } catch (createErr) {
          logger.error({ createErr, bucket }, 'Failed to create missing bucket');
          throw new InternalServerError(`Failed to create bucket: ${bucket}`);
        }
      } else {
        logger.error({ err, bucket }, 'Failed to verify bucket existence');
        throw new InternalServerError(`Failed to verify bucket: ${bucket}`);
      }
    }
  }
}
