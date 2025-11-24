// ABOUTME: Experimental Cloudflare Worker using blossom-server-sdk
// ABOUTME: Implements Blossom protocol endpoints using SDK abstractions

import { R2BlobStorage } from './storage/r2-blob-storage.mjs';
import { KVMetadataStore } from './storage/kv-metadata-store.mjs';
import { validateProofMode, storeVerificationResult } from './proofmode-validator.mjs';
import { BunnyWebhookHandler } from './streaming/bunny-webhook.mjs';
import { PlaybackResolver } from './streaming/playback-resolver.mjs';
import { selectUploadStrategy, BunnyUploadHandler } from './streaming/upload-strategy.mjs';
import { handleBunnyAPI } from './streaming/bunny-api.mjs';

/**
 * Cloudflare Worker entry point
 */
export default {
  async scheduled(event, env, ctx) {
    // Cron job for cleanup and backfill
    console.log('[Cron] Starting scheduled tasks');

    try {
      // Get current page from KV (track progress)
      const cleanupState = await env.MEDIA_KV.get('cleanup:state', { type: 'json' }) || { page: 1 };

      // Run one page of cleanup
      const cleanupRequest = new Request('https://fake/cleanup-duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: cleanupState.page, dryRun: false })
      });

      const cleanupResponse = await handleCleanupDuplicates(cleanupRequest, env);
      const cleanupResult = await cleanupResponse.json();

      console.log(`[Cron] Cleanup page ${cleanupState.page}: deleted ${cleanupResult.deleted} duplicates`);

      // Update state for next run
      if (cleanupResult.hasMore) {
        await env.MEDIA_KV.put('cleanup:state', JSON.stringify({ page: cleanupResult.nextPage }));
      } else {
        // Finished all pages, reset to page 1 for next cycle
        await env.MEDIA_KV.put('cleanup:state', JSON.stringify({ page: 1 }));
        console.log('[Cron] Cleanup cycle complete, reset to page 1');
      }

    } catch (error) {
      console.error('[Cron] Scheduled task error:', error);
    }
  },

  async fetch(request, env, ctx) {
    try {
      // Parse request
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      // Handle CORS preflight
      if (method === 'OPTIONS') {
        const response = new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ProofMode-Manifest, X-ProofMode-Signature, X-ProofMode-Attestation',
            'Access-Control-Max-Age': '86400',
            'Cache-Control': 'public, max-age=86400'  // Cache for 24 hours
          }
        });
        // Cache OPTIONS to reduce preflight latency from 50-200ms to 1-5ms
        return await cacheAndReturn(response, request, url);
      }

      // Cloudflare Cache API - Early exit for cached content
      // Only check cache for GET/HEAD requests (immutable content)
      // SKIP cache for Range requests - they need to be handled by the origin
      // to correctly return 206 Partial Content responses
      if ((method === 'GET' || method === 'HEAD') && !request.headers.has('range')) {
        try {
          const cache = caches.default;
          // Normalize cache key (use GET method for both GET and HEAD)
          // IMPORTANT: Don't include headers - prevents cache fragmentation
          const cacheKey = new Request(url.toString(), {
            method: 'GET'
          });

          const cachedResponse = await cache.match(cacheKey);

          if (cachedResponse) {
            console.log(`[Cache HIT] ${url.pathname}`);
            // Add custom header to indicate cache hit
            const headers = new Headers(cachedResponse.headers);
            headers.set('X-Cache-Status', 'HIT');
            return new Response(cachedResponse.body, {
              status: cachedResponse.status,
              statusText: cachedResponse.statusText,
              headers
            });
          }

          console.log(`[Cache MISS] ${url.pathname}`);
        } catch (cacheError) {
          // Cache failures are non-fatal - log and continue to normal logic
          console.error('[Cache ERROR] Failed to read cache:', cacheError);
        }
      }

      // Initialize storage backends
      const blobStorage = new R2BlobStorage(env.R2_BLOBS);
      const metadataStore = new KVMetadataStore(env.MEDIA_KV);

      // POST /webhooks/bunny - BunnyStream webhook handler
      // Processes video encoding completion events from BunnyStream
      if (url.pathname === '/webhooks/bunny' && method === 'POST') {
        const handler = new BunnyWebhookHandler();
        return await handler.process(request, env);
      }

      // GET /bunny/* - Public read-only API for querying Bunny video data
      // Provides video metadata and webhook event history from D1 database
      if (method === 'GET' && url.pathname.startsWith('/bunny/')) {
        return await handleBunnyAPI(request, env, url.pathname);
      }

      // POST /backfill-video - Backfill old video to BunnyStream
      // Uploads existing R2 video to BunnyStream for HLS encoding and thumbnail generation
      if (url.pathname === '/backfill-video' && method === 'POST') {
        return await handleBackfillVideo(request, env);
      }

      // POST /backfill-batch - Batch backfill multiple videos
      // Lists R2 videos and backfills them to BunnyStream
      if (url.pathname === '/backfill-batch' && method === 'POST') {
        return await handleBackfillBatch(request, env);
      }

      // POST /debug-r2-list - DEBUG: Show raw R2 file list with sizes
      if (url.pathname === '/debug-r2-list' && method === 'POST') {
        return await handleDebugR2List(request, env);
      }

      // POST /index-uploads-batch - Build SHA256 index for uploads/ files
      if (url.pathname === '/index-uploads-batch' && method === 'POST') {
        return await handleIndexUploadsBatch(request, env);
      }

      // GET /video-status/{sha256} - Check video processing status
      // Returns current status and available URLs for a video
      if (method === 'GET') {
        const statusMatch = url.pathname.match(/^\/video-status\/([a-f0-9]{64})$/);
        if (statusMatch) {
          return await handleVideoStatus(statusMatch[1], env);
        }
      }

      // GET /list-backfilled?status=ready - List backfilled videos by status
      // Returns videos with their encoding status for batch republishing
      if (method === 'GET' && url.pathname === '/list-backfilled') {
        return await handleListBackfilled(request, env);
      }

      // POST /retry-failed - Retry failed video uploads
      // Queries BunnyStream for failed uploads and retries them
      if (method === 'POST' && url.pathname === '/retry-failed') {
        return await handleRetryFailed(request, env);
      }

      // POST /cleanup-duplicates - Clean up duplicate videos in BunnyStream
      // Finds and deletes duplicate videos, keeping only the newest of each
      if (method === 'POST' && url.pathname === '/cleanup-duplicates') {
        return await handleCleanupDuplicates(request, env);
      }

      // Route requests
      // GET / - Home page
      if (method === 'GET' && url.pathname === '/') {
        const response = new Response(getHomePage(), {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=300'
          }
        });
        return await cacheAndReturn(response, request, url);
      }

      // TEMP: GET /_list_r2 - List R2 contents for debugging
      if (method === 'GET' && url.pathname === '/_list_r2') {
        const prefix = url.searchParams.get('prefix') || '';
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const cursor = url.searchParams.get('cursor') || undefined;
        const listed = await env.R2_BLOBS.list({ prefix, limit, cursor });
        const objects = listed.objects.map(obj => ({ key: obj.key, size: obj.size }));
        return jsonResponse(200, { prefix, count: objects.length, truncated: listed.truncated, cursor: listed.cursor, objects });
      }

      // GET /{sha256}.m3u8 - HLS playlist endpoint
      // Returns redirect to BunnyStream HLS URL if available
      if ((method === 'GET' || method === 'HEAD') && url.pathname.endsWith('.m3u8')) {
        const pathWithoutExt = url.pathname.slice(0, -5); // Remove .m3u8
        const sha256Match = pathWithoutExt.match(/^\/([a-f0-9]{64})$/);
        if (sha256Match) {
          const sha256 = sha256Match[1];

          // PlaybackResolver checks duration rejection internally
          const resolver = new PlaybackResolver();
          const result = await resolver.resolveUrl(sha256, 'hls', env);

          if (result && result.url) {
            const response = Response.redirect(result.url, 302);
            return await cacheAndReturn(response, request, url);
          }
          const response = new Response('HLS playlist not available', { status: 404 });
          return await cacheAndReturn(response, request, url);
        }
      }

      // OLD: GET /{uid}/... - Legacy video URLs (thumbnails, manifests, etc)
      // These are 32-character hex UIDs from the old Cloudflare Stream system
      if (method === 'GET' || method === 'HEAD') {
        const uidMatch = url.pathname.match(/^\/([a-f0-9]{32})\/(.*)/);
        if (uidMatch) {
          const uid = uidMatch[1];
          const subpath = uidMatch[2];
          const response = await handleLegacyUidUrl(uid, subpath, method === 'HEAD', request, env);
          return await cacheAndReturn(response, request, url);
        }
      }

      // GET /uploads/* - Serve ArchiveTeam Vine files from R2
      // These are legacy Vine videos with original filenames (e.g., uploads/1465583916-OlxhFJh6iiM.mp4)
      if (method === 'GET' || method === 'HEAD') {
        if (url.pathname.startsWith('/uploads/')) {
          const response = await handleUploadsFile(url.pathname, method === 'HEAD', request, env);
          return await cacheAndReturn(response, request, url);
        }
      }

      // GET /<sha256> - Retrieve blob
      if (method === 'GET' || method === 'HEAD') {
        const match = url.pathname.match(/^\/([a-f0-9]{64})(\.[a-z0-9]+)?$/);
        if (match) {
          const response = await handleGetBlob(match[1], method === 'HEAD', blobStorage, metadataStore, request, env);
          return await cacheAndReturn(response, request, url);
        }
      }

      // PUT/POST /upload - Upload blob (accept both per Postel's Law)
      if ((method === 'PUT' || method === 'POST') && url.pathname === '/upload') {
        return await handleUploadBlob(request, blobStorage, metadataStore, env, ctx);
      }

      // GET /list/<pubkey> - List user's blobs
      if (method === 'GET') {
        const match = url.pathname.match(/^\/list\/([a-f0-9]{64})$/);
        if (match) {
          return await handleListBlobs(match[1], metadataStore);
        }
      }

      // DELETE /<sha256> - Delete blob
      if (method === 'DELETE') {
        const match = url.pathname.match(/^\/([a-f0-9]{64})(\.[a-z0-9]+)?$/);
        if (match) {
          return await handleDeleteBlob(request, match[1], blobStorage, metadataStore, env);
        }
      }

      const response = jsonResponse(404, { error: 'not_found' });
      return await cacheAndReturn(response, request, url);

    } catch (error) {
      console.error('Worker error:', error);
      // 500 errors are NOT cached (see shouldCache() line ~2000)
      // This ensures transient failures don't get permanently cached
      return jsonResponse(500, { error: 'internal_server_error' });
    }
  }
};

