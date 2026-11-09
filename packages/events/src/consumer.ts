import {
  type Consumer,
  type EachMessagePayload,
  type Kafka,
  type KafkaMessage,
} from 'kafkajs';
import { logger } from '@streamlite/logger';
import {
  createEventEnvelope,
  EventTopics,
  type DeadLetterEventData,
  type EventEnvelope,
} from './envelope.js';
import type { KafkaEventBus } from './bus.js';

export interface ConsumerOptions {
  groupId: string;
  fromBeginning?: boolean | undefined;
  maxRetries?: number | undefined;
  dlqEnabled?: boolean | undefined;
}

export type EventHandler<T = unknown> = (
  event: EventEnvelope<T>,
  context: {
    topic: string;
    partition: number;
    offset: string;
    rawMessage: KafkaMessage;
  },
) => Promise<void>;

export class EventConsumer {
  private readonly consumer: Consumer;
  private readonly bus: KafkaEventBus;
  private readonly maxRetries: number;
  private readonly dlqEnabled: boolean;
  private readonly fromBeginning: boolean;
  private readonly retryMap = new Map<string, number>();
  private isRunning = false;

  constructor(kafka: Kafka, bus: KafkaEventBus, options: ConsumerOptions) {
    this.bus = bus;
    this.maxRetries = options.maxRetries ?? 3;
    this.dlqEnabled = options.dlqEnabled ?? true;
    this.fromBeginning = options.fromBeginning ?? false;

    this.consumer = kafka.consumer({
      groupId: options.groupId,
      allowAutoTopicCreation: true,
      retry: {
        retries: 5,
        initialRetryTime: 300,
      },
    });
  }

  async connect(): Promise<void> {
    await this.consumer.connect();
  }

  async subscribe(topics: string | string[]): Promise<void> {
    const topicList = Array.isArray(topics) ? topics : [topics];
    for (const topic of topicList) {
      await this.consumer.subscribe({ topic, fromBeginning: this.fromBeginning });
    }
  }

  async run(handler: EventHandler): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.consumer.run({
      autoCommit: true,
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const msgKey = message.key?.toString() ?? null;
        const offset = message.offset;
        const retryKey = `${topic}:${partition}:${offset}`;

        let parsedEnvelope: EventEnvelope<unknown> | null = null;
        try {
          const rawValue = message.value?.toString('utf-8');
          if (!rawValue) {
            logger.warn({ topic, partition, offset }, 'Received empty Kafka message body');
            return;
          }
          parsedEnvelope = JSON.parse(rawValue) as EventEnvelope<unknown>;
        } catch (parseErr) {
          logger.error(
            { parseErr, topic, partition, offset },
            'Failed to parse JSON message payload from Kafka',
          );
          if (this.dlqEnabled) {
            await this.sendToDeadLetterQueue(
              topic,
              msgKey,
              message.value?.toString('utf-8'),
              parseErr instanceof Error ? parseErr.message : String(parseErr),
              parseErr instanceof Error ? parseErr.stack : undefined,
              1,
            );
          }
          return;
        }

        try {
          await handler(parsedEnvelope, {
            topic,
            partition,
            offset,
            rawMessage: message,
          });
          this.retryMap.delete(retryKey);
        } catch (handlerErr) {
          const currentAttempts = (this.retryMap.get(retryKey) || 0) + 1;
          this.retryMap.set(retryKey, currentAttempts);

          const errorMessage =
            handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
          const errorStack = handlerErr instanceof Error ? handlerErr.stack : undefined;

          logger.warn(
            {
              topic,
              partition,
              offset,
              eventId: parsedEnvelope.id,
              attempts: currentAttempts,
              maxRetries: this.maxRetries,
              err: handlerErr,
            },
            'Event handler threw error',
          );

          if (currentAttempts >= this.maxRetries && this.dlqEnabled) {
            logger.error(
              {
                topic,
                partition,
                offset,
                eventId: parsedEnvelope.id,
                attempts: currentAttempts,
              },
              'Message exceeded max retries; routing to DLQ',
            );

            await this.sendToDeadLetterQueue(
              topic,
              msgKey,
              parsedEnvelope,
              errorMessage,
              errorStack,
              currentAttempts,
            );

            this.retryMap.delete(retryKey);
            return;
          }

          throw handlerErr;
        }
      },
    });
  }

  private async sendToDeadLetterQueue(
    originalTopic: string,
    originalKey: string | null,
    originalPayload: unknown,
    error: string,
    stack: string | undefined,
    attempts: number,
  ): Promise<void> {
    const dlqTopic = EventTopics.dlqFor(originalTopic);
    const dlqData: DeadLetterEventData = {
      originalTopic,
      originalKey,
      originalPayload,
      error,
      attempts,
      failedAt: new Date().toISOString(),
      ...(stack ? { stack } : {}),
    };

    const dlqEnvelope = createEventEnvelope<DeadLetterEventData>({
      type: `${originalTopic}.dead_letter`,
      producer: 'event-consumer-dlq',
      data: dlqData,
    });

    try {
      await this.bus.publish(dlqTopic, originalKey || dlqEnvelope.id, dlqEnvelope);
      logger.info({ dlqTopic, originalTopic, originalKey }, 'Message successfully routed to DLQ');
    } catch (dlqErr) {
      logger.error({ dlqErr, dlqTopic, originalTopic }, 'Fatal: Failed to publish message to DLQ');
    }
  }

  async disconnect(): Promise<void> {
    this.isRunning = false;
    await this.consumer.disconnect();
  }
}
