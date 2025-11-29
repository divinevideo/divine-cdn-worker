# Old Video Latency Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce GET request latency for old videos from 695-1286ms to <200ms by parallelizing KV lookups and implementing lazy migration to optimal R2 paths.

**Architecture:** Currently, old videos require 4+ sequential KV calls and up to 3 sequential R2 path fallbacks. We parallelize the KV lookups using `Promise.all()` and add copy-on-read migration so videos served from fallback R2 paths get copied to the optimal `blobs/{sha256}` path.

**Tech Stack:** Cloudflare Workers, R2, KV

---

## Task 1: Parallelize KV Lookups in handleGetBlob

**Files:**
- Modify: `src/index.mjs:313-425` (handleGetBlob function)

**Step 1: Write test for parallel KV behavior**

Create a test file to verify the optimization works:

```javascript
// tests/test_parallel_kv.mjs
// Manual test - run against local dev server

const SHA256 = 'a'.repeat(64); // Test hash

async function testParallelKV() {
  const start = Date.now();

  // Make request to local dev server
  const response = await fetch(`http://localhost:8787/${SHA256}`);

  const elapsed = Date.now() - start;
  console.log(`Response: ${response.status} in ${elapsed}ms`);

  // For a non-existent blob, should be fast (parallel KV checks)
  // Previously would be 4x KV latency (~80-120ms), now should be ~20-30ms
  if (response.status === 404 && elapsed < 100) {
    console.log('✅ Parallel KV lookups working - fast 404');
  } else if (response.status === 404) {
    console.log(`⚠️ 404 but took ${elapsed}ms - KV might still be sequential`);
  }
}

testParallelKV();
```

**Step 2: Refactor handleGetBlob to parallelize KV lookups**

Replace the sequential KV lookups in `src/index.mjs` starting at line 313. The new implementation:

```javascript
/**
 * Handle GET/HEAD blob request
 */
