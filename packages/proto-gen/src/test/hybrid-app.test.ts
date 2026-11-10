import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { GrpcMethod, type MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  ProtoPackages,
  getProtoPath,
  type CheckVideoOwnershipRequest,
  type CheckVideoOwnershipResponse,
  type CatalogServiceController,
} from '../index.js';

interface DynamicGrpcClient {
  checkVideoOwnership: (
    req: CheckVideoOwnershipRequest,
    callback: (err: grpc.ServiceError | null, response: CheckVideoOwnershipResponse) => void,
  ) => void;
  close: () => void;
}

@Controller()
class HttpHealthController {
  @Get('/healthz')
  getHealth() {
    return { status: 'ok', service: 'hybrid-spike' };
  }
}

@Controller()
class CatalogGrpcController implements CatalogServiceController {
  @GrpcMethod('CatalogService', 'CheckVideoOwnership')
  checkVideoOwnership(data: CheckVideoOwnershipRequest): CheckVideoOwnershipResponse {
    const isOwner = data.userId === 'usr_owner_456';
    return {
      isOwner,
      status: isOwner ? 'READY' : 'UNAUTHORIZED',
    };
  }

  @GrpcMethod('CatalogService', 'GetPlayableVideo')
  getPlayableVideo(): never {
    throw new Error('Not implemented in spike');
  }

  @GrpcMethod('CatalogService', 'GetNextEpisode')
  getNextEpisode(): never {
    throw new Error('Not implemented in spike');
  }

  @GrpcMethod('CatalogService', 'BatchGetTitleCards')
  batchGetTitleCards(): never {
    throw new Error('Not implemented in spike');
  }
}

@Module({
  controllers: [HttpHealthController, CatalogGrpcController],
})
class TestHybridModule {}

describe('Hybrid NestJS (Fastify + gRPC) Application Spike', () => {
  let app: NestFastifyApplication;
  let httpUrl: string;
  const grpcPort = 50061;
  const grpcHost = `127.0.0.1:${grpcPort}`;
  let grpcClient: DynamicGrpcClient;

  before(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      TestHybridModule,
      new FastifyAdapter(),
      { logger: false },
    );

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: ProtoPackages.CATALOG_V1,
        protoPath: getProtoPath('catalog', 'v1'),
        url: grpcHost,
      },
    });

    await app.startAllMicroservices();
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    httpUrl = `http://127.0.0.1:${port}`;

    // Create client stub for testing
    const protoPath = getProtoPath('catalog', 'v1');
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      catalog: {
        v1: {
          CatalogService: new (
            address: string,
            creds: grpc.ChannelCredentials,
          ) => DynamicGrpcClient;
        };
      };
    };
    const CatalogService = protoDescriptor.catalog.v1.CatalogService;
    grpcClient = new CatalogService(grpcHost, grpc.credentials.createInsecure());
  });

  after(async () => {
    if (grpcClient) {
      grpcClient.close();
    }
    if (app) {
      await app.close();
    }
  });

  it('should serve Fastify HTTP /healthz on the web port', async () => {
    const res = await fetch(`${httpUrl}/healthz`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'hybrid-spike');
  });

  it('should execute binary gRPC CheckVideoOwnership over the gRPC port', async () => {
    const checkOwnership = (
      req: CheckVideoOwnershipRequest,
    ): Promise<CheckVideoOwnershipResponse> => {
      return new Promise((resolve, reject) => {
        grpcClient.checkVideoOwnership(
          req,
          (err: grpc.ServiceError | null, response: CheckVideoOwnershipResponse) => {
            if (err) return reject(err);
            resolve(response);
          },
        );
      });
    };

    const successRes = await checkOwnership({
      videoId: 'vid_123',
      userId: 'usr_owner_456',
    });
    assert.strictEqual(successRes.isOwner, true);
    assert.strictEqual(successRes.status, 'READY');

    const failRes = await checkOwnership({
      videoId: 'vid_123',
      userId: 'usr_stranger_999',
    });
    assert.strictEqual(failRes.isOwner, false);
    assert.strictEqual(failRes.status, 'UNAUTHORIZED');
  });
});
