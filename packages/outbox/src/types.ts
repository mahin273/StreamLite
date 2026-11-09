export interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: unknown;
  trace_id: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export interface ProcessedEventRow {
  consumer: string;
  event_id: string;
  processed_at: Date;
}

export interface EnqueueOutboxOptions {
  id?: string | undefined;
  traceId?: string | undefined;
}

export const OUTBOX_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    trace_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_unsent ON outbox (id ASC) WHERE sent_at IS NULL;
`;

export const PROCESSED_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS processed_events (
    consumer VARCHAR(255) NOT NULL,
    event_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (consumer, event_id)
);
`;
