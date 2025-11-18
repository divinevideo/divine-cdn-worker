# BunnyStream Upload Strategy

This document describes the upload routing and strategy selection system for BunnyStream integration.

## Overview

The upload strategy router determines where uploaded videos are stored: Cloudflare R2, BunnyStream, or both. It provides:

- **Feature flags** for safe rollout and instant rollback
- **Hash-based routing** for consistent video placement
- **Gradual migration** via rollout percentage
- **Graceful degradation** when Bunny API is unavailable

## Architecture

### Components

1. **`selectUploadStrategy(env, sha256, metadata)`** - Determines upload destination
2. **`BunnyUploadHandler`** - Manages Bunny video lifecycle and metadata
3. **Hash-based distribution** - Consistent routing using SHA-256

### Data Flow

```
Upload Request
    ↓
selectUploadStrategy()
    ↓
┌───────────────────────┐
│ Feature Flag Check    │
│ BUNNY_STREAM_ENABLED  │
└───────┬───────────────┘
        ↓
┌───────────────────────┐
│ Destination Mode      │
│ BUNNY_UPLOAD_DEST     │
└───────┬───────────────┘
        ↓
    ┌───┴────┐
    │        │
   r2     bunny     dual (hash-based)
    │        │          │
    ↓        ↓          ↓
  R2 Only  Bunny    Rollout %
           Only      (0-100)
```

## Configuration

### Environment Variables

```bash
# Master switch - set to "true" to enable BunnyStream
BUNNY_STREAM_ENABLED="false"

# Upload destination mode
# - "r2": All uploads go to R2 (default, safest)
# - "bunny": All uploads go to Bunny (experimental)
# - "dual": Use rollout percentage for gradual migration
BUNNY_UPLOAD_DEST="r2"

# Percentage of traffic to route to Bunny (0-100)
# Only used when BUNNY_UPLOAD_DEST="dual"
BUNNY_ROLLOUT_PERCENTAGE="0"

# BunnyStream credentials (required when enabled)
BUNNY_STREAM_LIBRARY_ID="xxxxx"
BUNNY_STREAM_ACCESS_KEY="secret-key"  # Set via wrangler secret

# Optional: API configuration
BUNNY_API_ENDPOINT="https://video.bunnycdn.com"
BUNNY_STREAM_REGION=""  # e.g., "ny", "la", "sg" or empty for global
```

### wrangler.toml Example

```toml
[env.production.vars]
BUNNY_STREAM_ENABLED = "false"
BUNNY_STREAM_LIBRARY_ID = "12345"
BUNNY_UPLOAD_DEST = "r2"
BUNNY_ROLLOUT_PERCENTAGE = "0"
BUNNY_API_ENDPOINT = "https://video.bunnycdn.com"

# Set secret via CLI:
# wrangler secret put BUNNY_STREAM_ACCESS_KEY --env production
```

## Upload Strategy Selection

### Decision Logic

```javascript
import { selectUploadStrategy } from './streaming/upload-strategy.mjs';

const strategy = selectUploadStrategy(env, sha256, metadata);
// Returns: { provider: 'r2' | 'bunny' | 'dual', shouldUseBunny: boolean }
```

### Strategy Matrix

| ENABLED | UPLOAD_DEST | Result |
|---------|-------------|---------|
| false   | any         | R2 only |
| true    | r2          | R2 only |
| true    | bunny       | Bunny only |
| true    | dual        | Hash-based (see rollout %) |

### Hash-Based Distribution

When `BUNNY_UPLOAD_DEST="dual"`, videos are routed based on their SHA-256 hash:

```javascript
function hashToNumber(sha256) {
  return parseInt(sha256.substring(0, 8), 16) % 100;
}

const shouldUseBunny = hashToNumber(sha256) < BUNNY_ROLLOUT_PERCENTAGE;
```

**Properties:**
- Deterministic: Same SHA-256 always routes to same provider
- Even distribution: Hashes are uniformly distributed 0-99
- Consistent: Changing rollout % doesn't re-route existing videos

