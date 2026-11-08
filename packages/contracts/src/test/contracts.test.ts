import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CursorPaginationQuerySchema,
  createPaginatedResponseSchema,
  ProblemDetailsSchema,
  RoleEnum,
  UserStatusEnum,
  VideoStatusEnum,
} from '../index.js';
import { z } from 'zod';

describe('Contracts Package', () => {
  describe('CursorPaginationQuerySchema', () => {
    it('should use default limit = 20 when no params provided', () => {
      const parsed = CursorPaginationQuerySchema.parse({});
      assert.equal(parsed.limit, 20);
      assert.equal(parsed.cursor, undefined);
    });

    it('should coerce string numbers to integer limit', () => {
      const parsed = CursorPaginationQuerySchema.parse({ limit: '50', cursor: 'curs_123' });
      assert.equal(parsed.limit, 50);
      assert.equal(parsed.cursor, 'curs_123');
    });

    it('should reject limit > 100 or < 1', () => {
      assert.throws(() => CursorPaginationQuerySchema.parse({ limit: 0 }));
      assert.throws(() => CursorPaginationQuerySchema.parse({ limit: 101 }));
    });
  });

  describe('createPaginatedResponseSchema', () => {
    it('should validate paginated items with nextCursor', () => {
      const ItemSchema = z.object({ id: z.string(), name: z.string() });
      const Schema = createPaginatedResponseSchema(ItemSchema);

      const valid = Schema.parse({
        items: [{ id: '1', name: 'Item 1' }],
        nextCursor: 'next_token',
      });

      assert.equal(valid.items.length, 1);
      assert.equal(valid.nextCursor, 'next_token');
    });
  });

  describe('ProblemDetailsSchema', () => {
    it('should validate RFC 7807 compliant problem details', () => {
      const sample = {
        type: 'https://streamlite.dev/errors/validation-error',
        title: 'Validation Failed',
        status: 400,
        detail: 'Invalid email address',
        code: 'VALIDATION_ERROR',
        requestId: 'req_01j7c3',
        errors: [{ field: 'email', message: 'Must be a valid email' }],
      };

      const parsed = ProblemDetailsSchema.parse(sample);
      assert.equal(parsed.status, 400);
      assert.equal(parsed.code, 'VALIDATION_ERROR');
      assert.equal(parsed.errors?.length, 1);
    });
  });

  describe('Enums', () => {
    it('should validate RoleEnum values', () => {
      assert.equal(RoleEnum.parse('viewer'), 'viewer');
      assert.equal(RoleEnum.parse('creator'), 'creator');
      assert.equal(RoleEnum.parse('admin'), 'admin');
      assert.throws(() => RoleEnum.parse('superadmin'));
    });

    it('should validate UserStatusEnum values', () => {
      assert.equal(UserStatusEnum.parse('active'), 'active');
      assert.throws(() => UserStatusEnum.parse('banned'));
    });

    it('should validate VideoStatusEnum values', () => {
      assert.equal(VideoStatusEnum.parse('transcoding'), 'transcoding');
      assert.throws(() => VideoStatusEnum.parse('processing'));
    });
  });
});
