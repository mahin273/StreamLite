# StreamLite

A production-grade Netflix-style video streaming platform built as microservices using TypeScript, NestJS, and Docker.

---

## Overview

StreamLite provides an end-to-end video streaming pipeline designed to run locally with zero-cost open-source infrastructure:
- **Accounts & Auth**: Argon2id password hashing, Ed25519 EdDSA JWTs with JWKS rotation, sliding-window refresh tokens with reuse detection, and multi-profile support.
- **Media Pipeline**: Resumable multipart upload directly to S3-compatible storage (SeaweedFS), FFmpeg adaptive bitrate (ABR) ladder transcoding (480p / 720p / 1080p fMP4 HLS), and an atomic playlist publish flow.
- **Edge Streaming**: Expiring signed media URLs verified by an Nginx reverse proxy (`secure_link`) with local segment caching.
- **Watch History & Library**: Resume-where-you-left-off with write-behind buffering via Redis and PostgreSQL.
- **Recommendation Engine**: Event-driven trending feeds and item-item similarity recommendations computed using Node.js `worker_threads`.

---

## Architecture

```mermaid
flowchart TD
    Browser["Browser Client (React + hls.js)"]

    subgraph Ingress ["Edge & Ingress Layer"]
        Gateway["API Gateway (Traefik v3) :8080"]
        MediaEdge["Media Edge (Nginx secure_link + cache) :8090"]
    end

    subgraph Storage ["Object Storage (SeaweedFS S3 :8333)"]
        RawBucket["raw bucket (Direct Presigned Uploads)"]
        MediaBucket["media bucket (HLS Segments)"]
        ImagesBucket["images bucket (Posters/Thumbnails)"]
    end

    subgraph Services ["Application Microservices (NestJS + Fastify)"]
        AuthSvc["auth-svc"]
        CatalogSvc["catalog-svc"]
        UploadSvc["upload-svc"]
        StreamingSvc["streaming-svc"]
        WatchSvc["watch-history-svc"]
        RecoSvc["recommendation-svc"]
    end

    subgraph Databases ["Data Layer"]
        AuthDB[("auth_db (PostgreSQL)")]
        CatalogDB[("catalog_db (PostgreSQL)")]
        UploadDB[("upload_db (PostgreSQL)")]
        WatchDB[("watch_db (PostgreSQL)")]
        RecoDB[("reco_db (PostgreSQL)")]
        AppRedis[("Shared/Service Redis (Streams, Hot Progress, Trending)")]
    end

    subgraph AsyncAndWorkers ["Asynchronous Transcoding & Messaging"]
        Redpanda["Redpanda Event Broker (Kafka API)"]
        TranscoderWorkers["Transcoder Workers xN (FFmpeg / ffprobe)"]
        TranscoderDB[("transcoder_db (Job Queue)")]
    end

    %% Client traffic
    Browser -->|REST/JSON :8080| Gateway
    Browser -->|HLS segments :8090| MediaEdge
    Browser -->|Presigned Multipart PUT| RawBucket

    %% Gateway routing
    Gateway --> AuthSvc
    Gateway --> CatalogSvc
    Gateway --> UploadSvc
    Gateway --> StreamingSvc
    Gateway --> WatchSvc
    Gateway --> RecoSvc

    %% Media Edge
    MediaEdge -->|Secure proxy pass| MediaBucket
    MediaEdge -->|Proxy pass| ImagesBucket

    %% Service to DB
    AuthSvc --> AuthDB
    CatalogSvc --> CatalogDB
    UploadSvc --> UploadDB
    StreamingSvc --> AppRedis
    WatchSvc --> WatchDB
    WatchSvc --> AppRedis
    RecoSvc --> RecoDB
    RecoSvc --> AppRedis

    %% Internal Sync (gRPC)
    StreamingSvc -.->|gRPC| CatalogSvc
    StreamingSvc -.->|gRPC| WatchSvc
    UploadSvc -.->|gRPC| CatalogSvc
    WatchSvc -.->|gRPC| CatalogSvc

    %% Transcoder
    TranscoderWorkers --> TranscoderDB
    TranscoderWorkers -->|Read source| RawBucket
    TranscoderWorkers -->|Write HLS| MediaBucket
    TranscoderWorkers -->|Write Posters| ImagesBucket

    %% Event Bus (Redpanda)
    AuthSvc ==Outbox / Events==> Redpanda
    CatalogSvc ==Outbox / Events==> Redpanda
    UploadSvc ==Outbox / Events==> Redpanda
    WatchSvc ==Outbox / Events==> Redpanda
    TranscoderWorkers ==Outbox / Events==> Redpanda
    Redpanda ==Events==> CatalogSvc
    Redpanda ==Events==> WatchSvc
    Redpanda ==Events==> RecoSvc
    Redpanda ==Events==> TranscoderWorkers
```

---

## Tech Stack

- **Runtime**: Node.js LTS, TypeScript 5.x (strict)
- **Framework**: NestJS with Fastify adapter
- **Database & Cache**: PostgreSQL 16, Redis 7
- **Data Access & Migrations**: Kysely (type-safe SQL builder) + `node-pg-migrate`
- **Event Streaming**: Redpanda (Kafka-compatible API) via KafkaJS with transactional outbox & idempotent consumers
- **Object Storage**: SeaweedFS (S3-compatible, zero-cost local Docker storage)
- **Gateway & CDN Edge**: Traefik v3, Nginx (`secure_link` + proxy caching)
- **Transcoding**: FFmpeg & ffprobe
- **Tooling**: npm workspaces, Docker Compose v2
