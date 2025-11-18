# Bunny Video API

Public read-only API endpoints for querying Bunny video data from D1 database.

Base URL: `https://cdn.divine.video`

All endpoints return JSON with CORS enabled. No authentication required.

## Endpoints

### Get Video by SHA-256

```
GET /bunny/video/:sha256
```

Returns video metadata and latest webhook event for a specific SHA-256 hash.

**Example:**
```bash
curl https://cdn.divine.video/bunny/video/abc123...
```

**Response:**
```json
{
  "metadata": {
    "sha256": "abc123...",
    "video_guid": "guid-123",
    "current_status": "ready",
    "current_hls_url": "https://stream.divine.video/guid-123/playlist.m3u8",
    ...
  },
  "latestEvent": { ... },
  "eventsCount": 5
}
```

---

### Get Video by Bunny GUID

```
GET /bunny/video/guid/:video_guid
```

Returns video metadata and latest webhook event for a specific Bunny video GUID.

**Example:**
```bash
curl https://cdn.divine.video/bunny/video/guid/my-video-guid-123
```

---

### Get Videos by Uploader

```
GET /bunny/video/uploader/:pubkey?limit=100
```

Returns all videos uploaded by a specific Nostr pubkey (hex format).

**Query params:**
- `limit` (optional): Max results, default 100, max 500

**Example:**
```bash
curl https://cdn.divine.video/bunny/video/uploader/78a5c21b...?limit=50
```

**Response:**
```json
{
  "uploader": "78a5c21b...",
  "count": 42,
  "videos": [...]
}
```

---

### List Webhook Events

```
GET /bunny/events?sha256=...&video_guid=...&status=...&limit=100
```

Query webhook events with optional filters.

**Query params:**
- `sha256` (optional): Filter by SHA-256 hash
- `video_guid` (optional): Filter by Bunny video GUID
- `status` (optional): Filter by status name (finished, error, processing, encoding, queued)
- `limit` (optional): Max results, default 100, max 500

**Example:**
```bash
# Get all finished encodings
curl https://cdn.divine.video/bunny/events?status=finished&limit=20

# Get events for specific video
curl https://cdn.divine.video/bunny/events?video_guid=my-video-123
```

**Response:**
```json
{
  "count": 20,
  "filters": {
    "status": "finished",
    "limit": 20
  },
  "events": [
    {
      "id": 1,
      "video_guid": "my-video-123",
      "status": 3,
      "status_name": "finished",
      "timestamp": "2025-10-30T06:07:16.000Z",
      "hls_url": "https://stream.divine.video/my-video-123/playlist.m3u8",
      "thumbnail_url": "https://stream.divine.video/my-video-123/thumbnail.jpg",
      ...
    }
  ]
}
```

---

### Get Events for Specific Video

```
GET /bunny/events/:video_guid
```

Returns all webhook events for a specific video GUID, sorted by timestamp (newest first).

**Example:**
```bash
curl https://cdn.divine.video/bunny/events/my-video-guid-123
```

**Response:**
```json
{
  "video_guid": "my-video-guid-123",
  "count": 5,
  "events": [...]
}
```

---

### Recent Videos

```
GET /bunny/recent?limit=50
```

Returns recently uploaded videos from the video_metadata table.

**Query params:**
- `limit` (optional): Max results, default 50, max 500

**Example:**
```bash
curl https://cdn.divine.video/bunny/recent?limit=20
```

---

### Failed Encodings

```
GET /bunny/failed?limit=100
```

Returns webhook events for failed video encodings (status=error).

**Example:**
```bash
curl https://cdn.divine.video/bunny/failed
```

---

### Currently Processing

```
GET /bunny/processing?limit=100
```

Returns webhook events for videos currently being processed/encoded.

**Example:**
```bash
curl https://cdn.divine.video/bunny/processing
```

## Status Codes

Webhook events use these status codes:

- `0` = queued
- `1` = processing
- `2` = encoding
- `3` = finished
- `4` = resolution_finished
- `5` = error

The API also includes `status_name` field for human-readable status.

## Rate Limiting

No rate limiting currently enforced. Please be respectful.

## Caching

Responses are cached for 60 seconds via `Cache-Control` header.
