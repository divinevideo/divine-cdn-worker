# Cloudflare Media Transformations Thumbnail Design

## Overview

Replace BunnyStream's arbitrary-frame thumbnails with Cloudflare Media Transformations to extract first-frame thumbnails.

## Validation Results

**Test Date:** 2025-11-28

| Test | Result |
|------|--------|
| Worker-resolved path `/{sha256}` | ✅ Works |
| Direct R2 path `/blobs/{sha256}` | ❌ Fails (404) |
| 320x240 H.264 baseline video | ✅ Works |
| 64x64 minimal video | ❌ Fails (err=9412 invalid format) |

**Working URL format:**
```
https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s,width=480/{sha256}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Webhook Flow (encoding complete)                  │
├─────────────────────────────────────────────────────────────────────┤
│  BunnyStream → POST /webhooks/bunny → Worker                         │
│           ↓                                                          │
│  [Get video SHA256 from KV]                                          │
│           ↓                                                          │
│  [Check: size < 40MB? MEDIA_TRANSFORMATIONS_ENABLED?]                │
│           ↓ yes                    ↓ no                              │
│  [Try Cloudflare MT]          [Use BunnyStream thumbnail]            │
│    ├─ retry 3x w/backoff                                             │
│    ├─ success → store JPEG                                           │
│    └─ failure → fallback to BunnyStream                              │
│           ↓                                                          │
│  [SHA256 the thumbnail, store in R2]                                 │
│           ↓                                                          │
│  [Update KV with thumbnailSha256 + thumbnailSource]                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Components

### 1. New module: `src/thumbnail-extractor.mjs`

```javascript
// ABOUTME: Cloudflare Media Transformations thumbnail extractor
// ABOUTME: Extracts first-frame thumbnails from videos via cdn-cgi/media

const MAX_VIDEO_SIZE_BYTES = 40 * 1024 * 1024; // 40MB CF limit
const RETRY_DELAYS_MS = [500, 1000, 2000]; // Exponential backoff

export async function extractFirstFrame(sha256, env) {
  const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
  const width = env.THUMBNAIL_WIDTH || 480;

  const url = `https://${cdnDomain}/cdn-cgi/media/mode=frame,time=0s,width=${width}/${sha256}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }

    const response = await fetch(url);

    if (response.ok) {
      return {
        success: true,
        data: await response.arrayBuffer(),
        contentType: response.headers.get('content-type') || 'image/jpeg'
      };
    }

    // Check for non-retryable errors
    const cfResized = response.headers.get('cf-resized') || '';
    if (cfResized.includes('9412')) {
      // Invalid video format - won't succeed on retry
      return { success: false, error: 'invalid_format', code: 9412 };
    }
    if (cfResized.includes('9413')) {
      // Video too large
      return { success: false, error: 'too_large', code: 9413 };
    }
  }

  return { success: false, error: 'max_retries_exceeded' };
}

export function shouldAttemptMediaTransformation(env, videoSize) {
  // Check feature flag
  if (env.MEDIA_TRANSFORMATIONS_ENABLED !== 'true') {
    return false;
  }

  // Check size limit
  if (videoSize > MAX_VIDEO_SIZE_BYTES) {
    return false;
  }

  return true;
}
```

### 2. Configuration changes: `wrangler.toml`

```toml
# Add to [env.production.vars]:
MEDIA_TRANSFORMATIONS_ENABLED = "true"
THUMBNAIL_WIDTH = "480"
```

### 3. Webhook handler integration: `bunny-webhook.mjs`

Modify `handleVideoEncoded()` (around line 280) to:

1. Check if Media Transformations should be attempted
2. Try Cloudflare extraction first
3. Fall back to BunnyStream thumbnail on failure
4. Track `thumbnailSource: 'cloudflare' | 'bunnystream'` in metadata

## Error Handling Matrix

| Error | Behavior | Retry? |
|-------|----------|--------|
| 404 (9404) | Video not found in R2 | Yes (propagation delay) |
| 400 (9412) | Invalid video format | No (permanent) |
| 400 (9413) | Video too large | No (permanent) |
| 5xx | CF edge error | Yes |
| Timeout | Network issue | Yes |

## Metadata Schema Changes

Add to KV metadata:

```javascript
{
  thumbnailSha256: 'abc123...',
  thumbnailBlossomUrl: 'https://cdn.divine.video/abc123.jpg',
  thumbnailSource: 'cloudflare' | 'bunnystream',  // NEW
  thumbnailExtractedAt: 1732832400000  // NEW: timestamp for debugging
}
```

## Test Plan

### Unit Tests (`tests/test_thumbnail_extractor.mjs`)

1. `extractFirstFrame()` returns success for valid video
2. `extractFirstFrame()` returns error for invalid format (9412)
3. `extractFirstFrame()` retries on 404 (propagation delay)
4. `extractFirstFrame()` doesn't retry on 9412/9413
5. `shouldAttemptMediaTransformation()` returns false when disabled
6. `shouldAttemptMediaTransformation()` returns false when video > 40MB
7. `shouldAttemptMediaTransformation()` returns true when enabled and small

### Integration Tests

1. Upload video → webhook fires → first-frame thumbnail extracted
2. Upload large video (>40MB) → falls back to BunnyStream thumbnail
3. Feature flag disabled → uses BunnyStream thumbnail

## Rollout Plan

1. Deploy with `MEDIA_TRANSFORMATIONS_ENABLED = "false"`
2. Test manually with a few videos
3. Enable for production: `MEDIA_TRANSFORMATIONS_ENABLED = "true"`
4. Monitor success rate via logs
5. If issues, disable flag to revert instantly

## Success Metrics

- Cloudflare extraction success rate > 95%
- Thumbnail generation latency < 3s
- Fallback to BunnyStream < 5% of requests
