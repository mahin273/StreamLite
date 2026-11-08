import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger, runWithContext } from '../index.js';

describe('Logger Package', () => {
  it('should automatically redact sensitive fields at the engine level', async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger({
      serviceName: 'test-svc',
      level: 'info',
      destination: stream,
    });

    testLogger.info(
      {
        user: 'alice@example.com',
        password: 'superSecretPassword123!',
        token: 'eyJhbGciOi...',
        secret: 'api_secret_key',
        cookie: 'session_id=abc',
        nested: {
          password: 'anotherSecretPassword',
        },
      },
      'User logged in',
    );

    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]!);

    assert.equal(parsed.service, 'test-svc');
    assert.equal(parsed.user, 'alice@example.com');
    assert.equal(parsed.password, '[Redacted]');
    assert.equal(parsed.token, '[Redacted]');
    assert.equal(parsed.secret, '[Redacted]');
    assert.equal(parsed.cookie, '[Redacted]');
    assert.equal(parsed.nested.password, '[Redacted]');
    assert.equal(parsed.msg, 'User logged in');
  });

  it('should automatically inject requestId and traceId from AsyncLocalStorage context', async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger({
      serviceName: 'test-svc',
      level: 'info',
      destination: stream,
    });

    runWithContext({ requestId: 'req_01j7c3xyz', traceId: 'trace_999abc' }, () => {
      testLogger.info('Processing operation inside context');
    });

    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]!);

    assert.equal(parsed.requestId, 'req_01j7c3xyz');
    assert.equal(parsed.traceId, 'trace_999abc');
    assert.equal(parsed.msg, 'Processing operation inside context');
  });

  it('should not contain requestId or traceId when outside context', async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger({
      serviceName: 'test-svc',
      level: 'info',
      destination: stream,
    });

    testLogger.info('Standalone operation');

    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]!);

    assert.equal(parsed.requestId, undefined);
    assert.equal(parsed.traceId, undefined);
    assert.equal(parsed.msg, 'Standalone operation');
  });
});