/**
 * Handle GET/HEAD blob request
 */
async function handleGetBlob(sha256, isHead, blobStorage, metadataStore, req, env) {
  // Check for duration rejection first (videos exceeding length limit)
  if (env.MEDIA_KV) {
    const durationRejection = await env.MEDIA_KV.get(`duration-rejected:${sha256}`);
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
  }

  // Check moderation status (tiered access control)
  if (env.MODERATION_KV) {
    // Check for PERMANENT_BAN first (never serve except to admins)
    const permanentBan = await env.MODERATION_KV.get(`permanent-ban:${sha256}`);
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
    const ageRestricted = await env.MODERATION_KV.get(`age-restricted:${sha256}`);
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

      // Verify auth and check preferences
      const auth = await verifyBlossomAuth(req, env);
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
  }

  // Note: REVIEW and SAFE content serve normally without restrictions
  // REVIEW content is logged by moderation service and published to Nostr for manual review

  // Check if blob exists in metadata
  const metadata = await metadataStore.getBlob(sha256);
  if (!metadata) {
    return new Response('Not Found', { status: 404 });
  }

  // For HEAD requests, return just headers
  if (isHead) {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': metadata.type || 'application/octet-stream',
        'Content-Length': metadata.size?.toString() || '0',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  // Check for range request BEFORE fetching blob
  const rangeHeader = req.headers.get('range');
  let blob;

  if (rangeHeader) {
    // Parse range request
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : metadata.size - 1;

    // Fetch only the requested range from R2
    blob = await blobStorage.readBlob(sha256, {
      range: { offset: start, length: end - start + 1 }
    });

    if (!blob) {
      return new Response('Not Found', { status: 404 });
    }

    // Return 206 Partial Content
    const headers = new Headers();
    headers.set('Content-Type', blob.type || 'application/octet-stream');
    headers.set('Content-Range', `bytes ${start}-${end}/${metadata.size}`);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', (end - start + 1).toString());
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');

    if (blob.etag) {
      headers.set('ETag', blob.etag);
    }

    return new Response(blob.body, {
      status: 206,
      headers
    });
  }

  // Regular GET request - fetch entire blob
  blob = await blobStorage.readBlob(sha256);
  if (!blob) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', blob.type || 'application/octet-stream');
  headers.set('Content-Length', blob.size.toString());
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  if (blob.etag) {
    headers.set('ETag', blob.etag);
  }

  return new Response(blob.body, {
    status: 200,
    headers
  });
}

/**
 * Handle GET/HEAD for uploads/ files (ArchiveTeam Vine videos)
 * These files are stored in R2 with their original filenames
 */
async function handleUploadsFile(pathname, isHead, req, env) {
  // Extract the R2 key from the pathname (remove leading /)
  const r2Key = pathname.slice(1); // e.g., "uploads/1465583916-OlxhFJh6iiM.mp4"

  // Fetch file from R2
  const r2Object = await env.R2_BLOBS.get(r2Key);

  if (!r2Object) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // For HEAD requests, return just headers
  if (isHead) {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': r2Object.httpMetadata?.contentType || 'video/mp4',
        'Content-Length': r2Object.size?.toString() || '0',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  // Check for range request
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    // Parse range request
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : r2Object.size - 1;

    // Fetch only the requested range from R2
    const rangedObject = await env.R2_BLOBS.get(r2Key, {
      range: { offset: start, length: end - start + 1 }
    });

    if (!rangedObject) {
      return new Response('Range Not Satisfiable', { status: 416 });
    }

    // Return 206 Partial Content
    return new Response(rangedObject.body, {
      status: 206,
      headers: {
        'Content-Type': rangedObject.httpMetadata?.contentType || 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${r2Object.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start + 1).toString(),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  // Regular GET request - return entire file
  return new Response(r2Object.body, {
    status: 200,
    headers: {
      'Content-Type': r2Object.httpMetadata?.contentType || 'video/mp4',
      'Content-Length': r2Object.size?.toString() || '0',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}

/**
 * Handle blob upload (PUT /upload)
 */
async function handleUploadBlob(request, blobStorage, metadataStore, env, ctx) {
  // Verify authentication
  const auth = await verifyBlossomAuth(request, env);
  if (!auth) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // Get blob data
  const blob = await request.arrayBuffer();
  const size = blob.byteLength;
  const contentType = request.headers.get('content-type') || 'application/octet-stream';

  // Calculate SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', blob);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  console.log(`Upload: sha256=${sha256}, size=${size}, type=${contentType}, owner=${auth.pubkey}`);

  // Validate hash if provided in auth event
  const authHash = auth.event?.tags?.find(t => t[0] === 'x')?.[1];
  if (authHash && authHash !== sha256) {
    return jsonResponse(400, {
      error: 'hash_mismatch',
      message: 'SHA-256 in auth does not match uploaded data'
    });
  }

  // Check if blob already exists
  if (await metadataStore.hasBlob(sha256)) {
    const existing = await metadataStore.getBlob(sha256);
    const domain = env.STREAM_DOMAIN || 'cdn.divine.video';
    const fileExt = getFileExtension(existing.type || contentType);

    return jsonResponse(200, {
      url: `https://${domain}/${sha256}${fileExt}`,
      sha256,
      size: existing.size || size,
      type: existing.type || contentType,
      uploaded: existing.uploaded
    });
  }

  // Validate ProofMode
  let proofModeResult;
  try {
    proofModeResult = await validateProofMode(request, sha256, blob);
    console.log(`ProofMode validation result: ${JSON.stringify(proofModeResult)}`);
  } catch (error) {
    console.error('ProofMode validation error:', error);
    proofModeResult = {
      verified: false,
      level: 'unverified',
      message: 'ProofMode validation error'
    };
  }

  // Require ProofMode verification for video uploads
  const isVideo = contentType.startsWith('video/');
  if (isVideo && env.REQUIRE_PROOFMODE_FOR_VIDEOS === 'true') {
    // Check if ProofMode is verified (at least verified_web level)
    const isProofModeVerified = proofModeResult.verified &&
      (proofModeResult.level === 'verified_mobile' || proofModeResult.level === 'verified_web');

    if (!isProofModeVerified) {
      return jsonResponse(400, {
        error: 'proofmode_required',
        message: 'Video uploads require ProofMode verification. Please include X-ProofMode-Manifest and X-ProofMode-Signature headers.',
        proofmode_level: proofModeResult.level,
        proofmode_message: proofModeResult.message,
        required_level: 'verified_web or verified_mobile',
        documentation: 'https://github.com/guardianproject/proofmode'
      });
    }

    console.log(`✅ Video upload with verified ProofMode: level=${proofModeResult.level}, fingerprint=${proofModeResult.deviceFingerprint}`);
  }

  // Generate UID for this blob
  const uid = crypto.randomUUID().replace(/-/g, '');

  // Upload Strategy: Route video uploads to BunnyStream or R2 based on feature flags
  let bunnyMetadata = null;
  if (isVideo) {
    const strategy = await selectUploadStrategy(env, sha256, { size, type: contentType });

    if (strategy.shouldUseBunny) {
      // Upload to BunnyStream for HLS encoding
      const bunnyHandler = new BunnyUploadHandler(env);
      const uploadResult = await bunnyHandler.initiateUpload(sha256, { size, type: contentType }, env);

      if (uploadResult) {
        bunnyMetadata = {
          videoId: uploadResult.videoId,
          guid: uploadResult.guid,
          libraryId: env.BUNNY_STREAM_LIBRARY_ID,
          status: 'uploading',
          uploadedAt: Math.floor(Date.now() / 1000)
        };

        console.log(`[BunnyUpload] Video ${sha256.substring(0, 16)}... routed to Bunny (videoId: ${uploadResult.videoId})`);

        // Upload the video file to Bunny's upload URL
        await fetch(uploadResult.uploadUrl, {
          method: 'PUT',
          body: blob,
          headers: {
            'Content-Type': contentType,
            'AccessKey': env.BUNNY_STREAM_ACCESS_KEY
          }
        });
      }
    }
  }

  // Store blob with metadata (including ProofMode verification)
  // Always store in R2 for now as backup/fallback
  await blobStorage.writeBlob(sha256, blob, contentType, auth.pubkey, uid, proofModeResult);

  // Store ProofMode verification result in KV
  if (env.MEDIA_KV) {
    try {
      await storeVerificationResult(sha256, proofModeResult, env.MEDIA_KV);
    } catch (error) {
      console.error('Failed to store ProofMode verification result:', error);
    }
  }

  // Store metadata (including Bunny info if video was uploaded to BunnyStream)
  const now = Math.floor(Date.now() / 1000);
  const metadata = {
    sha256,
    size,
    type: contentType,
    uploaded: now
  };

  // Add Bunny metadata if video was routed to BunnyStream
  if (bunnyMetadata) {
    metadata.bunny = bunnyMetadata;
    metadata.provider = 'dual'; // Both R2 and Bunny
  }

  await metadataStore.addBlob(metadata);

  // Store owner relationship
  await metadataStore.addBlobOwner(sha256, auth.pubkey);

  // Send to moderation queue (non-blocking)
  if (env.MODERATION_ENABLED === 'true' && env.MODERATION_QUEUE && ctx) {
    const uploadTimestamp = Date.now();
    ctx.waitUntil(
      env.MODERATION_QUEUE.send({
        sha256,
        uploadedBy: auth.pubkey,
        uploadedAt: uploadTimestamp,
        metadata: {
          fileSize: size,
          contentType,
          duration: 6, // Placeholder - would need actual duration detection
          proofMode: {
            verified: proofModeResult.verified,
            level: proofModeResult.level
          }
        }
      }).catch(err => {
        console.error('Failed to queue for moderation:', err);
      })
    );
  }

  const domain = env.STREAM_DOMAIN || 'cdn.divine.video';
  const fileExt = getFileExtension(contentType);

  // For videos routed to BunnyStream, construct streaming URLs
  let primaryUrl = `https://${domain}/${sha256}${fileExt}`;
  let hlsUrl = null;
  let mp4Url = null;
  let thumbnailUrl = null;

  if (bunnyMetadata) {
    const pullZone = env.BUNNY_STREAM_PULL_ZONE || 'stream.divine.video';
    hlsUrl = `https://${pullZone}/${bunnyMetadata.videoId}/playlist.m3u8`;
    mp4Url = `https://${pullZone}/${bunnyMetadata.videoId}/play_480p.mp4`;
    thumbnailUrl = `https://${pullZone}/${bunnyMetadata.videoId}/thumbnail.jpg`;
    // For videos, return streaming URL as primary
    primaryUrl = hlsUrl;
  }

  const response = {
    url: primaryUrl,
    sha256,
    size,
    type: contentType,
    uploaded: now,
    proofmode: {
      verified: proofModeResult.verified,
      level: proofModeResult.level,
      deviceFingerprint: proofModeResult.deviceFingerprint,
      timestamp: proofModeResult.timestamp
    }
  };

  // Add streaming info if video was routed to BunnyStream
  if (bunnyMetadata) {
    response.streaming = {
      status: 'processing',
      hlsUrl: hlsUrl,
      mp4Url: mp4Url,
      thumbnailUrl: thumbnailUrl,
      provider: 'bunny',
      message: 'Video is being encoded. All URLs will be ready in 30-120 seconds.'
    };
    // Also provide R2 MP4 as fallback
    response.fallbackUrl = `https://${domain}/${sha256}${fileExt}`;
  }

  return jsonResponse(200, response);
}

/**
 * Handle list blobs request
 */
async function handleListBlobs(pubkey, metadataStore) {
  const blobs = await metadataStore.getBlobsForPubkey(pubkey);
  return jsonResponse(200, blobs);
}

/**
 * Handle delete blob request
 */
async function handleDeleteBlob(request, sha256, blobStorage, metadataStore, env) {
  // Verify authentication
  const auth = await verifyBlossomAuth(request, env);
  if (!auth) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // Check if blob exists
  const metadata = await metadataStore.getBlob(sha256);
  if (!metadata) {
    return jsonResponse(404, { error: 'not_found' });
  }

  // Check ownership
  const isOwner = await metadataStore.hasBlobOwner(sha256, auth.pubkey);
  if (!isOwner) {
    return jsonResponse(403, { error: 'forbidden' });
  }

  // Delete blob
  await blobStorage.removeBlob(sha256);
  await metadataStore.removeBlob(sha256);
  await metadataStore.removeBlobOwner(sha256, auth.pubkey);

  return new Response(null, { status: 204 });
}

/**
 * Verify Blossom authentication (kind 24242)
 * Implements full Nostr signature verification per NIP-01
 */
async function verifyBlossomAuth(request, env) {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return null;
  }

  try {
    const base64Event = authHeader.slice(6).trim();

    // Simple pubkey format for dev ONLY
    if (env.DEV_AUTH_MODE === 'true' && base64Event.startsWith('pubkey=')) {
      const pubkey = base64Event.slice(7);
      if (pubkey.match(/^[a-f0-9]{64}$/)) {
        console.log('DEV_AUTH_MODE: Bypassing signature verification');
        return { pubkey };
      }
      return null;
    }

    // Parse event
    const eventJson = base64ToString(base64Event);
    const event = JSON.parse(eventJson);

    if (event.kind !== 24242) {
      console.error(`Invalid event kind: ${event.kind} (expected 24242 for Blossom, got ${event.kind === 27235 ? 'NIP-98' : 'unknown'})`);
      return null;
    }

    // Verify event signature (CRITICAL SECURITY - secure by default)
    // Only skip verification if explicitly set to 'true' (dev/test mode)
    if (env.DEV_AUTH_MODE === 'true') {
      console.log('⚠️ DEV_AUTH_MODE: Skipping signature verification for event');
      return { pubkey: event.pubkey, event };
    }

    // Default: ALWAYS verify signatures (secure by default)
    const isValid = await verifyNostrSignature(event);
    if (!isValid) {
      console.error('❌ Invalid signature for event:', event.id?.substring(0, 8));
      return null;
    }

    console.log(`✅ Valid signature for pubkey ${event.pubkey.substring(0, 8)}...`);
    return { pubkey: event.pubkey, event };

  } catch (error) {
    console.error('Auth error:', error);
    return null;
  }
}

/**
 * Verify Nostr event signature per NIP-01
 * Returns true if signature is valid, false otherwise
 */
async function verifyNostrSignature(event) {
  try {
    // Import schnorr from @noble/curves
    const { schnorr } = await import('@noble/curves/secp256k1.js');

    // 1. Calculate event ID per NIP-01
    // Serialize as: [0, pubkey, created_at, kind, tags, content]
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags || [],
      event.content || ''
    ]);

    // 2. SHA-256 hash of serialized data
    const encoder = new TextEncoder();
    const data = encoder.encode(serialized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);

    // Convert to hex string
    const eventId = Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // 3. Verify event ID matches
    if (event.id !== eventId) {
      console.error('Event ID mismatch:', { expected: eventId, got: event.id });
      return false;
    }

    // 4. Verify Schnorr signature
    // Convert hex strings to Uint8Array
    const signature = hexToBytes(event.sig);
    const pubkey = hexToBytes(event.pubkey);
    const message = hashArray;

    // Verify using Schnorr (BIP-340)
    const isValid = schnorr.verify(signature, message, pubkey);

    return isValid;

  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Base64 to string decoder
 */
function base64ToString(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Get file extension from MIME type
 */
function getFileExtension(mimeType) {
  const typeMap = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/octet-stream': '.bin'
  };
  return typeMap[mimeType] || '.bin';
}

/**
 * Retry failed video uploads (batched)
 * Queries BunnyStream for VIRUS_DETECTED videos and retries them
 * Accepts startPage and maxPages to process in batches
 */
async function handleRetryFailed(request, env) {
  const { BunnyStreamClient, VideoStatus } = await import('./streaming/bunny-client.mjs');

  // Parse request body for batch parameters
  let startPage = 1;
  let maxPages = 1; // Process 1 page (100 videos) per request by default to avoid timeout

  try {
    const body = await request.json();
    if (body.startPage) startPage = parseInt(body.startPage);
    if (body.maxPages) maxPages = parseInt(body.maxPages);
  } catch (e) {
    // No body or invalid JSON, use defaults
  }

  const bunnyClient = new BunnyStreamClient(
    env.BUNNY_STREAM_ACCESS_KEY,
    env.BUNNY_STREAM_LIBRARY_ID
  );

  const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';

  let retried = 0;
  let failed = 0;
  let notFound = 0;
  let skipped = 0;
  let currentPage = startPage;
  const endPage = startPage + maxPages - 1;

  console.log(`[RetryFailed] Processing pages ${startPage}-${endPage}...`);

  while (currentPage <= endPage) {
    const result = await bunnyClient.listVideos(currentPage, 100);

    if (result.items.length === 0) {
      console.log(`[RetryFailed] No more videos at page ${currentPage}`);
      break;
    }

    for (const video of result.items) {
      // Only retry virus_detected videos
      if (video.status !== VideoStatus.VIRUS_DETECTED) {
        skipped++;
        continue;
      }

      // Extract identifier from title (e.g., "Video 1754062302456-2c")
      const match = video.title.match(/Video (\d+-[a-f0-9]+)/);
      if (!match) {
        console.log(`[RetryFailed] Skipping ${video.guid}: can't parse title "${video.title}"`);
        failed++;
        continue;
      }

      const partialId = match[1];

      // Find the full filename in R2 by listing with prefix
      const listed = await env.R2_BLOBS.list({
        prefix: `uploads/${partialId}`,
        limit: 1
      });

      if (listed.objects.length === 0) {
        console.log(`[RetryFailed] Skipping ${video.guid}: file not found in R2 (uploads/${partialId})`);
        notFound++;
        continue;
      }

      const r2Key = listed.objects[0].key;
      const sourceUrl = `https://${cdnDomain}/${r2Key}`;

      try {
        await bunnyClient.uploadFromUrl(video.guid, sourceUrl);
        console.log(`[RetryFailed] ✅ Retried ${video.guid}: ${r2Key}`);
        retried++;
      } catch (error) {
        console.error(`[RetryFailed] ❌ Failed to retry ${video.guid}:`, error.message);
        failed++;
      }

      // No rate limit - let BunnyStream handle it
      // await new Promise(resolve => setTimeout(resolve, 100));
    }

    currentPage++;
  }

  const nextPage = currentPage;
  const hasMore = currentPage <= endPage; // If we stopped early, there's more

  return jsonResponse(200, {
    retried,
    failed,
    notFound,
    skipped,
    pagesProcessed: currentPage - startPage,
    nextPage: hasMore ? null : nextPage,
    message: `Pages ${startPage}-${currentPage - 1}: retried ${retried}, failed ${failed}, not found ${notFound}, skipped ${skipped}`
  });
}

/**
 * JSON response helper
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * DEBUG: List raw R2 files with sizes
 * POST /debug-r2-list
 */
async function handleDebugR2List(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit) || 100, 1000);
    const cursor = body.cursor || undefined;

    const listed = await env.R2_BLOBS.list({ limit, cursor });

    const files = listed.objects.map(obj => ({
      key: obj.key,
      size: obj.size,
      sizeKB: Math.round(obj.size / 1024),
      sizeMB: (obj.size / 1024 / 1024).toFixed(2),
      passesFilter: obj.size >= 200000 && obj.size <= 20000000,
      isMp4: obj.key.endsWith('.mp4'),
      isSha256Format: /^[a-f0-9]{64}\.mp4$/.test(obj.key)
    }));

    const stats = {
      total: files.length,
      mp4Files: files.filter(f => f.isMp4).length,
      sha256Format: files.filter(f => f.isSha256Format).length,
      passFilter: files.filter(f => f.passesFilter && f.isSha256Format).length,
      tooSmall: files.filter(f => f.size < 200000 && f.isMp4).length,
      tooLarge: files.filter(f => f.size > 20000000 && f.isMp4).length
    };

    return jsonResponse(200, {
      stats,
      files: files.slice(0, 50), // First 50 for inspection
      pagination: {
        truncated: listed.truncated,
        cursor: listed.cursor
      }
    });
  } catch (error) {
    return jsonResponse(500, { error: error.message });
  }
}

/**
 * Build SHA256 index for uploads/ files
 * POST /index-uploads-batch
 * Body: { "batchSize": 50, "cursor": "optional" }
 */
async function handleIndexUploadsBatch(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const batchSize = Math.min(parseInt(body.batchSize) || 50, 100);
    const cursor = body.cursor || undefined;

    console.log(`[IndexUploads] Starting batch: size=${batchSize}, cursor=${cursor}`);

    // List uploads/ files from R2
    const listed = await env.R2_BLOBS.list({
      prefix: 'uploads/',
      limit: batchSize,
      cursor
    });

    const results = {
      processed: 0,
      indexed: 0,
      skipped: 0,
      errors: 0
    };

    // Process each file
    for (const obj of listed.objects) {
      if (!obj.key.endsWith('.mp4')) {
        continue; // Skip non-MP4 files
      }

      results.processed++;

      try {
        // Check if already indexed
        const existing = await env.MEDIA_KV.get(`upload-index:${obj.key}`);
        if (existing) {
          console.log(`[IndexUploads] Already indexed: ${obj.key}`);
          results.skipped++;
          continue;
        }

        // Download and calculate SHA256
        const r2Object = await env.R2_BLOBS.get(obj.key);
        if (!r2Object) {
          console.error(`[IndexUploads] File not found: ${obj.key}`);
          results.errors++;
          continue;
        }

        const arrayBuffer = await r2Object.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        // Store index mapping
        await env.MEDIA_KV.put(`upload-index:${obj.key}`, sha256);
        console.log(`[IndexUploads] Indexed ${obj.key} -> ${sha256.substring(0, 12)}...`);
        results.indexed++;

      } catch (error) {
        console.error(`[IndexUploads] Error processing ${obj.key}:`, error);
        results.errors++;
      }
    }

    return jsonResponse(200, {
      ...results,
      hasMore: listed.truncated,
      cursor: listed.cursor
    });

  } catch (error) {
    console.error('[IndexUploads] Handler error:', error);
    return jsonResponse(500, { error: error.message });
  }
}

/**
 * Handle backfill video request
 * POST /backfill-video
 * Body: { "sha256": "abc123..." }
 */
async function handleBackfillVideo(request, env) {
  try {
    const body = await request.json();
    const { sha256 } = body;

    if (!sha256 || !sha256.match(/^[a-f0-9]{64}$/)) {
      return jsonResponse(400, { error: 'invalid_sha256' });
    }

    // Check if video exists in R2 (try all legacy paths for backward compatibility)
    let videoExists = await env.R2_BLOBS.head(`blobs/${sha256}`);
    if (!videoExists) {
      videoExists = await env.R2_BLOBS.head(`videos/${sha256}.mp4`);
    }
    if (!videoExists) {
      videoExists = await env.R2_BLOBS.head(`${sha256}.mp4`);
    }

    if (!videoExists) {
      return jsonResponse(404, { error: 'video_not_found', message: 'Video not found in R2' });
    }

    // Check if already backfilled
    const metadata = await env.MEDIA_KV.get(`blob:${sha256}`, { type: 'json' });
    if (metadata && metadata.bunny && metadata.bunny.videoId) {
      return jsonResponse(200, {
        status: 'already_backfilled',
        videoId: metadata.bunny.videoId,
        hlsUrl: `https://${env.BUNNY_STREAM_PULL_ZONE || 'stream.divine.video'}/${metadata.bunny.videoId}/playlist.m3u8`,
        thumbnailUrl: `https://${env.BUNNY_STREAM_PULL_ZONE || 'stream.divine.video'}/${metadata.bunny.videoId}/thumbnail.jpg`,
        bunnyStatus: metadata.bunny.status
      });
    }

    // Create video in BunnyStream
    const bunnyHandler = new BunnyUploadHandler(env);
    const uploadResult = await bunnyHandler.initiateUpload(sha256, {
      size: videoExists.size,
      type: 'video/mp4'
    }, env);

    if (!uploadResult) {
      return jsonResponse(500, { error: 'bunny_upload_failed', message: 'Failed to create Bunny video' });
    }

    // Tell BunnyStream to fetch from R2
    // Note: CDN/Worker GET handler will find the file regardless of path (tries all legacy locations)
    const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
    const sourceUrl = `https://${cdnDomain}/${sha256}`;

    const bunnyClient = bunnyHandler._getClient();
    await bunnyClient.uploadFromUrl(uploadResult.videoId, sourceUrl);

    console.log(`[Backfill] Initiated for ${sha256.substring(0, 8)}, videoId=${uploadResult.videoId}`);

    const pullZone = env.BUNNY_STREAM_PULL_ZONE || 'stream.divine.video';

    return jsonResponse(202, {
      status: 'processing',
      sha256,
      videoId: uploadResult.videoId,
      hlsUrl: `https://${pullZone}/${uploadResult.videoId}/playlist.m3u8`,
      thumbnailUrl: `https://${pullZone}/${uploadResult.videoId}/thumbnail.jpg`,
      message: 'Video backfill initiated. URLs will be available after encoding completes (30-120 seconds)',
      checkStatus: `/video-status/${sha256}`
    });

  } catch (error) {
    console.error('Backfill error:', error);
    return jsonResponse(500, { error: 'internal_error', message: error.message });
  }
}

/**
 * Handle video status check
 * GET /video-status/{sha256}
 */
async function handleVideoStatus(sha256, env) {
  try {
    // Get metadata from KV
    const metadata = await env.MEDIA_KV.get(`blob:${sha256}`, { type: 'json' });

    if (!metadata) {
      return jsonResponse(404, { error: 'not_found', message: 'Video not found' });
    }

    const pullZone = env.BUNNY_STREAM_PULL_ZONE || 'stream.divine.video';
    const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';

    // If no Bunny metadata, video hasn't been backfilled
    if (!metadata.bunny) {
      return jsonResponse(200, {
        sha256,
        status: 'not_backfilled',
        r2Url: `https://${cdnDomain}/${sha256}.mp4`,
        message: 'Video exists in R2 but has not been backfilled to BunnyStream'
      });
    }

    // Video has Bunny metadata
    const response = {
      sha256,
      status: metadata.bunny.status || 'unknown',
      videoId: metadata.bunny.videoId,
      r2Url: `https://${cdnDomain}/${sha256}.mp4`,
      hlsUrl: `https://${pullZone}/${metadata.bunny.videoId}/playlist.m3u8`,
      thumbnailUrl: `https://${pullZone}/${metadata.bunny.videoId}/thumbnail.jpg`
    };

    // Add encoded URLs if ready
    if (metadata.bunny.status === 'ready') {
      response.ready = true;
      response.message = 'Video encoding complete. All URLs are ready.';
    } else {
      response.ready = false;
      response.message = `Video is ${metadata.bunny.status}. Please check again in a few seconds.`;
    }

    return jsonResponse(200, response);

  } catch (error) {
    console.error('Status check error:', error);
    return jsonResponse(500, { error: 'internal_error', message: error.message });
  }
}

/**
 * Handle cleanup duplicates request
 * POST /cleanup-duplicates
 * Processes one page of BunnyStream videos, deletes duplicates
 */
async function handleCleanupDuplicates(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const page = parseInt(body.page) || 1;
    const dryRun = body.dryRun !== false; // Default true

    // Get BunnyStream client
    const bunnyHandler = new BunnyUploadHandler(env);
    const bunnyClient = bunnyHandler._getClient();

    if (!bunnyClient) {
      return jsonResponse(500, { error: 'bunny_not_configured' });
    }

    // Fetch one page of videos
    const result = await bunnyClient.listVideos(page, 100);

    // Track seen titles and find duplicates
    const seenTitles = new Map(); // title -> {videoId, date}
    const toDelete = [];

    for (const video of result.items) {
      const title = video.title;

      if (seenTitles.has(title)) {
        // Duplicate found - keep newer one
        const existing = seenTitles.get(title);
        const existingDate = new Date(existing.date);
        const currentDate = new Date(video.dateUploaded);

        if (currentDate > existingDate) {
          // Current is newer - delete existing, keep current
          toDelete.push(existing.videoId);
          seenTitles.set(title, {videoId: video.guid, date: video.dateUploaded});
        } else {
          // Existing is newer - delete current
          toDelete.push(video.guid);
        }
      } else {
        // First time seeing this title
        seenTitles.set(title, {videoId: video.guid, date: video.dateUploaded});
      }
    }

    // Delete duplicates
    let deleted = 0;
    if (!dryRun && toDelete.length > 0) {
      for (const videoId of toDelete) {
        try {
          await bunnyClient.deleteVideo(videoId);
          deleted++;
        } catch (error) {
          console.error(`Failed to delete ${videoId}:`, error);
        }
      }
    }

    return jsonResponse(200, {
      page,
      totalVideos: result.totalItems,
      processed: result.items.length,
      duplicatesFound: toDelete.length,
      deleted: dryRun ? 0 : deleted,
      dryRun,
      hasMore: page < result.totalPages,
      nextPage: page < result.totalPages ? page + 1 : null
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    return jsonResponse(500, { error: 'cleanup_failed', message: error.message });
  }
}

/**
 * Handle list backfilled videos request
 * GET /list-backfilled?status=ready&limit=100
 */
async function handleListBackfilled(request, env) {
  try {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status'); // ready, processing, or null for all
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 1000);

    // Get list of backfilled videos from KV
    // Note: This scans KV with "bunny:video:" prefix which contains videoId->sha256 mappings
    const videos = [];
    let cursor;
    let scanned = 0;

    do {
      const listResult = await env.MEDIA_KV.list({
        prefix: 'bunny:video:',
        limit: 100,
        cursor
      });

      for (const key of listResult.keys) {
        if (videos.length >= limit) break;

        const videoData = await env.MEDIA_KV.get(key.name, { type: 'json' });
        if (!videoData || !videoData.sha256) continue;

        // Filter by status if requested
        if (statusFilter && videoData.status !== statusFilter) {
          continue;
        }

        const pullZone = env.BUNNY_STREAM_PULL_ZONE || 'stream.divine.video';
        const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';

        videos.push({
          sha256: videoData.sha256,
          videoId: videoData.videoId,
          status: videoData.status || 'unknown',
          r2Url: `https://${cdnDomain}/${videoData.sha256}.mp4`,
          hlsUrl: `https://${pullZone}/${videoData.videoId}/playlist.m3u8`,
          thumbnailUrl: `https://${pullZone}/${videoData.videoId}/thumbnail.jpg`,
          createdAt: videoData.createdAt
        });

        scanned++;
      }

      cursor = listResult.cursor;

      if (videos.length >= limit) break;

    } while (cursor);

    return jsonResponse(200, {
      count: videos.length,
      scanned,
      statusFilter: statusFilter || 'all',
      videos
    });

  } catch (error) {
    console.error('[ListBackfilled] Error:', error);
    return jsonResponse(500, { error: 'internal_error', message: error.message });
  }
}

/**
 * Check if a file is a valid MP4 video by examining its header
 * Returns true if file has valid 'ftyp' box, false otherwise
 */
async function isValidMP4(r2Bucket, key) {
  try {
    // Read first 32 bytes to check for MP4 'ftyp' box
    const obj = await r2Bucket.get(key, {
      range: { offset: 0, length: 32 }
    });

    if (!obj) {
      return false;
    }

    const headerBytes = new Uint8Array(await obj.arrayBuffer());

    // MP4 files start with a box (typically 'ftyp')
    // Format: [4 bytes size][4 bytes type]
    // Common types: 'ftyp', 'moov', 'mdat', 'wide', 'free'

    // Check for 'ftyp' at byte 4-7
    if (headerBytes.length >= 8) {
      const boxType = String.fromCharCode(
        headerBytes[4],
        headerBytes[5],
        headerBytes[6],
        headerBytes[7]
      );

      if (boxType === 'ftyp') {
        return true;
      }
    }

    // Some MP4s may start with 'wide' or 'free' boxes, check offset 12-15
    if (headerBytes.length >= 16) {
      const secondBoxType = String.fromCharCode(
        headerBytes[12],
        headerBytes[13],
        headerBytes[14],
        headerBytes[15]
      );

      if (secondBoxType === 'ftyp') {
        return true;
      }
    }

    console.log(`[ValidateMP4] File ${key.slice(0, 16)}... has invalid MP4 header (first box type: ${boxType})`);
    return false;

  } catch (error) {
    console.error(`[ValidateMP4] Error checking ${key}:`, error);
    return false;
  }
}

/**
 * Handle batch backfill request
 * POST /backfill-batch
 * Body: { "limit": 50, "cursor": "optional-cursor", "skipExisting": true }
 */
async function handleBackfillBatch(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit) || 50, 200); // Max 200 per batch
    const cursor = body.cursor || undefined;
    const prefix = body.prefix || undefined; // Optional: filter by prefix (e.g., "uploads/")
    const skipExisting = body.skipExisting !== false; // Default true

    console.log(`[BatchBackfill] Starting batch: limit=${limit}, prefix=${prefix}, cursor=${cursor}, skipExisting=${skipExisting}`);

    // List .mp4 files from R2
    const listOptions = {
      limit,
      cursor
    };

    if (prefix) {
      listOptions.prefix = prefix;
    }

    const listed = await env.R2_BLOBS.list(listOptions);

    // Filter for video files - THREE patterns:
    // 1. SHA256-named: {sha256}.mp4 (64 hex chars + .mp4 = 68 chars total) - from Vine CDN recovery
    // 2. uploads/*: uploads/{timestamp}-{short}.mp4 - from ArchiveTeam (majority of archive)
    // 3. blobs/{sha256}: blobs/{64-hex} - Blossom content-addressed blobs (no extension)
    const videoCandidates = listed.objects.filter(obj => {
      const key = obj.key;

      // Pattern 3: Blossom blobs/ folder (content-addressed, no extension)
      if (key.startsWith('blobs/')) {
        const sha256 = key.slice(6); // Remove 'blobs/' prefix
        return sha256.length === 64 && /^[a-f0-9]{64}$/.test(sha256);
      }

      // Patterns 1 & 2 require .mp4 extension
      if (!key.endsWith('.mp4')) {
        return false;
      }

      // Pattern 1: SHA256-named files in root
      if (key.length === 68) {
        const sha256 = key.slice(0, -4);
        return /^[a-f0-9]{64}$/.test(sha256);
      }

      // Pattern 2: ArchiveTeam uploads/ folder
      if (key.startsWith('uploads/')) {
        return true;
      }

      return false;
    });

    // Additional filtering: skip files that are likely not videos
    const sizeFilteredVideos = videoCandidates.filter(obj => {
      // Filter 0: Content-Type check - CRITICAL: Skip images (thumbnails misnamed as .mp4)
      const contentType = obj.httpMetadata?.contentType || '';
      if (contentType.startsWith('image/')) {
        console.log(`[BatchBackfill] Skipping ${obj.key.slice(0, 30)}... - is an image (${contentType}), not a video`);
        return false;
      }

      // Filter 1: Size heuristic - Vine videos are 6 seconds, can be small at low quality
      // Files < 1KB are likely corrupted fragments or empty files
      if (obj.size < 1000) { // 1KB
        console.log(`[BatchBackfill] Skipping ${obj.key.slice(0, 16)}... - too small (${obj.size} bytes, likely corrupted)`);
        return false;
      }

      // Filter 2: Size upper bound - 6-second videos should be < 20MB
      // Anything larger is likely not a Vine video
      if (obj.size > 20000000) { // 20MB
        console.log(`[BatchBackfill] Skipping ${obj.key.slice(0, 16)}... - too large (${obj.size} bytes)`);
        return false;
      }

      return true;
    });

    // Skip MP4 header validation - let BunnyStream handle invalid files
    // (Early Vine videos may have non-standard MP4 structures)
    const videos = sizeFilteredVideos;

    console.log(`[BatchBackfill] Size filter: ${videos.length}/${videoCandidates.length} passed`);
    console.log(`[BatchBackfill] Found ${videos.length} videos after size filtering (total objects: ${listed.objects.length})`);

    // Process each video IN PARALLEL for maximum speed
    const results = {
      processed: 0,
      alreadyBackfilled: 0,
      newlyBackfilled: 0,
      errors: 0,
      videos: []
    };

    // Process all videos in parallel using Promise.all
    const videoProcessingPromises = videos.map(async (video) => {
      let sha256;
      let r2Key = video.key;  // Track original R2 path for URL construction
      let tempIdentifier;  // For uploads/ files without SHA256 yet
      let isUploadsFile = false;

      // Determine SHA256 based on file naming pattern
      if (video.key.length === 68 && /^[a-f0-9]{64}\.mp4$/.test(video.key)) {
        // Pattern 1: SHA256-named file - hash is in the filename
        sha256 = video.key.slice(0, -4);
      } else if (video.key.startsWith('blobs/')) {
        // Pattern 2: blobs/ file - SHA256 is in the path (content-addressed, no extension)
        sha256 = video.key.slice(6); // Remove 'blobs/' prefix
        console.log(`[BatchBackfill] Processing blobs/ file: ${video.key}, SHA256: ${sha256.substring(0,12)}...`);
      } else if (video.key.startsWith('uploads/')) {
        // Pattern 3: uploads/ file - use path as temporary identifier
        // BunnyStream will calculate originalHash after processing
        isUploadsFile = true;
        tempIdentifier = video.key;  // Use full path as temporary ID

        // Extract filename for video title
        const filename = video.key.split('/').pop().replace('.mp4', '');

        console.log(`[BatchBackfill] Processing uploads/ file: ${video.key} (will get SHA256 from BunnyStream)`);
      } else {
        return {
          type: 'error',
          key: video.key,
          error: 'Unknown file pattern'
        };
      }

      try {
        // Check if already backfilled
        if (skipExisting) {
          let checkKey;
          if (isUploadsFile) {
            // Check if already processed (use temp key or look for existing SHA256 mapping)
            checkKey = `upload-temp:${tempIdentifier}`;
            const tempData = await env.MEDIA_KV.get(checkKey, { type: 'json' });
            if (tempData && tempData.bunny && tempData.bunny.videoId) {
              return {
                type: 'already_backfilled',
                key: video.key,
                videoId: tempData.bunny.videoId
              };
            }
          } else {
            // SHA256-named files
            checkKey = `blob:${sha256}`;
            const metadata = await env.MEDIA_KV.get(checkKey, { type: 'json' });
            if (metadata && metadata.bunny && metadata.bunny.videoId) {
              return {
                type: 'already_backfilled',
                sha256: sha256.substring(0, 12),
                videoId: metadata.bunny.videoId
              };
            }
          }
        }

        // Create video in BunnyStream
        const bunnyHandler = new BunnyUploadHandler(env);

        // Use appropriate identifier for video title
        const identifier = isUploadsFile ? tempIdentifier.split('/').pop().replace('.mp4', '') : sha256;

        const uploadResult = await bunnyHandler.initiateUpload(identifier, {
          size: video.size,
          type: 'video/mp4'
        }, env);

        if (!uploadResult) {
          return {
            type: 'error',
            key: video.key,
            error: 'Failed to create Bunny video'
          };
        }

        // Store metadata - use temporary key for uploads/ files
        const now = Math.floor(Date.now() / 1000);
        let blobKey, blobMetadata;

        if (isUploadsFile) {
          // Temporary metadata for uploads/ files
          blobKey = `upload-temp:${tempIdentifier}`;
          blobMetadata = {
            uploadsPath: tempIdentifier,
            r2Key: video.key,
            size: video.size,
            type: 'video/mp4',
            uploaded: now,
            bunny: {
              videoId: uploadResult.videoId,
              guid: uploadResult.guid,
              libraryId: env.BUNNY_STREAM_LIBRARY_ID,
              status: 'uploading',
              note: 'Will update with originalHash after processing'
            }
          };
        } else {
          // Standard metadata for SHA256-named files
          blobKey = `blob:${sha256}`;
          blobMetadata = {
            sha256,
            size: video.size,
            type: 'video/mp4',
            uploaded: now,
            bunny: {
              videoId: uploadResult.videoId,
              guid: uploadResult.guid,
              libraryId: env.BUNNY_STREAM_LIBRARY_ID,
              status: 'uploading'
            }
          };
        }

        console.log(`[BatchBackfill] Writing metadata to KV: ${blobKey}`);
        try {
          await env.MEDIA_KV.put(blobKey, JSON.stringify(blobMetadata));
          console.log(`[BatchBackfill] ✅ Metadata written successfully`);
        } catch (kvError) {
          console.error(`[BatchBackfill] ❌ KV write failed:`, kvError);
          throw kvError;
        }

        // Tell BunnyStream to fetch from R2
        const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
        let sourceUrl;

        // Use different URL based on file location in R2
        if (r2Key.startsWith('uploads/')) {
          // ArchiveTeam uploads - use uploads/ path
          sourceUrl = `https://${cdnDomain}/${r2Key}`;
        } else {
          // SHA256-named files - use direct SHA256 URL
          sourceUrl = `https://${cdnDomain}/${sha256}.mp4`;
        }

        console.log(`[BatchBackfill] Fetching from: ${sourceUrl}`);

        const bunnyClient = bunnyHandler._getClient();
        await bunnyClient.uploadFromUrl(uploadResult.videoId, sourceUrl);

        const logId = isUploadsFile ? video.key : sha256.substring(0, 8);
        console.log(`[BatchBackfill] Initiated: ${logId} → ${uploadResult.videoId}`);

        if (isUploadsFile) {
          return {
            type: 'backfilled',
            key: video.key,
            videoId: uploadResult.videoId,
            note: 'SHA256 will be extracted from BunnyStream originalHash'
          };
        } else {
          return {
            type: 'backfilled',
            sha256: sha256.substring(0, 12),
            videoId: uploadResult.videoId
          };
        }

      } catch (error) {
        const logId = isUploadsFile ? video.key : (sha256 ? sha256.substring(0, 8) : video.key);
        console.error(`[BatchBackfill] Error for ${logId}:`, error);
        return {
          type: 'error',
          key: video.key,
          error: error.message
        };
      }
    });

    // Wait for all videos to complete in parallel
    const processedVideos = await Promise.all(videoProcessingPromises);

    // Aggregate results
    for (const result of processedVideos) {
      results.processed++;

      if (result.type === 'already_backfilled') {
        results.alreadyBackfilled++;
        results.videos.push({
          sha256: result.sha256,
          status: 'already_backfilled',
          videoId: result.videoId
        });
      } else if (result.type === 'backfilled') {
        results.newlyBackfilled++;
        results.videos.push({
          sha256: result.sha256,
          status: 'processing',
          videoId: result.videoId
        });
      } else if (result.type === 'error') {
        results.errors++;
        results.videos.push({
          sha256: result.sha256,
          status: 'error',
          error: result.error
        });
      }
    }

    const response = {
      summary: {
        processed: results.processed,
        alreadyBackfilled: results.alreadyBackfilled,
        newlyBackfilled: results.newlyBackfilled,
        errors: results.errors
      },
      videos: results.videos,
      pagination: {
        truncated: listed.truncated,
        cursor: listed.cursor
      }
    };

    // Add next batch instructions if more videos exist
    if (listed.truncated) {
      response.nextBatch = {
        message: 'More videos available. Call again with cursor to continue.',
        curl: `curl -X POST https://blossom.divine.video/backfill-batch -H "Content-Type: application/json" -d '{"cursor": "${listed.cursor}", "limit": ${limit}}'`
      };
    }

    return jsonResponse(200, response);

  } catch (error) {
    console.error('[BatchBackfill] Error:', error);
    return jsonResponse(500, { error: 'internal_error', message: error.message });
  }
}

