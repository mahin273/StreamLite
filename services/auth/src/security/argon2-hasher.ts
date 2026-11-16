import { Injectable, Optional, Inject } from '@nestjs/common';
import argon2 from 'argon2';
import { AsyncSemaphore } from './semaphore.js';

export const ARGON2_OPTIONS = 'ARGON2_OPTIONS';

export interface Argon2Options {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
  maxConcurrent?: number;
}

const DEFAULT_ARGON2_OPTIONS: Required<Omit<Argon2Options, 'maxConcurrent'>> = {
  memoryCost: 65536, // 64 MiB (Design_Doc.md Section 7.2)
  timeCost: 3,
  parallelism: 2,
};

// Known dummy password for anti-enumeration constant-time equalization
const DUMMY_PASSWORD = 'StreamLiteAntiEnumerationDummyPassword#2026';

@Injectable()
export class Argon2Hasher {
  private readonly semaphore: AsyncSemaphore;
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;

  constructor(@Optional() @Inject(ARGON2_OPTIONS) options?: Argon2Options) {
    this.semaphore = new AsyncSemaphore(options?.maxConcurrent ?? 4);

    // In unit/integration tests, allow lightweight options if specified or under test env
    if (process.env['NODE_ENV'] === 'test' && !options?.memoryCost) {
      this.memoryCost = 4096; // 4 MiB in test mode for instant test suite execution
      this.timeCost = 1;
      this.parallelism = 1;
    } else {
      this.memoryCost = options?.memoryCost ?? DEFAULT_ARGON2_OPTIONS.memoryCost;
      this.timeCost = options?.timeCost ?? DEFAULT_ARGON2_OPTIONS.timeCost;
      this.parallelism = options?.parallelism ?? DEFAULT_ARGON2_OPTIONS.parallelism;
    }
  }

  get semaphoreInstance(): AsyncSemaphore {
    return this.semaphore;
  }

  async hash(password: string): Promise<string> {
    return this.semaphore.run(async () => {
      return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: this.memoryCost,
        timeCost: this.timeCost,
        parallelism: this.parallelism,
      });
    });
  }

  async verify(hash: string, plainText: string): Promise<boolean> {
    return this.semaphore.run(async () => {
      try {
        return await argon2.verify(hash, plainText);
      } catch {
        return false;
      }
    });
  }

  /**
   * Runs a dummy hash calculation using the exact same Argon2id parameters.
   * Equalizes execution timing on anti-enumeration code paths so attackers cannot
   * detect whether an email exists via response latency differences.
   */
  async hashDummy(): Promise<string> {
    return this.hash(DUMMY_PASSWORD);
  }
}
