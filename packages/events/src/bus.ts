import { randomBytes } from 'node:crypto';
import { Kafka, type Producer, type TopicMessages } from 'kafkajs';
import { logger } from '@streamlite/logger';
import { loadKafkaConfig, type KafkaConfig } from './config.js';
import { type EventEnvelope } from './envelope.js';
import { EventConsumer, type ConsumerOptions } from './consumer.js';

export interface BatchRecord {
  topic: string;
  key: string;
  value: string;
  headers?: Record<string, string> | undefined;
}

export class KafkaEventBus {
  public readonly config: KafkaConfig;
  public readonly kafka: Kafka;
  private producer: Producer | null = null;
  private isProducerConnecting = false;
  private readonly consumers: Set<EventConsumer> = new Set();

  constructor(configOverrides?: Partial<KafkaConfig>) {
    this.config = loadKafkaConfig(configOverrides);
    this.kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      connectionTimeout: this.config.connectionTimeout,
      requestTimeout: this.config.requestTimeout,
      retry: {
        maxRetryTime: 30000,
        initialRetryTime: 300,
        retries: this.config.retryMaxAttempts,
      },
    });
  }

  async connectProducer(): Promise<void> {
    if (this.producer) return;
    if (this.isProducerConnecting) {
      while (this.isProducerConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }

    this.isProducerConnecting = true;
    try {
      this.producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: true,
      });

      await this.producer.connect();
      logger.info(
        { clientId: this.config.clientId, brokers: this.config.brokers },
        'Connected Kafka idempotent producer',
      );
    } catch (err) {
      logger.error({ err, brokers: this.config.brokers }, 'Failed to connect Kafka producer');
      this.producer = null;
      throw err;
    } finally {
      this.isProducerConnecting = false;
    }
  }

  private formatTraceparent(rawTraceId: string): string {
    const clean = rawTraceId.replace(/[^a-f0-9]/gi, '').toLowerCase();
    const traceId32 = clean.padEnd(32, '0').slice(0, 32);
    const spanId16 = randomBytes(8).toString('hex');
    return `00-${traceId32}-${spanId16}-01`;
  }

  async publish<T>(topic: string, key: string, envelope: EventEnvelope<T>): Promise<void> {
    if (!this.producer) {
      await this.connectProducer();
    }

    const value = JSON.stringify(envelope);
    const traceparent = this.formatTraceparent(envelope.traceId);

    try {
      await this.producer!.send({
        topic,
        acks: -1,
        messages: [
          {
            key,
            value,
            headers: {
              traceparent,
              'x-event-id': envelope.id,
              'x-event-type': envelope.type,
              'x-producer': envelope.producer,
            },
          },
        ],
      });
    } catch (err) {
      logger.error({ err, topic, key, eventId: envelope.id }, 'Failed to publish event to Kafka');
      throw err;
    }
  }

  async publishBatch(records: BatchRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (!this.producer) {
      await this.connectProducer();
    }

    const byTopic = new Map<string, TopicMessages['messages']>();

    for (const rec of records) {
      const existing = byTopic.get(rec.topic) || [];
      existing.push({
        key: rec.key,
        value: rec.value,
        ...(rec.headers ? { headers: rec.headers } : {}),
      });
      byTopic.set(rec.topic, existing);
    }

    const topicMessages: TopicMessages[] = [];
    for (const [topic, messages] of byTopic.entries()) {
      topicMessages.push({ topic, messages });
    }

    try {
      await this.producer!.sendBatch({
        acks: -1,
        topicMessages,
      });
    } catch (err) {
      logger.error(
        { err, recordCount: records.length },
        'Failed to publish batch of records to Kafka',
      );
      throw err;
    }
  }

  createConsumer(options: ConsumerOptions): EventConsumer {
    const consumer = new EventConsumer(this.kafka, this, options);
    this.consumers.add(consumer);
    return consumer;
  }

  async disconnect(): Promise<void> {
    for (const consumer of this.consumers) {
      try {
        await consumer.disconnect();
      } catch (err) {
        logger.warn({ err }, 'Error disconnecting consumer');
      }
    }
    this.consumers.clear();

    if (this.producer) {
      try {
        await this.producer.disconnect();
        logger.info('Disconnected Kafka producer');
      } catch (err) {
        logger.warn({ err }, 'Error disconnecting Kafka producer');
      }
      this.producer = null;
    }
  }
}
