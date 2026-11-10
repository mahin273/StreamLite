import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export * from './catalog/v1/catalog.js';
export * from './watch/v1/watch.js';

export const ProtoPackages = {
  CATALOG_V1: 'catalog.v1',
  WATCH_V1: 'watch.v1',
} as const;

export function getProtoPath(service: 'catalog' | 'watch', version: 'v1' = 'v1'): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // In dev / build: resolve relative to monorepo root
  const candidates = [
    resolve(currentDir, `../../../../proto/${service}/${version}/${service}.proto`),
    resolve(currentDir, `../../../proto/${service}/${version}/${service}.proto`),
    resolve(process.cwd(), `proto/${service}/${version}/${service}.proto`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback default
  return resolve(process.cwd(), `proto/${service}/${version}/${service}.proto`);
}
