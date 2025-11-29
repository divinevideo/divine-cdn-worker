# Media Transformations Migration Design

## Overview

Migrate from BunnyStream HLS encoding to Cloudflare Media Transformations for video variants. BunnyStream code remains but is feature-flagged off.

## Current State

```
Upload → R2 + BunnyStream → Webhook → HLS encoding → Serve from Bunny CDN
```

- Videos uploaded to both R2 and BunnyStream
- BunnyStream encodes to HLS (adaptive bitrate)
- Webhook updates metadata when encoding completes
- Moderation triggered by webhook
- PlaybackResolver prefers HLS, falls back to R2 MP4

## Target State

```
Upload → R2 only → Serve via Media Transformations (on-demand)
                → ctx.waitUntil(queueModeration())
```

- Videos uploaded to R2 only
- Media Transformations generates variants on-demand at edge
- Moderation queued immediately after upload (non-blocking)
- CF edge cache handles caching (no R2 storage of variants)
- BunnyStream code remains, disabled via `BUNNY_STREAM_ENABLED="false"`

## Constraints

- Max video duration: 6 seconds (well under MT's 60s limit)
- Max video size: < 100MB (well under MT's 100MB limit)
- No HLS adaptive streaming needed for short clips

## Design Decisions

### Storage: Edge Cache Only

Media Transformations generates variants on-demand and caches at CF edge. No pre-generation or R2 storage of variants needed because:
- 6-second videos transcode in ~1-2 seconds
- CF edge cache is persistent
- Reduces complexity and storage cost

### Moderation: Fire-and-Forget via waitUntil

```javascript
// In upload handler, after R2 write succeeds
ctx.waitUntil(queueForModeration(sha256, env));
return new Response(JSON.stringify(uploadResult), ...);
```

Non-blocking, happens immediately after upload, no webhook needed.

### URL Structure

```
Original:    https://cdn.divine.video/{sha256}
720p:        https://cdn.divine.video/cdn-cgi/media/mode=video,width=1280,height=720/{sha256}
480p:        https://cdn.divine.video/cdn-cgi/media/mode=video,width=854,height=480/{sha256}
360p:        https://cdn.divine.video/cdn-cgi/media/mode=video,width=640,height=360/{sha256}
Thumbnail:   https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s,width=480/{sha256}
Audio:       https://cdn.divine.video/cdn-cgi/media/mode=audio/{sha256}
Spritesheet: https://cdn.divine.video/cdn-cgi/media/mode=spritesheet,width=120/{sha256}
```

## Changes Required

### 1. wrangler.toml
- Set `BUNNY_STREAM_ENABLED="false"` (production)

### 2. src/streaming/upload-strategy.mjs
- Already respects `BUNNY_STREAM_ENABLED` flag
- When false, routes to R2 only

### 3. src/streaming/playback-resolver.mjs
- Add `Provider.MEDIA_TRANSFORMS`
- When Bunny disabled, return MT URLs instead of Bunny URLs
- Include `variants` object with resolution options

### 4. src/index.mjs (upload handler)
- After successful R2 upload, queue moderation via `ctx.waitUntil()`
- Include variant URLs in upload response

### 5. Upload Response Format

```json
{
  "url": "https://cdn.divine.video/{sha256}",
  "sha256": "...",
  "size": 12345,
  "type": "video/mp4",
  "variants": {
    "original": "https://cdn.divine.video/{sha256}",
    "hd": "https://cdn.divine.video/cdn-cgi/media/mode=video,width=1280,height=720/{sha256}",
    "sd": "https://cdn.divine.video/cdn-cgi/media/mode=video,width=640,height=360/{sha256}",
    "thumbnail": "https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s,width=480/{sha256}"
  }
}
```

## What Stays (Feature-Flagged)

All BunnyStream code remains intact:
- `src/streaming/bunny-webhook.mjs`
- `src/streaming/bunny-client.mjs`
- `src/streaming/bunny-api.mjs`
- `src/streaming/d1-logger.mjs`
- Webhook endpoint in index.mjs

Can re-enable by setting `BUNNY_STREAM_ENABLED="true"`.

## Migration Path

1. Deploy with `BUNNY_STREAM_ENABLED="false"`
2. New uploads go to R2 only, served via MT
3. Existing videos with Bunny metadata continue working (PlaybackResolver checks for bunny data first)
4. Monitor for issues
5. If problems, flip flag back to "true"

## Rollback

Set `BUNNY_STREAM_ENABLED="true"` in wrangler.toml and redeploy.
