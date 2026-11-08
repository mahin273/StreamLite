import pino, { type DestinationStream, type Logger, type LoggerOptions as PinoOptions } from 'pino';
import { getContext } from './context.js';

export const REDACT_PATHS = [
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.cookie',
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'headers.authorization',
  'headers.cookie',
];

export interface CreateLoggerOptions {
  serviceName?: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level =
    options.level || process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

  const pinoOptions: PinoOptions = {
    level,
    base: {
      service: options.serviceName || process.env.SERVICE_NAME || 'streamlite',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    mixin() {
      const ctx = getContext();
      if (!ctx) return {};
      return {
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
      };
    },
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

export const logger: Logger = createLogger();
export type { Logger } from 'pino';
