import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runWithContext } from '@streamlite/logger';
import {
  createEventEnvelope,
  createEventEnvelopeSchema,
  EventTopics,
  VideoUploadedEventDataSchema,
  type VideoUploadedEventData,
  DeadLetterEventDataSchema,
} from '../envelope.js';
import { KafkaEventBus } from '../bus.js';
import type { EventConsumer } from '../consumer.js';

describe('Events Package', () => {
  describe('Envelope Schema & Factory', () => {
    it('should generate a valid envelope with defaults and correlation traceId', async () => {
      runWithContext(
        { requestId: 'req_evt_test', traceId: 'test_trace_1234567890abcdef' },
        () => {
          const videoData: VideoUploadedEventData = {
            videoId: randomUUID(),
            ownerId: randomUUID(),
            rawS3Key: 'raw/videos/test.mp4',
            sizeBytes: 1048576,
            contentType: 'video/mp4',
          };

          const envelope = createEventEnvelope({
            type: EventTopics.VIDEO_UPLOADED,
            producer: 'upload-svc',
            data: videoData,
          });

          assert.strictEqual(envelope.type, EventTopics.VIDEO_UPLOADED);
          assert.strictEqual(envelope.producer, 'upload-svc');
          assert.strictEqual(envelope.version, 1);
          assert.strictEqual(envelope.traceId, 'test_trace_1234567890abcdef');
          assert.ok(envelope.id);
          assert.ok(envelope.occurredAt);

          const schema = createEventEnvelopeSchema(VideoUploadedEventDataSchema);
          const parsed = schema.parse(envelope);
          assert.deepStrictEqual(parsed.data, videoData);
        },
      );
    });

    it('should reject envelope if domain data does not conform to schema', () => {
      const invalidData = {
        videoId: 'not-a-uuid',
        sizeBytes: -10,
      };

      const envelope = createEventEnvelope({
        type: EventTopics.VIDEO_UPLOADED,
        producer: 'upload-svc',
        data: invalidData,
      });

      const schema = createEventEnvelopeSchema(VideoUploadedEventDataSchema);
      assert.throws(() => schema.parse(envelope));
    });
  });

  describe('Redpanda Integration Spike', () => {
    let bus: KafkaEventBus;
    const testTopic = `test.video.uploaded.${Date.now()}`;
    const testGroupId = `test-group-${Date.now()}`;
    let consumer: EventConsumer | null = null;

    before(async () => {
      bus = new KafkaEventBus({
        clientId: 'streamlite-events-test',
        brokers: ['localhost:19092'],
      });
      await bus.connectProducer();
    });

    after(async () => {
      if (consumer) {
        await consumer.disconnect();
      }
      await bus.disconnect();
    });

    it('should publish and consume an event with traceparent and entity key', async () => {
      const videoId = randomUUID();
      const videoData: VideoUploadedEventData = {
        videoId,
        ownerId: randomUUID(),
        rawS3Key: 'raw/videos/spike.mp4',
        sizeBytes: 2048,
        contentType: 'video/mp4',
      };

      const envelope = createEventEnvelope({
        type: EventTopics.VIDEO_UPLOADED,
        producer: 'upload-svc',
        data: videoData,
        traceId: 'abcd1234efgh5678ijkl9012mnop3456',
      });

      consumer = bus.createConsumer({
        groupId: testGroupId,
        fromBeginning: true,
      });
      await consumer.connect();
      await consumer.subscribe(testTopic);

      const receivedPromise = new Promise<{
        id: string;
        key: string | null;
        traceparent: string | undefined;
      }>((resolve) => {
        void consumer!.run(async (receivedEnvelope, ctx) => {
          resolve({
            id: receivedEnvelope.id,
            key: ctx.rawMessage.key ? ctx.rawMessage.key.toString() : null,
            traceparent: ctx.rawMessage.headers?.['traceparent']?.toString(),
          });
        });
      });

      // Allow consumer group rebalance
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await bus.publish(testTopic, videoId, envelope);

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for Kafka event consumption')), 10000),
        ),
      ]);

      assert.strictEqual(received.id, envelope.id);
      assert.strictEqual(received.key, videoId);
      assert.ok(received.traceparent?.startsWith('00-'));
    });

    it('should route poison pill message to DLQ after exceeding max retries', async () => {
      const poisonTopic = `test.poison.${Date.now()}`;
      const dlqTopic = EventTopics.dlqFor(poisonTopic);
      const dlqGroupId = `dlq-consumer-${Date.now()}`;
      const workerGroupId = `poison-worker-${Date.now()}`;

      // 1. Setup DLQ consumer listening for forwarded dead letter messages
      const dlqConsumer = bus.createConsumer({
        groupId: dlqGroupId,
        fromBeginning: true,
      });
      await dlqConsumer.connect();
      await dlqConsumer.subscribe(dlqTopic);

      const dlqPromise = new Promise<{ originalTopic: string; error: string }>((resolve) => {
        void dlqConsumer.run(async (dlqEnvelope) => {
          const parsed = DeadLetterEventDataSchema.parse(dlqEnvelope.data);
          resolve({
            originalTopic: parsed.originalTopic,
            error: parsed.error,
          });
        });
      });

      // 2. Setup worker consumer that intentionally fails handler
      const failingConsumer = bus.createConsumer({
        groupId: workerGroupId,
        fromBeginning: true,
        maxRetries: 2,
        dlqEnabled: true,
      });
      await failingConsumer.connect();
      await failingConsumer.subscribe(poisonTopic);

      void failingConsumer.run(async () => {
        throw new Error('Simulated database write failure');
      });

      // Allow group rebalances
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const poisonEnvelope = createEventEnvelope({
        type: 'test.poison.event',
        producer: 'test-suite',
        data: { broken: true },
      });

      await bus.publish(poisonTopic, 'poison_key_1', poisonEnvelope);

      const dlqResult = await Promise.race([
        dlqPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for DLQ message')), 12000),
        ),
      ]);

      assert.strictEqual(dlqResult.originalTopic, poisonTopic);
      assert.strictEqual(dlqResult.error, 'Simulated database write failure');

      await failingConsumer.disconnect();
      await dlqConsumer.disconnect();
    });
  });
});