async function handleGetBlob(sha256, isHead, blobStorage, metadataStore, req, env) {
  // Parallelize all KV lookups for latency reduction
  // These checks are independent and can run concurrently
  const [durationRejection, permanentBan, ageRestricted, metadata] = await Promise.all([
    env.MEDIA_KV?.get(`duration-rejected:${sha256}`),
    env.MODERATION_KV?.get(`permanent-ban:${sha256}`),
    env.MODERATION_KV?.get(`age-restricted:${sha256}`),
    metadataStore.getBlob(sha256)
  ]);

  // Check for duration rejection (videos exceeding length limit)
  if (durationRejection) {
    const rejection = JSON.parse(durationRejection);
    return new Response(JSON.stringify({
      error: 'duration_exceeded',
      message: `Videos longer than ${rejection.maxAllowed} seconds are not allowed on this service`,
      duration: rejection.duration,
      maxAllowed: rejection.maxAllowed,
      status: 400
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // Check for PERMANENT_BAN (never serve except to admins)
  if (permanentBan) {
    return new Response(JSON.stringify({
      error: 'content_banned',
      message: 'This content has been permanently removed and cannot be accessed',
      status: 451
    }), {
      status: 451,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // Check for AGE_RESTRICTED (requires user preferences)
  if (ageRestricted) {
    const restriction = JSON.parse(ageRestricted);

    // Check if user is authenticated and has appropriate preferences
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Nostr ')) {
      return new Response(JSON.stringify({
        error: 'authentication_required',
        message: `This content is age-restricted (${restriction.category}). Please authenticate with Nostr to access.`,
        category: restriction.category,
        status: 401
      }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'WWW-Authenticate': 'Nostr'
        }
      });
    }

    // Verify auth and check preferences (use 'get' action for retrieving content)
    const auth = await verifyBlossomAuth(req, env, { action: 'get' });
    if (!auth) {
      return new Response(JSON.stringify({
        error: 'invalid_auth',
        message: 'Invalid Nostr authentication',
        status: 401
      }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Fetch user preferences (NIP-78)
    const { fetchUserContentPreferences, checkContentAccess } = await import('./nip78-preferences.mjs');
    const preferences = await fetchUserContentPreferences(auth.pubkey);

    // Check if user has permission for this content category
    if (!checkContentAccess(preferences, restriction.category)) {
      return new Response(JSON.stringify({
        error: 'content_restricted',
        message: `You have not opted in to view ${restriction.category} content. Please update your content preferences.`,
        category: restriction.category,
        preferences_url: `https://divine.video/settings/content-preferences`,
        status: 403
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // User has permission, continue to serve content
    console.log(`[ACCESS] User ${auth.pubkey.substring(0,8)} granted access to ${restriction.category} content ${sha256.substring(0,8)}`);
  }

  // Note: REVIEW and SAFE content serve normally without restrictions
  // REVIEW content is logged by moderation service and published to Nostr for manual review

  // Check if blob exists in metadata
  if (!metadata) {
    return jsonResponse(404, { error: 'not_found', message: 'Blob not found' });
  }

  // REST OF FUNCTION UNCHANGED FROM LINE 427 ONWARDS
```

**Step 3: Run local dev server and test**

```bash
cd /Users/rabble/code/vine_fun/blossom-sdk-worker
npx wrangler dev &
sleep 3
node tests/test_parallel_kv.mjs
```

Expected: Fast 404 response (<100ms) for non-existent blob

**Step 4: Commit**

```bash
git add src/index.mjs tests/test_parallel_kv.mjs
git commit -m "perf: parallelize KV lookups in handleGetBlob for latency reduction"
```

---

## Task 2: Add Lazy Migration to R2BlobStorage

**Files:**
- Modify: `src/storage/r2-blob-storage.mjs:64-97` (readBlob method)

**Step 1: Update readBlob to copy files from fallback paths to optimal path**

The readBlob method tries 3 paths sequentially. When a file is found at a fallback path, we copy it to the optimal `blobs/{sha256}` path for future requests.

```javascript
async readBlob(sha256, options = {}) {
  const { range } = options;

  // Build R2 get options
  const r2Options = {};
  if (range) {
    r2Options.range = range;
  }

  // Try new path first (optimal)
  let obj = await this.r2.get(`blobs/${sha256}`, r2Options);
  let needsMigration = false;
  let sourceKey = null;

  // Fallback to old path for backward compatibility
  if (!obj) {
    obj = await this.r2.get(`videos/${sha256}.mp4`, r2Options);
    if (obj) {
      needsMigration = true;
      sourceKey = `videos/${sha256}.mp4`;
    }
  }

  // Fallback to root level (old old path)
  if (!obj) {
    obj = await this.r2.get(`${sha256}.mp4`, r2Options);
    if (obj) {
      needsMigration = true;
      sourceKey = `${sha256}.mp4`;
    }
  }

  if (!obj) {
    return null;
  }

  // Lazy migration: copy to optimal path for future requests
  // Only do this for full file reads (not range requests) to avoid partial copies
  if (needsMigration && !range) {
    // Clone the body for migration (need to read it twice)
    const [bodyForResponse, bodyForMigration] = obj.body.tee();

    // Fire-and-forget migration (don't block response)
    this.r2.put(`blobs/${sha256}`, bodyForMigration, {
      httpMetadata: {
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable'
      },
      customMetadata: {
        sha256: sha256,
        migratedFrom: sourceKey,
        migratedAt: new Date().toISOString()
      }
    }).then(() => {
      console.log(`[Migration] Copied ${sourceKey} -> blobs/${sha256}`);
    }).catch(err => {
      console.error(`[Migration] Failed to copy ${sourceKey}:`, err);
    });

    return {
      body: bodyForResponse,
      size: obj.size,
      type: obj.httpMetadata?.contentType || 'application/octet-stream',
      etag: obj.etag,
      range: obj.range
    };
  }

  return {
    body: obj.body,
    size: obj.size,
    type: obj.httpMetadata?.contentType || 'application/octet-stream',
    etag: obj.etag,
    range: obj.range
  };
}
```

**Step 2: Test migration locally**

```bash
# Upload a test file to old path in local R2 (requires wrangler dev)
# Then request it via sha256 and verify it gets copied to blobs/ path
```

**Step 3: Commit**

```bash
git add src/storage/r2-blob-storage.mjs
git commit -m "perf: add lazy migration from fallback R2 paths to optimal blobs/ path"
```

---

## Task 3: Parallelize KV Metadata Lookup for Old Format

**Files:**
- Modify: `src/storage/kv-metadata-store.mjs:28-51` (getBlob method)

**Step 1: Optimize getBlob to reduce sequential calls for old format**

Currently, old format requires: `idx:sha256:` -> parse -> `video:{uid}` (2 sequential calls).
We can't fully parallelize this (second call depends on first), but we can optimize the common case.

```javascript
async getBlob(sha256) {
  // Try new format first (single call, most common case for new videos)
  const data = await this.kv.get(`blob:${sha256}`);
  if (data) return JSON.parse(data);

  // Fallback to old format for backward compatibility
  const oldIndex = await this.kv.get(`idx:sha256:${sha256}`);
  if (oldIndex) {
    const { uid } = JSON.parse(oldIndex);
    const videoData = await this.kv.get(`video:${uid}`);
    if (videoData) {
      const video = JSON.parse(videoData);
      const newFormatBlob = {
        sha256: video.sha256 || sha256,
        size: video.size || 0,
        type: video.contentType || 'video/mp4',
        uploaded: Math.floor((video.createdAt || Date.now()) / 1000)
      };

      // Lazy migration: write new format for future requests (fire-and-forget)
      this.kv.put(`blob:${sha256}`, JSON.stringify(newFormatBlob))
        .then(() => console.log(`[KV Migration] Migrated metadata for ${sha256.substring(0,8)}`))
        .catch(err => console.error(`[KV Migration] Failed:`, err));

      return newFormatBlob;
    }
  }

  return null;
}
```

**Step 2: Commit**

```bash
git add src/storage/kv-metadata-store.mjs
git commit -m "perf: add lazy KV metadata migration from old to new format"
```

---

## Task 4: Deploy and Verify

**Step 1: Run local tests**

```bash
cd /Users/rabble/code/vine_fun/blossom-sdk-worker
npx wrangler dev
# In another terminal:
node tests/test_parallel_kv.mjs
```

**Step 2: Deploy to production**

```bash
npx wrangler deploy --env production
```

**Step 3: Monitor latency in Cloudflare dashboard**

Check the Analytics tab for:
- Reduced "fetch" origin request times
- Worker CPU time should be similar (parallelization doesn't reduce CPU, just wall time)

**Step 4: Commit any final changes and push**

```bash
git push origin main
```

---

## Summary of Changes

| File | Change | Impact |
|------|--------|--------|
| `src/index.mjs` | Parallelize 4 KV lookups with `Promise.all()` | ~60-80ms latency reduction |
| `src/storage/r2-blob-storage.mjs` | Lazy migration from fallback R2 paths | Self-healing, future requests use optimal path |
| `src/storage/kv-metadata-store.mjs` | Lazy KV metadata format migration | Reduces KV calls for migrated videos |

**Expected Result:** First request to old video still slower (migration happening), but subsequent requests should be <200ms instead of 695-1286ms.
