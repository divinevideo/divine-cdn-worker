# Blossom SDK Worker

> [!WARNING]
> **Deprecated project.** `divine-cdn-worker` has been replaced by **`divine-blossom`** and is no longer the active media relay implementation.
>
> Use `divine-blossom` for current development and production changes.

Experimental Cloudflare Worker implementation using `blossom-server-sdk`.

## Overview

This worker implements the Blossom protocol for blob storage using:
- **blossom-server-sdk** - Core Blossom protocol abstractions
- **Cloudflare R2** - Blob storage backend
- **Cloudflare KV** - Metadata storage backend

## Directory Structure

```
blossom-sdk-worker/
├── src/
│   ├── index.mjs              # Main worker entry point
│   └── storage/
│       ├── r2-blob-storage.mjs    # R2 storage adapter
│       └── kv-metadata-store.mjs  # KV metadata adapter
├── package.json
├── wrangler.toml
└── README.md
```

## Key Differences from Main Worker

1. **Uses SDK abstractions** - Implements `IBlobStorage` and `IBlobMetadataStore` interfaces
2. **Cleaner separation** - Storage logic is separated from request handling
3. **Experimental** - Testing how well the SDK works with Cloudflare Workers

## Setup

```bash
cd blossom-sdk-worker
npm install
```

## Testing

### Unit Tests
```bash
npm test
```
50+ tests covering all endpoints, authentication, and upload strategies.

### Live Testing
```bash
./test-live.sh
```
Automated test script that validates all endpoints against staging.

See `TESTING.md` for comprehensive testing guide.

## Development

```bash
npm run dev
```

## Deployment

```bash
# Production
npm run deploy
```

### Live Deployment

**Production:** https://blossom.divine.video

Test it:
```bash
# Homepage with API docs
curl https://blossom.divine.video/

# List blobs
curl https://blossom.divine.video/list/0000000000000000000000000000000000000000000000000000000000000000

# Upload (requires signed Nostr event, kind 24242)
# See BLOSSOM_CLIENT_SPEC.md for complete authentication details
```

For client implementation details, see `BLOSSOM_CLIENT_SPEC.md`.

## Endpoints

- `GET /<sha256>` - Retrieve blob
- `HEAD /<sha256>` - Check blob existence
- `PUT /upload` or `POST /upload` - Upload blob (requires Nostr authentication)
- `GET /list/<pubkey>` - List user's blobs
- `DELETE /<sha256>` - Delete blob (requires owner authentication)
- `GET /video-status/<sha256>` - Check video processing status
- `POST /webhooks/bunny` - BunnyStream encoding webhooks

See `BLOSSOM_CLIENT_SPEC.md` for complete API documentation.

## Storage Adapters

### R2BlobStorage
Implements `IBlobStorage` interface for Cloudflare R2:
- `hasBlob(sha256)` - Check if blob exists
- `readBlob(sha256)` - Read blob data
- `writeBlob(sha256, stream, mimeType)` - Write blob
- `removeBlob(sha256)` - Delete blob

### KVMetadataStore
Implements `IBlobMetadataStore` interface for Cloudflare KV:
- `hasBlob(sha256)` - Check if metadata exists
- `getBlob(sha256)` - Get blob metadata
- `addBlob(blob)` - Add blob metadata
- `removeBlob(sha256)` - Delete blob metadata
- `addBlobOwner(sha256, pubkey)` - Associate owner
- `getBlobsForPubkey(pubkey)` - List user's blobs

## Configuration Notes

### Cloudflare Stream Domain

For legacy video thumbnail support, the worker needs to fetch thumbnails from Cloudflare Stream.

**IMPORTANT:** The Stream customer subdomain is **NOT** based on your account ID. You must configure `STREAM_CUSTOMER_DOMAIN` explicitly in `wrangler.toml`:

```toml
[vars]
STREAM_CUSTOMER_DOMAIN = "customer-4c3uhd5qzuhwz9hu.cloudflarestream.com"
```

To find your Stream customer domain:
1. Go to Cloudflare Dashboard → Stream
2. Click on any video
3. Look at the video URL, it will be in the format: `https://customer-XXXXXXXXXX.cloudflarestream.com/VIDEO_ID/...`
4. Use the full subdomain (e.g., `customer-XXXXXXXXXX.cloudflarestream.com`)

**Common mistake:** Trying to construct the domain from the account ID (e.g., `customer-${ACCOUNT_ID}.cloudflarestream.com`) will result in 404 errors for thumbnail requests.

## Security

### Nostr Authentication (BUD-01)

All authenticated endpoints require proper Nostr event signatures (kind 24242):

- **Production**: Full signature verification enabled using @noble/curves
- **Development**: Can bypass with `DEV_AUTH_MODE=true` and simple pubkey auth

See `SECURITY_FIX_SUMMARY.md` for security audit details.

### Features

- ✅ Full NIP-01 signature verification (Schnorr/BIP-340)
- ✅ Event ID validation
- ✅ SHA-256 hash verification for uploads
- ✅ Content moderation integration
- ✅ ProofMode support for verified media
- ✅ Secure by default (DEV_AUTH_MODE=false in production)

## Documentation

- `CHANGELOG.md` - Version history and release notes
- `BLOSSOM_CLIENT_SPEC.md` - Complete API specification for client developers
- `SECURITY_FIX_SUMMARY.md` - Security audit and fix documentation

## TODO

- [ ] Performance comparison vs main worker
- [ ] Evaluate SDK benefits vs custom implementation
- [ ] Add rate limiting
- [ ] Add metrics/observability