/**
 * Handle legacy UID-based URLs (/{uid}/thumbnails/..., etc)
 * These are from the old Cloudflare Stream system
 * Proxies to Stream and relies on edge cache for performance
 */
async function handleLegacyUidUrl(uid, subpath, isHead, request, env) {
  // Handle thumbnail requests: /{uid}/thumbnails/thumbnail.jpg
  if (subpath.startsWith('thumbnails/')) {
    // Fetch from Cloudflare Stream (edge cache will handle caching)
    const streamDomain = env.STREAM_CUSTOMER_DOMAIN || 'customer-4c3uhd5qzuhwz9hu.cloudflarestream.com';
    const streamUrl = `https://${streamDomain}/${uid}/thumbnails/thumbnail.jpg`;

    try {
      const streamResponse = await fetch(streamUrl);

      if (!streamResponse.ok) {
        return new Response('Not Found', { status: 404 });
      }

      // Create response with appropriate headers
      const thumbnailData = await streamResponse.arrayBuffer();
      const headers = new Headers();
      headers.set('Content-Type', 'image/jpeg');
      headers.set('Content-Length', thumbnailData.byteLength.toString());
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');

      if (isHead) {
        return new Response(null, { status: 200, headers });
      }

      return new Response(thumbnailData, { status: 200, headers });

    } catch (error) {
      console.error(`❌ Failed to fetch thumbnail from Stream:`, error);
      return new Response('Not Found', { status: 404 });
    }
  }

  // For other legacy paths (manifests, etc), proxy to Stream
  const streamDomain = env.STREAM_CUSTOMER_DOMAIN || 'customer-4c3uhd5qzuhwz9hu.cloudflarestream.com';
  const streamUrl = `https://${streamDomain}/${uid}/${subpath}`;

  try {
    const streamResponse = await fetch(streamUrl, {
      method: request.method,
      headers: request.headers
    });

    // Add CORS headers to proxied response
    const headers = new Headers(streamResponse.headers);
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(streamResponse.body, {
      status: streamResponse.status,
      statusText: streamResponse.statusText,
      headers
    });
  } catch (error) {
    return new Response('Not Found', { status: 404 });
  }
}

