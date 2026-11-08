export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectMetadata {
  contentLength?: number | undefined;
  contentType?: string | undefined;
  etag?: string | undefined;
  lastModified?: Date | undefined;
}

export interface PresignedUrlOptions {
  expiresIn?: number | undefined; // in seconds, default 900 (15 min)
  contentType?: string | undefined;
}

export interface PutObjectResult {
  etag?: string | undefined;
  versionId?: string | undefined;
}

export interface MultipartUploadResult {
  uploadId: string;
}

export interface CompleteMultipartUploadResult {
  location?: string | undefined;
  bucket: string;
  key: string;
  etag?: string | undefined;
}

export interface BlobStorage {
  // Presigning for client direct access (uses s3Public)
  getUploadUrl(bucket: string, key: string, options?: PresignedUrlOptions): Promise<string>;

  getDownloadUrl(bucket: string, key: string, options?: PresignedUrlOptions): Promise<string>;

  // Server-side Direct I/O (uses s3Internal)
  putObject(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array | string | NodeJS.ReadableStream | ReadableStream,
    contentType?: string,
  ): Promise<PutObjectResult>;

  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;

  getObjectAsBuffer(bucket: string, key: string): Promise<Buffer>;

  headObject(bucket: string, key: string): Promise<ObjectMetadata | null>;

  deleteObject(bucket: string, key: string): Promise<void>;

  // Multipart Upload Lifecycle
  createMultipartUpload(
    bucket: string,
    key: string,
    contentType?: string,
  ): Promise<MultipartUploadResult>;

  getUploadPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    options?: PresignedUrlOptions,
  ): Promise<string>;

  completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<CompleteMultipartUploadResult>;

  abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void>;

  // Bucket administration
  ensureBucketExists(bucket: string): Promise<void>;
}
