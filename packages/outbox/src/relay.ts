import type { Pool } from 'pg';
import { logger } from '@streamlite/logger';
import type { KafkaEventBus, BatchRecord } from '@streamlite/events';
import type { OutboxRow } from './types.js';

export interface OutboxRelayOptions {
  pool: Pool;
  bus: KafkaEventBus;
  batchSize?: number | undefined;
  pollIntervalMs?: number | undefined;
  maxWaitAfterBatchMs?: number | undefined;
}

export class OutboxRelay {
  private readonly pool: Pool;
  private readonly bus: KafkaEventBus;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxWaitAfterBatchMs: number;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activePollPromise: Promise<number> | null = null;

  constructor(options: OutboxRelayOptions) {
    this.pool = options.pool;
    this.bus = options.bus;
    this.batchSize = options.batchSize ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxWaitAfterBatchMs = options.maxWaitAfterBatchMs ?? 50;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(
      { batchSize: this.batchSize, pollIntervalMs: this.pollIntervalMs },
      'Started Outbox Relay worker',
    );
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      try {
        this.activePollPromise = this.pollBatch();
        const processedCount = await this.activePollPromise;
        const nextDelay =
          processedCount >= this.batchSize
            ? this.maxWaitAfterBatchMs
            : this.pollIntervalMs;
        this.scheduleNext(nextDelay);
      } catch (err) {
        logger.error({ err }, 'Unhandled error in Outbox Relay cycle');
        this.scheduleNext(this.pollIntervalMs);
      } finally {
        this.activePollPromise = null;
      }
    }, delayMs);
  }

  async pollBatch(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const selectQuery = `
        SELECT id, topic, key, payload, trace_id
        FROM outbox
        WHERE sent_at IS NULL
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `;

      const result = await client.query<OutboxRow>(selectQuery, [this.batchSize]);
      const rows = result.rows;

      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const records: BatchRecord[] = rows.map((row) => ({
        topic: row.topic,
        key: row.key,
        value: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
        headers: {
          'x-event-id': row.id,
          ...(row.trace_id ? { traceparent: row.trace_id } : {}),
        },
      }));

      await this.bus.publishBatch(records);

      const ids = rows.map((r) => r.id);
      const updateQuery = `
        UPDATE outbox
        SET sent_at = NOW()
        WHERE id = ANY($1::uuid[]);
      `;
      await client.query(updateQuery, [ids]);

      await client.query('COMMIT');
      logger.debug({ count: rows.length }, 'Dispatched outbox batch to Kafka');
      return rows.length;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ rollbackErr }, 'Failed to rollback transaction during relay failure');
      }
      logger.error({ err }, 'Failed to process outbox batch, will retry next tick');
      return 0;
    } finally {
      client.release();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activePollPromise) {
      await this.activePollPromise;
    }
    logger.info('Stopped Outbox Relay worker');
  }
}