/**
 * Cache a response if appropriate and return it
 *
 * @param {Response} response - Response to cache
 * @param {Request} request - Original request
 * @param {URL} url - Request URL
 * @returns {Promise<Response>} The response (cached or not)
 */
async function cacheAndReturn(response, request, url) {
  if (!shouldCache(response, request)) {
    return response;
  }

  try {
    const cache = caches.default;
    // Normalize cache key (same as in fetch handler)
    // IMPORTANT: Don't include headers - prevents cache fragmentation
    const cacheKey = new Request(url.toString(), {
      method: 'GET'
    });

    // Clone response for caching since Response bodies are single-use streams
    await cache.put(cacheKey, response.clone());

    console.log(`[Cache PUT] ${url.pathname} - status:${response.status}`);
  } catch (cacheError) {
    // Cache write failures are non-fatal - log and continue
    console.error('[Cache ERROR] Failed to write cache:', cacheError);
  }

  // Add custom header to indicate cache miss (first request)
  // Use another clone to avoid consuming the original response body
  const clonedResponse = response.clone();
  const headers = new Headers(clonedResponse.headers);
  headers.set('X-Cache-Status', 'MISS');
  return new Response(clonedResponse.body, {
    status: clonedResponse.status,
    statusText: clonedResponse.statusText,
    headers
  });
}

