import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z, ZodError } from 'zod';
import type { ArgumentsHost } from '@nestjs/common';
import type { ProblemDetails } from '@streamlite/contracts';
import { runWithContext } from '@streamlite/logger';
import {
  AppError,
  NotFoundError,
  ConflictError,
  ValidationError,
  InternalServerError,
} from '../errors/app-error.js';
import { ProblemDetailsFilter } from '../filters/problem-details.filter.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

interface MockResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
  status(code: number): MockResponse;
  header(name: string, value: string): MockResponse;
  send(payload: unknown): MockResponse;
}

function createMockHost(): { host: ArgumentsHost; response: MockResponse } {
  const response: MockResponse = {
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    header(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
      getNext: () => ({}),
    }),
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}),
    switchToWs: () => ({}),
    getType: () => 'http' as const,
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe('HTTP Package', () => {
  describe('AppError hierarchy', () => {
    it('should initialize AppError subclasses with correct statuses and codes', () => {
      const notFound = new NotFoundError('User not found');
      assert.ok(notFound instanceof AppError);
      assert.equal(notFound.statusCode, 404);
      assert.equal(notFound.title, 'Resource Not Found');
      assert.equal(notFound.code, 'NOT_FOUND');
      assert.equal(notFound.detail, 'User not found');

      const conflict = new ConflictError('Email in use');
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.title, 'Conflict');
      assert.equal(conflict.code, 'CONFLICT');

      const serverErr = new InternalServerError();
      assert.equal(serverErr.statusCode, 500);
      assert.equal(serverErr.code, 'INTERNAL_ERROR');
    });
  });

  describe('ProblemDetailsFilter', () => {
    it('should catch AppError and format to RFC 7807 JSON with status 404', () => {
      const filter = new ProblemDetailsFilter();
      const { host, response } = createMockHost();

      runWithContext({ requestId: 'req_test_404' }, () => {
        filter.catch(new NotFoundError('Video segment 04 not found'), host);
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      const body = response.body as Record<string, unknown>;
      assert.equal(body['type'], 'https://streamlite.dev/errors/not-found');
      assert.equal(body['title'], 'Resource Not Found');
      assert.equal(body['status'], 404);
      assert.equal(body['detail'], 'Video segment 04 not found');
      assert.equal(body['code'], 'NOT_FOUND');
      assert.equal(body['requestId'], 'req_test_404');
    });

    it('should catch ZodError and format to RFC 7807 JSON with status 400 and validation issues', () => {
      const filter = new ProblemDetailsFilter();
      const { host, response } = createMockHost();

      const TestSchema = z.object({
        email: z.string().email(),
        age: z.number().min(18),
      });

      let zodError: ZodError | undefined;
      try {
        TestSchema.parse({ email: 'not-an-email', age: 10 });
      } catch (err) {
        zodError = err as ZodError;
      }

      assert.ok(zodError instanceof ZodError);

      filter.catch(zodError, host);

      assert.equal(response.statusCode, 400);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      const body = response.body as ProblemDetails;
      assert.equal(body.status, 400);
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.equal(body.title, 'Validation Failed');
      assert.equal(body.errors?.length, 2);
      assert.equal(body.errors?.[0]?.field, 'email');
      assert.equal(body.errors?.[1]?.field, 'age');
    });

    it('should sanitize unhandled 500 errors and not leak sensitive error messages', () => {
      const filter = new ProblemDetailsFilter();
      const { host, response } = createMockHost();

      const sensitiveError = new Error(
        'Database password leak: postgres://root:supersecret@db:5432',
      );
      filter.catch(sensitiveError, host);

      assert.equal(response.statusCode, 500);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      const body = response.body as Record<string, unknown>;
      assert.equal(body['status'], 500);
      assert.equal(body['code'], 'INTERNAL_ERROR');
      assert.equal(body['title'], 'Internal Server Error');
      assert.equal(body['detail'], 'An unexpected internal server error occurred');
      assert.ok(!JSON.stringify(body).includes('supersecret'));
    });
  });

  describe('ZodValidationPipe', () => {
    it('should parse valid data successfully', () => {
      const schema = z.object({ username: z.string().min(3) });
      const pipe = new ZodValidationPipe(schema);

      const result = pipe.transform({ username: 'streamer' }, { type: 'body' });
      assert.deepEqual(result, { username: 'streamer' });
    });

    it('should throw ValidationError on schema failure', () => {
      const schema = z.object({ username: z.string().min(3) });
      const pipe = new ZodValidationPipe(schema);

      assert.throws(
        () => pipe.transform({ username: 'ab' }, { type: 'body' }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.equal(err.errors?.[0]?.field, 'username');
          return true;
        },
      );
    });
  });
});
