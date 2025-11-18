# BunnyStream Backfill API

API endpoints for backfilling old R2 videos to BunnyStream for automatic thumbnail generation and HLS streaming.

## Endpoints

### POST /backfill-video

Backfill a single video to BunnyStream.

**Request:**
```bash
curl -X POST https://blossom.divine.video/backfill-video \
  -H "Content-Type: application/json" \
  -d '{"sha256": "4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd"}'
```

**Response (202 Accepted):**
```json
{
  "status": "processing",
  "sha256": "4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd",
  "videoId": "8d672003-8024-4aab-9356-1c42a6631f53",
  "hlsUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/playlist.m3u8",
  "thumbnailUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/thumbnail.jpg",
  "message": "Video backfill initiated. URLs will be available after encoding completes (30-120 seconds)",
  "checkStatus": "/video-status/4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd"
}
```

**Response (200 OK - Already Backfilled):**
```json
{
  "status": "already_backfilled",
  "videoId": "8d672003-8024-4aab-9356-1c42a6631f53",
  "hlsUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/playlist.m3u8",
  "thumbnailUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/thumbnail.jpg",
  "bunnyStatus": "ready"
}
```

**Error Responses:**
- `400` - Invalid SHA-256 format
- `404` - Video not found in R2
- `500` - BunnyStream upload failed

---

### POST /backfill-batch

Batch backfill multiple videos from R2. Supports pagination for processing large numbers of videos.

**Request:**
```bash
curl -X POST https://blossom.divine.video/backfill-batch \
  -H "Content-Type: application/json" \
  -d '{"limit": 50, "skipExisting": true}'
```

**Request Parameters:**
- `limit` (number, optional): Number of videos to process (default: 50, max: 200)
- `cursor` (string, optional): Pagination cursor from previous response
- `skipExisting` (boolean, optional): Skip videos already backfilled (default: true)

**Response (200 OK):**
```json
{
  "summary": {
    "processed": 50,
    "alreadyBackfilled": 12,
    "newlyBackfilled": 38,
    "errors": 0
  },
  "videos": [
    {
      "sha256": "001d44b18edd",
      "status": "processing",
      "videoId": "ee70db3d-a3ff-441b-8ed4-2dbce79016a5"
    },
    {
      "sha256": "0072e95f2e6f",
      "status": "already_backfilled",
      "videoId": "c5042124-c399-443e-83f4-260ee2a2d50e"
    }
  ],
  "pagination": {
    "truncated": true,
    "cursor": "1-JTdCJTIydiUy..."
  },
  "nextBatch": {
    "message": "More videos available. Call again with cursor to continue.",
    "curl": "curl -X POST https://blossom.divine.video/backfill-batch -H \"Content-Type: application/json\" -d '{\"cursor\": \"1-JTdCJTIydiUy...\", \"limit\": 50}'"
  }
}
```

**Pagination Example:**
```bash
# First batch
curl -X POST https://blossom.divine.video/backfill-batch \
  -H "Content-Type: application/json" \
  -d '{"limit": 50}'

# Next batch (using cursor from previous response)
curl -X POST https://blossom.divine.video/backfill-batch \
  -H "Content-Type: application/json" \
  -d '{"limit": 50, "cursor": "1-JTdCJTIydiUy..."}'
```

---

### GET /video-status/{sha256}

Check the processing status and available URLs for a backfilled video.

**Request:**
```bash
curl https://blossom.divine.video/video-status/4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd
```

**Response (200 OK - Ready):**
```json
{
  "sha256": "4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd",
  "status": "ready",
  "videoId": "8d672003-8024-4aab-9356-1c42a6631f53",
  "ready": true,
  "r2Url": "https://cdn.divine.video/4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd.mp4",
  "hlsUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/playlist.m3u8",
  "thumbnailUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/thumbnail.jpg",
  "message": "Video encoding complete. All URLs are ready."
}
```

