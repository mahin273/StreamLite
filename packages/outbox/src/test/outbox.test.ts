import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;
import { KafkaEventBus } from '@streamlite/events';
import { OUTBOX_TABLE_DDL, PROCESSED_EVENTS_TABLE_DDL } from '../types.js';
import { enqueueOutbox } from '../repository.js';
import { OutboxRelay } from '../relay.js';
import { IdempotentConsumer } from '../consumer.js';

describe('Outbox Package', () => {
  let pool: pg.Pool;
  let bus: KafkaEventBus;

  before(async () => {
    pool = new Pool({
      connectionString:
        process.env['UPLOAD_DB_URL'] || 'postgres://upload:10273@localhost:5434/upload_db',
      max: 10,
    });

    bus = new KafkaEventBus({
      clientId: 'streamlite-outbox-test',
      brokers: ['localhost:19092'],
    });
    await bus.connectProducer();

    // Ensure test tables exist in the test DB
    await pool.query(OUTBOX_TABLE_DDL);
    await pool.query(PROCESSED_EVENTS_TABLE_DDL);
  });

  after(async () => {
    await bus.disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    // Clean tables before each test
    await pool.query('DELETE FROM outbox;');
    await pool.query('DELETE FROM processed_events;');
  });

  describe('Outbox Repository', () => {
    it('should enqueue an event with generated UUID, JSONB payload, and sent_at=null', async () => {
      const topic = 'test.outbox.enqueue';
      const key = randomUUID();
      const payload = { videoId: key, status: 'QUEUED' };

      const eventId = await enqueueOutbox(pool, topic, key, payload);
      assert.ok(eventId);

      const res = await pool.query<{
        id: string;
        topic: string;
        key: string;
        payload: { videoId: string; status: string };
        sent_at: Date | null;
      }>('SELECT * FROM outbox WHERE id = $1', [eventId]);

      assert.strictEqual(res.rows.length, 1);
      assert.strictEqual(res.rows[0]?.topic, topic);
      assert.strictEqual(res.rows[0]?.key, key);
      assert.strictEqual(res.rows[0]?.payload.videoId, key);
      assert.strictEqual(res.rows[0]?.sent_at, null);
    });
  });

  describe('Outbox Relay Worker (SKIP LOCKED & Batch Delivery)', () => {
    it('should drain unsent rows, publish to Kafka, and set sent_at=NOW()', async () => {
      const topic = `test.outbox.relay.${Date.now()}`;
      const count = 5;
      const ids: string[] = [];

      for (let i = 0; i < count; i++) {
        const id = await enqueueOutbox(pool, topic, `key_${i}`, { index: i });
        ids.push(id);
      }

      const relay = new OutboxRelay({
        pool,
        bus,
        batchSize: 10,
        pollIntervalMs: 200,
      });

      const processed = await relay.pollBatch();
      assert.strictEqual(processed, count);

      const check = await pool.query<{ id: string; sent_at: Date | null }>(
        'SELECT id, sent_at FROM outbox WHERE id = ANY($1::uuid[])',
        [ids],
      );

      assert.strictEqual(check.rows.length, count);
      for (const row of check.rows) {
        assert.ok(row.sent_at !== null, `Expected sent_at to be populated for row ${row.id}`);
      }
    });

    it('should allow two concurrent relay workers with SKIP LOCKED without collisions', async () => {
      const topic = `test.outbox.concurrent.${Date.now()}`;
      const totalRows = 10;
      const ids: string[] = [];

      for (let i = 0; i < totalRows; i++) {
        const id = await enqueueOutbox(pool, topic, `concurrency_key_${i}`, { index: i });
        ids.push(id);
      }

      const relayA = new OutboxRelay({ pool, bus, batchSize: 5 });
      const relayB = new OutboxRelay({ pool, bus, batchSize: 5 });

      // Run both workers concurrently
      const [countA, countB] = await Promise.all([relayA.pollBatch(), relayB.pollBatch()]);

      assert.strictEqual(countA + countB, totalRows);
      assert.ok(countA > 0);
      assert.ok(countB > 0);

      const unsent = await pool.query<{ count: string }>(
        'SELECT count(*) FROM outbox WHERE sent_at IS NULL',
      );
      assert.strictEqual(Number(unsent.rows[0]?.count), 0);
    });
  });

  describe('Idempotent Consumer', () => {
    it('should execute business logic on first receipt and record in processed_events', async () => {
      const consumerName = 'test-worker';
      const eventId = randomUUID();
      let executionCount = 0;

      const firstAttempt = await IdempotentConsumer.execute(
        pool,
        consumerName,
        eventId,
        async (client) => {
          executionCount++;
          const res = await client.query<{ now: Date }>('SELECT NOW() as now');
          return res.rows[0]?.now;
        },
      );

      assert.strictEqual(firstAttempt.processed, true);
      assert.ok(firstAttempt.result);
      assert.strictEqual(executionCount, 1);

      // Verify row in processed_events
      const row = await pool.query(
        'SELECT * FROM processed_events WHERE consumer = $1 AND event_id = $2',
        [consumerName, eventId],
      );
      assert.strictEqual(row.rows.length, 1);

      // Second attempt with the SAME event ID (duplicate delivery simulation)
      const secondAttempt = await IdempotentConsumer.execute(
        pool,
        consumerName,
        eventId,
        async () => {
          executionCount++;
          return 'should_not_run';
        },
      );

      assert.strictEqual(secondAttempt.processed, false);
      assert.strictEqual(secondAttempt.result, undefined);
      assert.strictEqual(executionCount, 1, 'Domain logic must NOT run on duplicate delivery');
    });

    it('should rollback transaction and not save processed_events when handler throws', async () => {
      const consumerName = 'test-worker-failing';
      const eventId = randomUUID();

      await assert.rejects(
        () =>
          IdempotentConsumer.execute(pool, consumerName, eventId, async () => {
            throw new Error('Database deadlocked');
          }),
        /Database deadlocked/,
      );

      const row = await pool.query(
        'SELECT * FROM processed_events WHERE consumer = $1 AND event_id = $2',
        [consumerName, eventId],
      );
      assert.strictEqual(row.rows.length, 0, 'Must not record event if transaction failed');
    });
  });
});
