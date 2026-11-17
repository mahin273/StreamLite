import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { TokenKeyManager, type JwksResponse } from '../security/token-key-manager.js';

@Controller('.well-known')
export class JwksController {
  constructor(private readonly keyManager: TokenKeyManager) {}

  /**
   * RFC 7517 JSON Web Key Set (JWKS) public discovery endpoint.
   * Exposes active and valid Ed25519 public keys for zero-latency local token verification
   * by downstream microservices.
   */
  @Get('jwks.json')
  @HttpCode(HttpStatus.OK)
  async getJwks(): Promise<JwksResponse> {
    return this.keyManager.getPublicJwks();
  }
}
