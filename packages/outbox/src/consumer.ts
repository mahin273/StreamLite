import type { Pool, PoolClient } from 'pg';
import { logger } from '@streamlite/logger';

export interface IdempotentExecutionResult<T> {
  processed: boolean;
  result?: T | undefined;
}

export class IdempotentConsumer {
  static async execute<T>(
    pool: Pool,
    consumerName: string,
    eventId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<IdempotentExecutionResult<T>> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const dedupQuery = `
        INSERT INTO processed_events (consumer, event_id, processed_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (consumer, event_id) DO NOTHING
        RETURNING event_id;
      `;

      const dedupResult = await client.query<{ event_id: string }>(dedupQuery, [
        consumerName,
        eventId,
      ]);

      if (dedupResult.rows.length === 0) {
        // Event was already processed previously
        await client.query('ROLLBACK');
        logger.debug(
          { consumer: consumerName, eventId },
          'Duplicate event detected; skipping domain handler execution',
        );
        return { processed: false };
      }

      const result = await fn(client);

      await client.query('COMMIT');
      logger.debug(
        { consumer: consumerName, eventId },
        'Successfully processed event atomically with dedup record',
      );
      return { processed: true, result };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ rollbackErr }, 'Failed to rollback transaction during consumer error');
      }
      logger.error(
        { consumer: consumerName, eventId, err },
        'Consumer handler threw exception; transaction rolled back',
      );
      throw err;
    } finally {
      client.release();
    }
  }
}
