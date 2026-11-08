import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { S3BlobStorage } from '../s3-blob-storage.js';
import { createS3Clients } from '../client.js';
import { loadBlobConfig } from '../config.js';
import { NotFoundError } from '@streamlite/http';

describe('Blob Package', () => {
  describe('Configuration & Client initialization', () => {
    it('should configure S3 clients with path-style and WHEN_REQUIRED checksums', () => {
      const config = loadBlobConfig({
        endpoint: 'http://localhost:8333',
        publicEndpoint: 'http://localhost:8333',
        region: 'us-east-1',
        accessKeyId: 'test_key',
        secretAccessKey: 'test_secret',
        forcePathStyle: true,
      });

      const { s3Internal, s3Public } = createS3Clients(config);
      assert.ok(s3Internal);
      assert.ok(s3Public);
    });
  });

  describe('SeaweedFS S3 Integration Spike', () => {
    const storage = new S3BlobStorage({
      endpoint: process.env['S3_PUBLIC_ENDPOINT'] || 'http://localhost:8333',
      publicEndpoint: process.env['S3_PUBLIC_ENDPOINT'] || 'http://localhost:8333',
      accessKeyId: process.env['S3_KEY'] || 'streamlite_dev_key',
      secretAccessKey: process.env['S3_SECRET'] || 'streamlite_dev_secret',
      region: 'us-east-1',
      forcePathStyle: true,
    });

    const testBucket = 'raw';

    before(async () => {
      await storage.ensureBucketExists(testBucket);
    });

    it('should directly put and get object from SeaweedFS', async () => {
      const key = `test/direct-${Date.now()}.txt`;
      const content = 'Hello StreamLite Object Storage!';

      const putResult = await storage.putObject(
        testBucket,
        key,
        Buffer.from(content, 'utf-8'),
        'text/plain',
      );
      assert.ok(putResult.etag, 'Expected etag in putResult');

      const retrieved = await storage.getObjectAsBuffer(testBucket, key);
      assert.equal(retrieved.toString('utf-8'), content);

      const metadata = await storage.headObject(testBucket, key);
      assert.ok(metadata);
      assert.equal(metadata.contentLength, Buffer.byteLength(content));

      await storage.deleteObject(testBucket, key);
      const afterDelete = await storage.headObject(testBucket, key);
      assert.equal(afterDelete, null);
    });

    it('should throw NotFoundError when getting non-existent object', async () => {
      const nonExistentKey = `test/missing-${Date.now()}.bin`;
      await assert.rejects(
        async () => {
          await storage.getObject(testBucket, nonExistentKey);
        },
        (err: unknown) => {
          assert.ok(err instanceof NotFoundError);
          return true;
        },
      );
    });

    it('should generate a presigned PUT URL and allow direct fetch() upload', async () => {
      const key = `test/presigned-${Date.now()}.json`;
      const payload = JSON.stringify({ message: 'Presigned upload success' });

      const uploadUrl = await storage.getUploadUrl(testBucket, key, {
        expiresIn: 300,
        contentType: 'application/json',
      });

      assert.ok(uploadUrl.includes('localhost:8333'));
      assert.ok(uploadUrl.includes('X-Amz-Signature'));

      // Direct client upload via fetch
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: payload,
      });

      assert.equal(putRes.status, 200);

      // Verify content stored in SeaweedFS
      const buffer = await storage.getObjectAsBuffer(testBucket, key);
      assert.equal(buffer.toString('utf-8'), payload);

      // Verify presigned download URL
      const downloadUrl = await storage.getDownloadUrl(testBucket, key, { expiresIn: 300 });
      const getRes = await fetch(downloadUrl);
      assert.equal(getRes.status, 200);
      assert.equal(await getRes.text(), payload);

      await storage.deleteObject(testBucket, key);
    });

    it('should execute full multipart upload lifecycle with chunk assembly', async () => {
      const key = `test/multipart-${Date.now()}.dat`;
      // S3 Specification: Each multipart part except the last must be at least 5 MB (5242880 bytes)
      const part1Data = Buffer.alloc(5 * 1024 * 1024, 'a');
      const part2Data = Buffer.from('final-chunk-data', 'utf-8');
      const expectedCombined = Buffer.concat([part1Data, part2Data]);

      // 1. Initialize multipart upload
      const { uploadId } = await storage.createMultipartUpload(
        testBucket,
        key,
        'application/octet-stream',
      );
      assert.ok(uploadId);

      // 2. Get presigned part URLs
      const part1Url = await storage.getUploadPartUrl(testBucket, key, uploadId, 1);
      const part2Url = await storage.getUploadPartUrl(testBucket, key, uploadId, 2);

      // 3. Upload parts via direct PUT
      const res1 = await fetch(part1Url, {
        method: 'PUT',
        body: part1Data,
      });
      assert.equal(res1.status, 200);
      const etag1 = res1.headers.get('etag');
      assert.ok(etag1, 'Expected ETag header for part 1');

      const res2 = await fetch(part2Url, {
        method: 'PUT',
        body: part2Data,
      });
      assert.equal(res2.status, 200);
      const etag2 = res2.headers.get('etag');
      assert.ok(etag2, 'Expected ETag header for part 2');

      // 4. Complete multipart upload
      const completeResult = await storage.completeMultipartUpload(testBucket, key, uploadId, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]);
      assert.equal(completeResult.key, key);

      // 5. Verify assembled object in SeaweedFS
      const assembledBuffer = await storage.getObjectAsBuffer(testBucket, key);
      assert.equal(assembledBuffer.length, expectedCombined.length);
      assert.ok(assembledBuffer.equals(expectedCombined));

      // 6. Clean up
      await storage.deleteObject(testBucket, key);
    });

    it('should abort multipart upload successfully', async () => {
      const key = `test/abort-${Date.now()}.dat`;
      const { uploadId } = await storage.createMultipartUpload(testBucket, key);
      assert.ok(uploadId);

      await storage.abortMultipartUpload(testBucket, key, uploadId);
      // SeaweedFS cancels the session without error
    });
  });
});
