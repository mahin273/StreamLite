import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getTraceId, getRequestId } from '@streamlite/logger';
import type { EnqueueOutboxOptions } from './types.js';

export async function enqueueOutbox(
  db: Pool | PoolClient,
  topic: string,
  key: string,
  payload: unknown,
  options?: EnqueueOutboxOptions,
): Promise<string> {
  const id = options?.id || randomUUID();
  const traceId =
    options?.traceId ||
    getTraceId() ||
    getRequestId() ||
    null;

  const serializedPayload =
    typeof payload === 'string' ? payload : JSON.stringify(payload);

  const query = `
    INSERT INTO outbox (id, topic, key, payload, trace_id, created_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
    RETURNING id;
  `;

  const result = await db.query<{ id: string }>(query, [
    id,
    topic,
    key,
    serializedPayload,
    traceId,
  ]);

  return result.rows[0]?.id ?? id;
}
