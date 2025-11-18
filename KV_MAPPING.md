# KV Mapping System for BunnyStream Migration

## Configuration Reference

**Quick Start for New Scripts:**

```bash
# Cloudflare Account
export CLOUDFLARE_ACCOUNT_ID="c84e7a9bf7ed99cb41b8e73566568c75"
export CLOUDFLARE_API_TOKEN="your-api-token"  # Get from Cloudflare Dashboard → My Profile → API Tokens

# Production KV Namespace (MEDIA_KV)
export MEDIA_KV_NAMESPACE_ID="effcf271031647f0947983f5f4211aa2"

# For staging/testing
export MEDIA_KV_NAMESPACE_ID_STAGING="eca883e0a5374b32ab92b3747235a1e3"
```

### Worker Configuration (from wrangler.toml)

| Environment | Worker Name | KV Namespace ID | Routes |
|-------------|-------------|-----------------|--------|
| **Production** | `blossom-sdk-worker-prod` | `effcf271031647f0947983f5f4211aa2` | blossom.divine.video/*, cdn.divine.video/* |
| **Staging** | `blossom-sdk-worker-staging` | `eca883e0a5374b32ab92b3747235a1e3` | (none) |
| **Development** | `blossom-sdk-worker` | `fc3fb1f988894752ae62462d5d0d2222` | (local only) |

**KV Binding Name:** `MEDIA_KV` (access in worker code as `env.MEDIA_KV`)

**Other Resources:**
- **R2 Bucket:** `nostrvine-media` (bound as `env.R2_BLOBS`)
- **Account ID:** `c84e7a9bf7ed99cb41b8e73566568c75`

### Finding These Values in Code

```bash
# View full configuration
cat wrangler.toml

# Extract KV namespace IDs
grep -A 2 "kv_namespaces" wrangler.toml

# Get production namespace ID specifically
grep -A 2 "\[env.production.kv_namespaces\]" wrangler.toml | grep "id"
```

## What is Cloudflare KV?

**Cloudflare Workers KV** is a global, low-latency key-value data store. Think of it like a giant distributed hash map that's:
- **Eventually consistent**: Updates propagate globally within seconds
- **Read-optimized**: Extremely fast reads (< 10ms) from edge locations
- **Limited writes**: Best for data that's read frequently but written infrequently
- **Simple API**: `get(key)`, `put(key, value)`, `delete(key)`, `list({ prefix })`

Our KV namespace is called `MEDIA_KV` and stores metadata about all blobs and videos.

## KV Store Structure

### 1. Blob Metadata: `blob:{sha256}`

The primary lookup for any file. Maps SHA256 hash to complete metadata including storage locations.

**Key format:** `blob:abc123def456...` (blob: prefix + 64-char SHA256)

**Value structure:**
```javascript
{
  "sha256": "abc123def456...",  // 64-character SHA256 hash
  "size": 1234567,               // File size in bytes
  "type": "video/mp4",           // MIME type
  "provider": "dual",            // Storage provider: 'r2', 'bunny', or 'dual'
  "uploaded": 1234567890000,     // Upload timestamp
  "pubkey": "npub1...",          // Uploader's nostr pubkey (if applicable)

  // R2 storage information (if stored in Cloudflare R2)
  "r2": {
    "key": "blobs/abc123...",    // R2 object key
    "bucket": "media-blobs",     // R2 bucket name
    "uploaded": 1234567890000
  },

  // BunnyStream information (if migrated to BunnyStream)
  "bunny": {
    "videoId": "guid-1234-5678-abcd",           // BunnyStream video GUID
    "guid": "guid-1234-5678-abcd",              // Same as videoId
    "libraryId": "515420",                       // BunnyStream library ID
    "status": "ready",                           // 'queued', 'processing', 'ready', 'failed'
    "hlsUrl": "https://stream.divine.video/guid-1234/playlist.m3u8",
    "thumbnailUrl": "https://vz-12345.b-cdn.net/guid-1234/thumbnail.jpg",
    "thumbnailSha256": "def456abc123...",        // SHA256 of extracted thumbnail
    "thumbnailBlossomUrl": "https://cdn.divine.video/def456abc123.jpg",
    "duration": 6.5,                             // Video duration in seconds
    "encodedAt": 1234567890000,                  // When encoding completed
    "mp4Url": "https://vz-12345.b-cdn.net/guid-1234/original.mp4"  // Direct MP4 (if available)
  }
}
```

**Provider values:**
- `r2`: Only stored in Cloudflare R2
- `bunny`: Only stored in BunnyStream
- `dual`: Stored in both R2 and BunnyStream (migration complete)

### 2. Video Metadata: `bunny:video:{videoId}`

Reverse lookup from BunnyStream video ID to SHA256. Used by webhooks to find the original file.

**Key format:** `bunny:video:guid-1234-5678-abcd`

**Value structure:**
```javascript
{
  "videoId": "guid-1234-5678-abcd",
  "sha256": "abc123def456...",
  "status": "ready",              // Current video status
  "r2Key": "uploads/file.mp4",    // Original R2 key (for backfilled videos)
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000
}
```

**TTL:** 30 days (auto-expires, can be refreshed)

### 3. Temporary Upload Tracking: `upload-temp:{r2Key}`

Tracks videos during backfill/upload process before they're fully processed.

**Key format:** `upload-temp:uploads/1750652436013-da28a42f.mp4`

**Value structure:**
```javascript
{
  "r2Key": "uploads/1750652436013-da28a42f.mp4",
  "videoId": "guid-1234-5678-abcd",
  "sha256": "abc123def456...",     // Set after webhook receives hash
  "status": "processing",
  "createdAt": 1234567890000
}
```

**TTL:** 24 hours (cleaned up after webhook completes)

## URL Mapping Examples

### Legacy R2 URLs → BunnyStream URLs

| Legacy URL | Purpose | Maps To |
|------------|---------|---------|
| `https://cdn.divine.video/blobs/{sha256}` | Content-addressed blob | `blob:{sha256}` → `bunny.hlsUrl` |
| `https://cdn.divine.video/{sha256}.mp4` | Old root-level videos | `blob:{sha256}` → `bunny.hlsUrl` |
| `https://cdn.divine.video/videos/{sha256}.mp4` | Legacy videos folder | `blob:{sha256}` → `bunny.hlsUrl` |
| `https://cdn.divine.video/uploads/file.mp4` | ArchiveTeam uploads | `upload-temp:{key}` → `bunny.hlsUrl` |

### New BunnyStream URLs

- **HLS Playlist:** `https://stream.divine.video/{videoId}/playlist.m3u8`
- **Thumbnail:** `https://stream.divine.video/{videoId}/thumbnail.jpg`
- **Direct MP4:** `https://vz-12345.b-cdn.net/{videoId}/original.mp4`

## Accessing KV from Different Contexts

### 1. From Cloudflare Worker (Production)

KV is bound to the worker via `wrangler.toml`:

```javascript
// Inside worker fetch handler
export default {
  async fetch(request, env, ctx) {
    // Get blob metadata
    const sha256 = "abc123def456...";
    const blobDataStr = await env.MEDIA_KV.get(`blob:${sha256}`);
    const blobData = JSON.parse(blobDataStr);

    // Check if migrated to BunnyStream
    if (blobData?.bunny?.status === 'ready') {
      return Response.redirect(blobData.bunny.hlsUrl, 302);
    }

    // Put new entry
    await env.MEDIA_KV.put(
      `blob:${sha256}`,
      JSON.stringify(blobData),
      { expirationTtl: 86400 * 365 }  // Optional: 1 year TTL
    );

    // List entries with prefix
    const result = await env.MEDIA_KV.list({
      prefix: 'bunny:video:',
      limit: 100,
      cursor: undefined  // For pagination
    });

    for (const key of result.keys) {
      console.log(key.name);
    }
  }
};
```

### 2. From Node.js Scripts (Development/Backfill)

Use the Cloudflare REST API with account credentials:

```javascript
// Setup
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const NAMESPACE_ID = process.env.MEDIA_KV_NAMESPACE_ID;  // Find in Cloudflare dashboard
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const KV_API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

// Read a key
async function getKV(key) {
  const response = await fetch(`${KV_API_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` }
  });

  if (!response.ok) return null;
  return await response.json();
}

// Write a key
async function putKV(key, value, expirationTtl = null) {
  const formData = new FormData();
  formData.append('value', JSON.stringify(value));
  formData.append('metadata', JSON.stringify({}));

  if (expirationTtl) {
    formData.append('expiration_ttl', expirationTtl.toString());
  }

  const response = await fetch(`${KV_API_BASE}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${API_TOKEN}` },
    body: formData
  });

  return response.ok;
}

// List keys with prefix
async function listKV(prefix, limit = 1000, cursor = null) {
  const params = new URLSearchParams({
    prefix,
    limit: limit.toString()
  });

  if (cursor) params.append('cursor', cursor);

  const response = await fetch(`${KV_API_BASE}/keys?${params}`, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` }
  });

  return await response.json();
}

// Example: Check if video is migrated
const sha256 = "abc123def456...";
const blobData = await getKV(`blob:${sha256}`);

if (blobData?.bunny?.status === 'ready') {
  console.log(`Video migrated: ${blobData.bunny.hlsUrl}`);
} else {
  console.log('Video not yet migrated to BunnyStream');
}
```

### 3. From Wrangler CLI

Quick lookups for debugging:

```bash
# Get a specific key
wrangler kv:key get "blob:abc123def456..." --namespace-id=YOUR_NAMESPACE_ID

# Put a key
wrangler kv:key put "blob:abc123def456..." '{"sha256":"abc123...","size":12345}' --namespace-id=YOUR_NAMESPACE_ID

# List keys with prefix
wrangler kv:key list --prefix "bunny:video:" --namespace-id=YOUR_NAMESPACE_ID

# Delete a key
wrangler kv:key delete "blob:abc123def456..." --namespace-id=YOUR_NAMESPACE_ID
```

### 4. From cURL (Direct API Access)

```bash
# Get KV value
curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/blob:abc123" \
  -H "Authorization: Bearer ${API_TOKEN}"

# Put KV value (URL-encoded form data)
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/blob:abc123" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -F 'value={"sha256":"abc123","size":12345}'
```

## Common Lookup Patterns

### Pattern 1: Check if video is migrated to BunnyStream

```javascript
async function isVideoMigrated(sha256, env) {
  const blobDataStr = await env.MEDIA_KV.get(`blob:${sha256}`);
  if (!blobDataStr) return false;

  const blobData = JSON.parse(blobDataStr);
  return blobData?.bunny?.status === 'ready';
}
```

### Pattern 2: Get BunnyStream URL for a video

```javascript
async function getBunnyStreamUrl(sha256, env) {
  const blobDataStr = await env.MEDIA_KV.get(`blob:${sha256}`);
  if (!blobDataStr) return null;

  const blobData = JSON.parse(blobDataStr);
  if (blobData?.bunny?.status !== 'ready') return null;

  return blobData.bunny.hlsUrl;
}
```

### Pattern 3: Find SHA256 from BunnyStream video ID

```javascript
async function getSha256FromVideoId(videoId, env) {
  const videoDataStr = await env.MEDIA_KV.get(`bunny:video:${videoId}`);
  if (!videoDataStr) return null;

  const videoData = JSON.parse(videoDataStr);
  return videoData.sha256;
}
```

### Pattern 4: Check if upload is in progress

```javascript
async function getUploadStatus(r2Key, env) {
  const tempDataStr = await env.MEDIA_KV.get(`upload-temp:${r2Key}`);
  if (!tempDataStr) return null;

  return JSON.parse(tempDataStr);
}
```

## KV Limitations & Best Practices

### Limitations
- **Write rate limits**: ~1 write/sec per key (eventually consistent)
- **Size limits**: 25 MB per value
- **List limits**: Max 1000 keys per list() call (use cursor for pagination)
- **No transactions**: Can't atomically update multiple keys

### Best Practices

1. **Cache KV reads locally** when processing batches:
   ```javascript
   const cache = new Map();
   async function getCached(key, env) {
     if (cache.has(key)) return cache.get(key);
     const value = await env.MEDIA_KV.get(key);
     cache.set(key, value);
     return value;
   }
   ```

2. **Batch operations** when possible:
   ```javascript
   // Instead of N separate writes, collect and write together
   const updates = [];
   for (const video of videos) {
     updates.push(env.MEDIA_KV.put(`blob:${video.sha256}`, JSON.stringify(video)));
   }
   await Promise.all(updates);
   ```

3. **Use TTLs** for temporary data:
   ```javascript
   await env.MEDIA_KV.put(key, value, { expirationTtl: 86400 });  // 24 hours
   ```

4. **Handle missing keys gracefully**:
   ```javascript
   const value = await env.MEDIA_KV.get(key);
   if (!value) {
     // Key doesn't exist or was deleted
     return null;
   }
   ```

## Finding Your KV Namespace ID

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **KV**
2. Find your namespace (e.g., "MEDIA_KV")
3. Copy the **Namespace ID** (shown in the list)
4. Add to your environment:
   ```bash
   export MEDIA_KV_NAMESPACE_ID="abc123def456..."
   ```

## Migration Workflow Using KV

### When a video is uploaded to BunnyStream:

1. **Initial upload** (src/streaming/upload-strategy.mjs):
   ```javascript
   await env.MEDIA_KV.put(
     `bunny:video:${videoId}`,
     JSON.stringify({ videoId, sha256, status: 'processing' }),
     { expirationTtl: 86400 * 30 }
   );
   ```

2. **Webhook receives encoding complete** (src/streaming/bunny-webhook.mjs):
   ```javascript
   // Update bunny:video entry
   await env.MEDIA_KV.put(`bunny:video:${videoId}`, JSON.stringify({
     videoId, sha256, status: 'ready', updatedAt: Date.now()
   }));

   // Update blob entry with BunnyStream info
   const blobData = await env.MEDIA_KV.get(`blob:${sha256}`);
   blobData.bunny = { videoId, hlsUrl, status: 'ready', ... };
   blobData.provider = 'dual';
   await env.MEDIA_KV.put(`blob:${sha256}`, JSON.stringify(blobData));
   ```

3. **CDN worker checks for redirect**:
   ```javascript
   const blobData = await env.MEDIA_KV.get(`blob:${sha256}`);
   if (blobData?.bunny?.status === 'ready') {
     return Response.redirect(blobData.bunny.hlsUrl, 302);
   }
   // Otherwise serve from R2
   ```

## Example: Complete Backfill Script

```javascript
import fetch from 'node-fetch';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const NAMESPACE_ID = process.env.MEDIA_KV_NAMESPACE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

async function checkBackfillStatus(sha256) {
  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/blob:${sha256}`;

  const response = await fetch(kvUrl, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` }
  });

  if (!response.ok) {
    console.log(`❌ ${sha256}: Not found in KV`);
    return false;
  }

  const blobData = await response.json();

  if (blobData?.bunny?.status === 'ready') {
    console.log(`✅ ${sha256}: Migrated to ${blobData.bunny.hlsUrl}`);
    return true;
  } else if (blobData?.bunny?.status === 'processing') {
    console.log(`⏳ ${sha256}: Processing...`);
    return false;
  } else {
    console.log(`⏺️  ${sha256}: Not yet migrated`);
    return false;
  }
}

// Check a batch of videos
const videos = ['abc123...', 'def456...', 'ghi789...'];
for (const sha256 of videos) {
  await checkBackfillStatus(sha256);
}
```

## Troubleshooting

**Problem:** KV reads return old data after write
- **Cause:** Eventually consistent propagation (usually < 60s)
- **Solution:** Add retry logic or wait briefly after writes

**Problem:** "Too Many Requests" errors
- **Cause:** Exceeding write rate limits
- **Solution:** Add delays between writes, batch updates

**Problem:** List returns incomplete results
- **Cause:** More than 1000 keys match prefix
- **Solution:** Use cursor-based pagination:
  ```javascript
  let cursor;
  do {
    const result = await env.MEDIA_KV.list({ prefix: 'blob:', cursor });
    // Process result.keys
    cursor = result.cursor;
  } while (cursor);
  ```

## Related Files

- `src/index.mjs` - Main worker with KV lookups
- `src/streaming/bunny-webhook.mjs` - Updates KV when videos encode
- `src/streaming/upload-strategy.mjs` - Writes KV during upload
- `wrangler.toml` - KV binding configuration
