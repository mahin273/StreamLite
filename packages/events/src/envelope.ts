import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getTraceId, getRequestId } from '@streamlite/logger';

export const EventTopics = {
  VIDEO_UPLOADED: 'video.uploaded',
  VIDEO_TRANSCODED: 'video.transcoded',
  VIDEO_TRANSCODE_FAILED: 'video.transcode_failed',
  TITLE_PUBLISHED: 'title.published',
  TITLE_UPDATED: 'title.updated',
  TITLE_ARCHIVED: 'title.archived',
  WATCH_EVENTS: 'watch.events',
  RATING_CHANGED: 'rating.changed',
  MYLIST_CHANGED: 'mylist.changed',
  USER_DELETED: 'user.deleted',
  dlqFor: (topic: string): string => `${topic}.dlq`,
} as const;

export type EventTopic =
  | (typeof EventTopics)[keyof Omit<typeof EventTopics, 'dlqFor'>]
  | `${string}.dlq`;

export function createEventEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    id: z.string().uuid(),
    type: z.string().min(1),
    version: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    producer: z.string().min(1),
    traceId: z.string().min(1),
    data: dataSchema,
  });
}

export type EventEnvelope<T = unknown> = {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  producer: string;
  traceId: string;
  data: T;
};

export const GenericEventEnvelopeSchema = createEventEnvelopeSchema(z.unknown());

export interface CreateEventOptions<T> {
  type: string;
  producer: string;
  data: T;
  version?: number | undefined;
  id?: string | undefined;
  traceId?: string | undefined;
  occurredAt?: string | undefined;
}

export function createEventEnvelope<T>(options: CreateEventOptions<T>): EventEnvelope<T> {
  const traceId =
    options.traceId ||
    getTraceId() ||
    getRequestId() ||
    randomUUID().replace(/-/g, '');

  return {
    id: options.id || randomUUID(),
    type: options.type,
    version: options.version ?? 1,
    occurredAt: options.occurredAt || new Date().toISOString(),
    producer: options.producer,
    traceId,
    data: options.data,
  };
}

// ---------------------------------------------------------------------------
// Domain Event Data Schemas (Design_Doc.md Section 9)
// ---------------------------------------------------------------------------

export const VideoUploadedEventDataSchema = z.object({
  videoId: z.string().uuid(),
  ownerId: z.string().uuid(),
  rawS3Key: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});
export type VideoUploadedEventData = z.infer<typeof VideoUploadedEventDataSchema>;

export const RenditionMetadataSchema = z.object({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
  bitrate: z.number().int().positive(),
  playlistKey: z.string().min(1),
});
export type RenditionMetadata = z.infer<typeof RenditionMetadataSchema>;

export const VideoTranscodedEventDataSchema = z.object({
  videoId: z.string().uuid(),
  durationSeconds: z.number().nonnegative(),
  renditions: z.array(RenditionMetadataSchema).min(1),
  posterKey: z.string().min(1),
  spriteKey: z.string().optional(),
  masterPlaylistKey: z.string().min(1),
});
export type VideoTranscodedEventData = z.infer<typeof VideoTranscodedEventDataSchema>;

export const VideoTranscodeFailedEventDataSchema = z.object({
  videoId: z.string().uuid(),
  reason: z.string().min(1),
  attempts: z.number().int().positive(),
});
export type VideoTranscodeFailedEventData = z.infer<typeof VideoTranscodeFailedEventDataSchema>;

export const TitlePublishedEventDataSchema = z.object({
  titleId: z.string().uuid(),
  type: z.enum(['MOVIE', 'SERIES']),
  genres: z.array(z.string()),
  publishedAt: z.string().datetime().optional(),
});
export type TitlePublishedEventData = z.infer<typeof TitlePublishedEventDataSchema>;

export const WatchEventDataSchema = z.object({
  profileId: z.string().uuid(),
  videoId: z.string().uuid(),
  titleId: z.string().uuid(),
  eventType: z.enum(['PLAY_STARTED', 'COMPLETED', 'STOPPED']),
  positionSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  occurredAt: z.string().datetime(),
});
export type WatchEventData = z.infer<typeof WatchEventDataSchema>;

export const RatingChangedEventDataSchema = z.object({
  profileId: z.string().uuid(),
  titleId: z.string().uuid(),
  score: z.number().int().min(1).max(5),
});
export type RatingChangedEventData = z.infer<typeof RatingChangedEventDataSchema>;

export const MyListChangedEventDataSchema = z.object({
  profileId: z.string().uuid(),
  titleId: z.string().uuid(),
  action: z.enum(['ADDED', 'REMOVED']),
});
export type MyListChangedEventData = z.infer<typeof MyListChangedEventDataSchema>;

export const UserDeletedEventDataSchema = z.object({
  userId: z.string().uuid(),
  deletedAt: z.string().datetime(),
});
export type UserDeletedEventData = z.infer<typeof UserDeletedEventDataSchema>;

export const DeadLetterEventDataSchema = z.object({
  originalTopic: z.string(),
  originalKey: z.string().nullable().optional(),
  originalPayload: z.unknown(),
  error: z.string(),
  stack: z.string().optional(),
  attempts: z.number().int().positive(),
  failedAt: z.string().datetime(),
});
export type DeadLetterEventData = z.infer<typeof DeadLetterEventDataSchema>;
