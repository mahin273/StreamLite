import { Injectable, Inject, Optional } from '@nestjs/common';
import * as jose from 'jose';
import type { JWTPayload } from 'jose';
import { TokenKeyManager } from './token-key-manager.js';
import { AUTH_CONFIG, type AuthConfig } from '../config.js';

export interface AccountTokenClaims {
  userId: string;
  role: string;
  emailVerified: boolean;
  sessionId: string;
}

export interface ProfileTokenClaims extends AccountTokenClaims {
  profileId: string;
  ageLimit: number;
}

export interface IssuedToken {
  token: string;
  expiresIn: number;
}

export interface StreamLiteJwtPayload extends JWTPayload {
  sub: string;
  role: string;
  email_verified: boolean;
  sid: string;
  pid?: string;
  age?: number;
}

@Injectable()
export class JwtService {
  constructor(
    private readonly keyManager: TokenKeyManager,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
  ) {}

  /**
   * Issues a 10-minute Account-Scoped Ed25519 JWT.
   * Claims: sub (userId), role, email_verified, sid (sessionId), iss, aud, iat, exp.
   */
  public async issueAccountToken(claims: AccountTokenClaims): Promise<IssuedToken> {
    const activeKey = await this.keyManager.getActiveSigningKey();
    const issuer = this.config?.jwtIssuer || 'streamlite-auth';
    const audience = this.config?.jwtAudience || 'streamlite-api';
    const expiresInString = this.config?.jwtExpiresIn || '10m';

    const token = await new jose.SignJWT({
      role: claims.role,
      email_verified: claims.emailVerified,
      sid: claims.sessionId,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: activeKey.kid })
      .setSubject(claims.userId)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiresInString)
      .sign(activeKey.privateKey);

    return {
      token,
      expiresIn: 600, // 10 minutes in seconds
    };
  }

  /**
   * Issues a 10-minute Profile-Scoped Ed25519 JWT.
   * Injects pid (profileId) and age (ageLimit) into the claims.
   */
  public async issueProfileToken(claims: ProfileTokenClaims): Promise<IssuedToken> {
    const activeKey = await this.keyManager.getActiveSigningKey();
    const issuer = this.config?.jwtIssuer || 'streamlite-auth';
    const audience = this.config?.jwtAudience || 'streamlite-api';
    const expiresInString = this.config?.jwtExpiresIn || '10m';

    const token = await new jose.SignJWT({
      role: claims.role,
      email_verified: claims.emailVerified,
      sid: claims.sessionId,
      pid: claims.profileId,
      age: claims.ageLimit,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: activeKey.kid })
      .setSubject(claims.userId)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiresInString)
      .sign(activeKey.privateKey);

    return {
      token,
      expiresIn: 600,
    };
  }

  /**
   * Cryptographically verifies an incoming JWT using public keys from the KeyManager.
   */
  public async verifyToken(token: string): Promise<StreamLiteJwtPayload> {
    const issuer = this.config?.jwtIssuer || 'streamlite-auth';
    const audience = this.config?.jwtAudience || 'streamlite-api';

    const { payload } = await jose.jwtVerify(
      token,
      async (header) => {
        const activeKey = await this.keyManager.getActiveSigningKey();
        if (header.kid === activeKey.kid) {
          return activeKey.publicKey;
        }

        const jwks = await this.keyManager.getPublicJwks();
        const matchingKey = jwks.keys.find((k) => k.kid === header.kid);
        if (!matchingKey) {
          throw new Error(`Public key with kid '${header.kid}' was not found in JWKS`);
        }

        return jose.importJWK(matchingKey, 'EdDSA');
      },
      {
        issuer,
        audience,
        clockTolerance: 15, // 15 seconds clock skew tolerance
      },
    );

    return payload as StreamLiteJwtPayload;
  }
}