/**
 * Determine if a response should be cached
 *
 * @param {Response} response - Response to evaluate
 * @param {Request} request - Original request
 * @returns {boolean} True if response should be cached
 */
function shouldCache(response, request) {
  // Only cache GET/HEAD/OPTIONS requests
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return false;
  }

  // Don't cache auth-required responses (need per-request validation)
  if (response.status === 401 || response.status === 403) {
    return false;
  }

  // Don't cache server errors (transient failures)
  if (response.status >= 500) {
    return false;
  }

  // Cache successful responses and client errors (immutable decisions)
  // 200 OK, 204 No Content (OPTIONS), 302 Redirect, 400 Bad Request,
  // 404 Not Found, 451 Unavailable
  //
  // NOTE: 206 Partial Content responses are NOT cached. Instead, we cache
  // full 200 responses and let range requests be handled fresh each time.
  // This allows the worker to correctly return 206 with proper Content-Range
  // headers for each range request.
  if (response.status === 200 ||
      response.status === 204 ||
      response.status === 302 ||
      response.status === 400 ||
      response.status === 404 ||
      response.status === 451) {
    return true;
  }

  // Default: don't cache unknown status codes
  return false;
}

/**
 * Get home page HTML
 */
function getHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Divine Blossom Server</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      line-height: 1.6;
      color: #333;
    }
    h1 { color: #5a67d8; margin-bottom: 0.5rem; }
    h2 { color: #4a5568; margin-top: 2rem; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    code {
      background: #f7fafc;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
      font-size: 0.9em;
    }
    pre {
      background: #2d3748;
      color: #f7fafc;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
    }
    .endpoint { margin: 1rem 0; }
    .method {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 3px;
      font-weight: bold;
      font-size: 0.85em;
      margin-right: 0.5rem;
    }
    .get { background: #48bb78; color: white; }
    .put { background: #ed8936; color: white; }
    .delete { background: #f56565; color: white; }
    .head { background: #4299e1; color: white; }
    a { color: #5a67d8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.75em;
      font-weight: 600;
      margin-left: 0.5rem;
    }
    .badge-new { background: #48bb78; color: white; }
    .badge-beta { background: #ed8936; color: white; }
  </style>
</head>
<body>
  <h1>Divine Blossom Server <span class="badge badge-beta">BETA</span></h1>
  <p>Content-addressable blob storage implementing the <a href="https://github.com/hzrd149/blossom" target="_blank">Blossom protocol</a> with AI-powered content moderation.</p>

  <h2>API Endpoints</h2>

  <div class="endpoint">
    <span class="method get">GET</span>
    <code>/{sha256}</code>
    <p>Retrieve a blob by its SHA-256 hash. Supports range requests for streaming.</p>
    <p><strong>Moderation:</strong> Age-restricted content requires Nostr authentication. Banned content returns HTTP 451.</p>
  </div>

  <div class="endpoint">
    <span class="method head">HEAD</span>
    <code>/{sha256}</code>
    <p>Check if a blob exists and get its metadata without downloading the content.</p>
  </div>

  <div class="endpoint">
    <span class="method put">PUT</span>
    <span class="method put">POST</span>
    <code>/upload</code>
    <p>Upload a new blob. Requires Nostr authentication (kind 24242). Accepts both PUT and POST.</p>
    <p><strong>Features:</strong> Automatic content moderation, ProofMode support for verified media.</p>
  </div>

  <div class="endpoint">
    <span class="method get">GET</span>
    <code>/list/{pubkey}</code>
    <p>List all blobs owned by a Nostr public key.</p>
  </div>

  <div class="endpoint">
    <span class="method delete">DELETE</span>
    <code>/{sha256}</code>
    <p>Delete a blob. Requires Nostr authentication and ownership.</p>
  </div>

  <h2>Content Moderation <span class="badge badge-new">NEW</span></h2>
  <p>All uploads are automatically analyzed by AI for harmful content:</p>
  <ul>
    <li><strong>SAFE:</strong> Serves without restrictions</li>
    <li><strong>REVIEW:</strong> Flagged for human review, serves normally</li>
    <li><strong>AGE_RESTRICTED:</strong> Requires Nostr auth + user content preferences (NIP-78)</li>
    <li><strong>PERMANENT_BAN:</strong> Never served (HTTP 451)</li>
  </ul>

  <h2>Authentication</h2>
  <p>Uses Nostr authentication via <strong>kind 24242</strong> events (Blossom protocol).</p>
  <p>Age-restricted content also checks NIP-78 user preferences for consent.</p>

  <h2>ProofMode Support</h2>
  <p>Upload media with cryptographic proof of authenticity using ProofMode headers:</p>
  <ul>
    <li><code>X-ProofMode-Manifest</code> - Photo/video metadata</li>
    <li><code>X-ProofMode-Signature</code> - Cryptographic signature</li>
    <li><code>X-ProofMode-Attestation</code> - Guardian Project attestation</li>
  </ul>

  <h2>Resources</h2>
  <ul>
    <li><a href="https://github.com/hzrd149/blossom" target="_blank">Blossom Protocol Specification</a></li>
    <li><a href="https://github.com/nostr-protocol/nips" target="_blank">Nostr NIPs</a></li>
    <li><a href="https://github.com/guardianproject/proofmode" target="_blank">ProofMode by Guardian Project</a></li>
  </ul>

  <footer style="margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #e2e8f0; color: #718096; font-size: 0.9em;">
    <p>Powered by <a href="https://workers.cloudflare.com/" target="_blank">Cloudflare Workers</a> •
    Built with <a href="https://github.com/hzrd149/blossom-server-sdk" target="_blank">blossom-server-sdk</a></p>
  </footer>
</body>
</html>`;
}