**Example:**
```
SHA-256: 0000000012345678... → hash value 0  → < 50% → Bunny
SHA-256: 3200000056789abc... → hash value 50 → ≥ 50% → R2
SHA-256: ff00000098765432... → hash value 95 → ≥ 50% → R2
```

## BunnyUploadHandler API

### Class: BunnyUploadHandler

Manages BunnyStream video uploads and metadata.

#### Methods

##### `initiateUpload(sha256, metadata, env)`

Creates a new video in BunnyStream and returns upload URL.

```javascript
const handler = new BunnyUploadHandler(env);
const result = await handler.initiateUpload(sha256, { type, size }, env);

if (result) {
  console.log('Upload URL:', result.uploadUrl);
  console.log('Video ID:', result.videoId);
  // PUT video file to result.uploadUrl
} else {
  // Bunny unavailable - fallback to R2
}
```

**Returns:**
- `null` - Bunny API error (caller should fallback to R2)
- `Object`:
  - `uploadUrl` - URL to PUT video file to
  - `videoId` - Bunny video ID (GUID)
  - `guid` - Video GUID (same as videoId)

##### `handleUploadComplete(sha256, videoId, env)`

Updates KV metadata after video upload completes.

```javascript
await handler.handleUploadComplete(sha256, videoId, env);
```

##### `getStreamingUrls(sha256, env)`

Retrieves HLS and MP4 URLs for a video.

```javascript
const urls = await handler.getStreamingUrls(sha256, env);

if (urls && urls.status === 'ready') {
  console.log('HLS:', urls.hlsUrl);
  console.log('MP4:', urls.mp4Url);
}
```

**Returns:**
- `null` - Video not in Bunny or error
- `Object`:
  - `hlsUrl` - HLS playlist URL (or null if processing)
  - `mp4Url` - MP4 direct URL (or null)
  - `status` - 'uploading' | 'processing' | 'ready' | 'error'

##### `updateVideoMetadata(videoId, updates, env)`

Updates video metadata (called by webhook handler).

```javascript
await handler.updateVideoMetadata(videoId, {
  status: 'ready',
  hlsUrl: 'https://...',
  mp4Url: 'https://...'
}, env);
```

## KV Schema

### `bunny:video:{videoId}`

Stores Bunny-specific video metadata.

```json
{
  "sha256": "abc123...",
  "videoId": "guid-123",
  "guid": "guid-123",
  "status": "ready",
  "hlsUrl": "https://vz-xxxxx.b-cdn.net/guid-123/playlist.m3u8",
  "createdAt": 1697000000000,
  "updatedAt": 1697000100000
}
```

### `blob:{sha256}` (Extended)

Existing blob metadata with Bunny fields added.

```json
{
  "sha256": "abc123...",
  "size": 5000000,
  "type": "video/mp4",
  "uploaded": 1697000000,

  "bunny": {
    "videoId": "guid-123",
    "guid": "guid-123",
    "status": "ready",
    "hlsUrl": "https://vz-xxxxx.b-cdn.net/guid-123/playlist.m3u8",
    "mp4Url": "https://vz-xxxxx.b-cdn.net/guid-123/play_720p.mp4",
    "error": null
  }
}
```

## Rollout Strategy

### Phase 1: Infrastructure Setup

```bash
# Deploy with Bunny disabled
wrangler deploy --env production

# Set secrets
wrangler secret put BUNNY_STREAM_ACCESS_KEY --env production
```

### Phase 2: Testing (0% traffic)

```toml
BUNNY_STREAM_ENABLED = "true"
BUNNY_UPLOAD_DEST = "dual"
BUNNY_ROLLOUT_PERCENTAGE = "0"  # No production traffic
```

Test manually with specific hashes that route to Bunny.

### Phase 3: Gradual Rollout

```toml
# Week 1: 1% traffic
BUNNY_ROLLOUT_PERCENTAGE = "1"

# Week 2: 10% traffic (monitor metrics)
BUNNY_ROLLOUT_PERCENTAGE = "10"

# Week 3: 50% traffic
BUNNY_ROLLOUT_PERCENTAGE = "50"

# Week 4: 100% traffic
BUNNY_ROLLOUT_PERCENTAGE = "100"
```

