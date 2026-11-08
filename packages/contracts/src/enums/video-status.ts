import { z } from 'zod';

export const VideoStatusEnum = z.enum(['draft', 'uploaded', 'transcoding', 'ready', 'failed']);

export type VideoStatus = z.infer<typeof VideoStatusEnum>;
