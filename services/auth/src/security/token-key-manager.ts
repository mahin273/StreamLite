import crypto from 'node:crypto';
import { Injectable, Inject, Optional } from '@nestjs/common';
import * as jose from 'jose';
import type { CryptoKey, JWK } from 'jose';
import type { AuthDatabase } from '../store/database.js';
import { AUTH_DB } from '../store/database.js';
import { AUTH_CONFIG, type AuthConfig } from '../config.js';

export type SigningKey = CryptoKey | Uint8Array;

export interface ActiveSigningKey {
  kid: string;
  privateKey: SigningKey;
  publicKey: SigningKey;
  publicJwk: JWK;
}

export interface JwksResponse {
  keys: JWK[];
}

@Injectable()
export class TokenKeyManager {
  private activeKeyCache: ActiveSigningKey | null = null;
  private readonly derivedSecretKey: Buffer;

  constructor(
    @Inject(AUTH_DB) private readonly db: AuthDatabase,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
  ) {
    const rawSecret =
      this.config?.keyEncryptionSecret ||
      process.env['AUTH_KEY_ENCRYPTION_SECRET'] ||
      'streamlite-signing-key-secret-32-chars-long!';
    this.derivedSecretKey = crypto.scryptSync(
      rawSecret,
      'streamlite-signing-salt',
      32,
    );
  }

  /**
   * Encrypts a PKCS8 private key string at rest using AES-256-GCM.
   * Payload format: [12-byte IV] + [16-byte AuthTag] + [Ciphertext]
   */
  public encryptPrivateKey(pkcs8Pem: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.derivedSecretKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(pkcs8Pem, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]);
  }

  /**
   * Decrypts an AES-256-GCM encrypted payload back to a PKCS8 private key string.
   */
  public decryptPrivateKey(encryptedBuffer: Buffer): string {
    const iv = encryptedBuffer.subarray(0, 12);
    const tag = encryptedBuffer.subarray(12, 28);
    const ciphertext = encryptedBuffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.derivedSecretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * Retrieves the currently active signing keypair, generating and persisting a new Ed25519
   * keypair if no unretired key exists in PostgreSQL.
   */
  public async getActiveSigningKey(): Promise<ActiveSigningKey> {
    if (this.activeKeyCache) {
      return this.activeKeyCache;
    }

    const row = await this.db
      .selectFrom('signing_keys')
      .selectAll()
      .where('retired_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (row) {
      const pkcs8Pem = this.decryptPrivateKey(row.private_key_enc);
      const privateKey = (await jose.importPKCS8(pkcs8Pem, 'EdDSA')) as SigningKey;
      const publicJwk = JSON.parse(row.public_key.toString('utf8')) as JWK;
      const publicKey = (await jose.importJWK(publicJwk, 'EdDSA')) as SigningKey;

      this.activeKeyCache = {
        kid: row.kid,
        privateKey,
        publicKey,
        publicJwk,
      };
      return this.activeKeyCache;
    }

    return this.rotateSigningKey();
  }

  /**
   * Generates a new Ed25519 signing keypair, persists it to signing_keys, and updates the cache.
   */
  public async rotateSigningKey(): Promise<ActiveSigningKey> {
    const kid = `k_${crypto.randomUUID()}`;
    const { publicKey, privateKey } = await jose.generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });

    const publicJwk = (await jose.exportJWK(publicKey)) as JWK;
    publicJwk.kid = kid;
    publicJwk.alg = 'EdDSA';
    publicJwk.use = 'sig';

    const pkcs8Pem = await jose.exportPKCS8(privateKey);
    const encrypted = this.encryptPrivateKey(pkcs8Pem);

    await this.db
      .insertInto('signing_keys')
      .values({
        kid,
        public_key: Buffer.from(JSON.stringify(publicJwk), 'utf8'),
        private_key_enc: encrypted,
      })
      .execute();

    this.activeKeyCache = {
      kid,
      privateKey,
      publicKey,
      publicJwk,
    };

    return this.activeKeyCache;
  }

  /**
   * Returns all active and valid public keys formatted as an RFC 7517 JWKS.
   */
  public async getPublicJwks(): Promise<JwksResponse> {
    // Ensure at least one active key exists
    await this.getActiveSigningKey();

    const rows = await this.db
      .selectFrom('signing_keys')
      .select(['kid', 'public_key'])
      .where('retired_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();

    const keys: JWK[] = rows.map((r) => {
      const jwk = JSON.parse(r.public_key.toString('utf8')) as JWK;
      return {
        ...jwk,
        kid: r.kid,
        use: 'sig',
        alg: 'EdDSA',
      };
    });

    return { keys };
  }

  /**
   * Invalidate the in-memory cache (e.g. for testing or after external rotation).
   */
  public clearCache(): void {
    this.activeKeyCache = null;
  }
}