**Response (200 OK - Processing):**
```json
{
  "sha256": "4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd",
  "status": "processing",
  "videoId": "8d672003-8024-4aab-9356-1c42a6631f53",
  "ready": false,
  "r2Url": "https://cdn.divine.video/4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd.mp4",
  "hlsUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/playlist.m3u8",
  "thumbnailUrl": "https://stream.divine.video/8d672003-8024-4aab-9356-1c42a6631f53/thumbnail.jpg",
  "message": "Video is processing. Please check again in a few seconds."
}
```

**Response (200 OK - Not Backfilled):**
```json
{
  "sha256": "4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd",
  "status": "not_backfilled",
  "r2Url": "https://cdn.divine.video/4296696b82b2b7b0c8a1f0465a4aea675310d0e29565476b7f4180192be175cd.mp4",
  "message": "Video exists in R2 but has not been backfilled to BunnyStream"
}
```

**Error Response:**
- `404` - Video not found in system

---

## BunnyStream Video URLs

After backfilling, each video has multiple URLs available:

### Thumbnails
- **Primary:** `https://stream.divine.video/{videoId}/thumbnail.jpg`
- **Numbered:** `https://stream.divine.video/{videoId}/thumbnail_1.jpg` through `thumbnail_7.jpg`
- 7 thumbnails are generated at different timestamps throughout the video

### HLS Streaming
- **Master Playlist:** `https://stream.divine.video/{videoId}/playlist.m3u8`
- Adaptive bitrate streaming with multiple resolutions (240p, 360p, 480p, 720p)

### Direct MP4 Playback
- **360p:** `https://stream.divine.video/{videoId}/play_360p.mp4`
- **480p:** `https://stream.divine.video/{videoId}/play_480p.mp4`
- **720p:** `https://stream.divine.video/{videoId}/play_720p.mp4`

### R2 Fallback
- **Original:** `https://cdn.divine.video/{sha256}.mp4`
- Always available even before encoding completes

---

## Workflow for Batch Backfill

### 1. Fetch Old Nostr Events
Get video events (kind 34236) from Nostr relays for videos that need backfilling:

```bash
nak req -i <event_id> wss://relay3.openvine.co
```

Extract SHA-256 hashes from `imeta` tags (URLs like `https://cdn.divine.video/{sha256}.mp4`)

### 2. Backfill Videos
Process videos in batches:

```bash
# Process 50 videos at a time
curl -X POST https://blossom.divine.video/backfill-batch \
  -H "Content-Type: application/json" \
  -d '{"limit": 50}'
```

Continue with pagination cursor until all videos are processed.

### 3. Wait for Encoding
Encoding takes 30-120 seconds per video. Check status:

```bash
curl https://blossom.divine.video/video-status/{sha256}
```

### 4. Update Nostr Events
Once `status: "ready"`, republish Nostr events with updated `imeta` tags:

**Original:**
```json
{
  "url": "https://cdn.divine.video/{sha256}.mp4",
  "m": "video/mp4",
  "x": "{sha256}",
  "size": "1234567"
}
```

**Updated:**
```json
{
  "url": "https://cdn.divine.video/{sha256}.mp4",
  "m": "video/mp4",
  "x": "{sha256}",
  "size": "1234567",
  "thumb": "https://stream.divine.video/{videoId}/thumbnail.jpg",
  "hls": "https://stream.divine.video/{videoId}/playlist.m3u8"
}
```

---

## Rate Limiting & Performance

- `/backfill-batch` processes up to 200 videos per request (recommended: 50)
- Each video initiates immediately (BunnyStream queues encoding)
- Encoding happens asynchronously, so you can backfill thousands of videos
- No explicit rate limits, but use reasonable batch sizes

## Notes

- Thumbnails are available **immediately** after backfill (even before encoding completes)
- HLS playlists become available after encoding (30-120 seconds)
- Videos remain in R2 as backup/fallback
- Backfilling is idempotent (calling twice for same video is safe)