### Phase 4: Full Migration

```toml
# Switch to Bunny-only
BUNNY_UPLOAD_DEST = "bunny"
```

## Rollback Procedures

### Immediate Rollback (Emergency)

```bash
# Option 1: Disable BunnyStream entirely
wrangler deploy --env production --var BUNNY_STREAM_ENABLED:false

# Option 2: Route all to R2
wrangler deploy --env production --var BUNNY_UPLOAD_DEST:r2
```

### Gradual Rollback

```bash
# Reduce rollout percentage
wrangler deploy --env production --var BUNNY_ROLLOUT_PERCENTAGE:25
wrangler deploy --env production --var BUNNY_ROLLOUT_PERCENTAGE:10
wrangler deploy --env production --var BUNNY_ROLLOUT_PERCENTAGE:0
```

## Error Handling

### Graceful Degradation

The system is designed to never block uploads due to Bunny issues:

```javascript
// 1. Initiate upload
const bunnyUpload = await handler.initiateUpload(sha256, metadata, env);

if (!bunnyUpload) {
  // Bunny failed - fallback to R2 automatically
  console.log('Bunny unavailable, using R2 fallback');
  await uploadToR2(sha256, blob);
  return;
}

// 2. Upload to Bunny
try {
  await fetch(bunnyUpload.uploadUrl, { method: 'PUT', body: blob });
} catch (error) {
  // Upload failed - log error but don't block user
  console.error('Bunny upload failed:', error);
  // Webhook will retry or mark as error
}
```

### Common Failure Modes

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Bunny API down | Routes to R2 | Automatic |
| Upload timeout | Returns error | Manual retry |
| Encoding fails | Webhook updates status | User re-upload |
| Invalid credentials | Routes to R2 | Fix config |

## Monitoring

### Key Metrics

```javascript
// Upload strategy decisions
bunny_upload_selected
r2_upload_selected

// Upload outcomes
bunny_upload_success
bunny_upload_failure
bunny_api_errors

// Fallback rate
bunny_fallback_rate = bunny_upload_failure / (bunny_upload_success + bunny_upload_failure)
```

### Alerts

- **Bunny API error rate > 5%** - Investigate API issues
- **Fallback rate > 20%** - Consider reducing rollout
- **Upload failures > 10%** - Check credentials/quota

## Testing

### Unit Tests

```bash
npm test tests/upload-strategy.test.mjs
```

### Integration Test

```bash
node test/test_bunny_upload_strategy.mjs
```

### Manual Testing

```javascript
// Test with specific hash
const strategy = selectUploadStrategy(env, 'your-sha256-here', {});
console.log('Provider:', strategy.provider);
console.log('Use Bunny:', strategy.shouldUseBunny);
```

## Best Practices

### DO

✅ Start with 0% rollout and test thoroughly
✅ Monitor metrics during rollout
✅ Increase rollout percentage gradually (1% → 10% → 50% → 100%)
✅ Keep R2 fallback functional
✅ Use feature flags for instant rollback
✅ Document rollout progress

### DON'T

❌ Deploy to production with 100% rollout immediately
❌ Remove R2 fallback code
❌ Disable monitoring during rollout
❌ Change rollout % more than once per day
❌ Skip testing phase

## Troubleshooting

### Videos not routing to Bunny

Check:
1. `BUNNY_STREAM_ENABLED="true"`
2. `BUNNY_UPLOAD_DEST` is "bunny" or "dual"
3. If dual, `BUNNY_ROLLOUT_PERCENTAGE` > hash value
4. Credentials configured correctly

### High fallback rate

Check:
1. Bunny API status
2. Account quota/limits
3. Network connectivity
4. Credentials validity

### Inconsistent routing

Check:
1. Hash calculation is correct
2. Rollout percentage hasn't changed
3. Feature flags are stable

## References

- [BunnyStream API Docs](https://docs.bunny.net/docs/stream)
- [Cloudflare Workers KV](https://developers.cloudflare.com/workers/runtime-apis/kv/)
- [Implementation Plan](../BUNNYSTREAM_IMPLEMENTATION.md)
