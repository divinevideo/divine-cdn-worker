// ABOUTME: BunnyStream webhook handler for encoding callbacks and events
// ABOUTME: Verifies webhook signatures and processes video encoding status updates

import { VideoStatus, VideoStatusLabel } from './bunny-client.mjs';
import { logWebhookEvent, updateVideoMetadata } from './d1-logger.mjs';

/**
 * Webhook event types from BunnyStream
 * @readonly
 * @enum {number}
 */
export const WebhookEventType = {
  VIDEO_UPLOADED: 1,
  VIDEO_ENCODED: 2,
  VIDEO_FAILED: 3,
  VIDEO_DELETED: 4
};

/**
 * Maximum age for webhook requests (5 minutes)
 * Prevents replay attacks
 */
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

/**
 * BunnyStream webhook error class
 */
export class BunnyWebhookError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BunnyWebhookError';
    this.statusCode = statusCode;
  }
}

/**
 * Handler for BunnyStream webhook events
 *
 * Processes encoding callbacks and updates KV storage with video status.
 * Implements HMAC-SHA256 signature verification for security.
 *
 * @example
 * const handler = new BunnyWebhookHandler();
 * const response = await handler.process(request, env);
 */
export class BunnyWebhookHandler {
  /**
   * Verify HMAC-SHA256 signature from Bunny webhook
   *
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param {Request} request - Incoming webhook request
   * @param {string} secret - Webhook secret from env
   * @returns {Promise<boolean>} True if signature is valid
   *
   * @example
   * const isValid = await handler.verifySignature(request, env.BUNNY_WEBHOOK_SECRET);
   * if (!isValid) {
   *   return new Response('Invalid signature', { status: 401 });
   * }
   */
  async verifySignature(request, secret) {
    if (!secret) {
      throw new BunnyWebhookError('Webhook secret not configured', 500);
    }

    const signature = request.headers.get('x-bunny-signature');
    if (!signature) {
      return false;
    }

    // Clone request to read body without consuming it
    const requestClone = request.clone();
    const body = await requestClone.text();

    // Calculate expected signature using HMAC-SHA1 (Bunny uses SHA-1, not SHA-256)
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    );

    const signatureBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(body)
    );

    // Convert to hex string
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison to prevent timing attacks
    return this._constantTimeCompare(signature.toLowerCase(), expectedSignature);
  }

  /**
   * Constant-time string comparison
   * Prevents timing attacks by always comparing all characters
   *
   * @private
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {boolean} True if strings are equal
   */
  _constantTimeCompare(a, b) {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }

  /**
   * Parse and validate webhook payload
   *
   * @param {Request} request - Incoming webhook request
   * @returns {Promise<Object>} Parsed webhook payload
   * @throws {BunnyWebhookError} If payload is invalid
   *
   * @example
   * const payload = await handler.parseWebhook(request);
   * console.log(payload.VideoGuid, payload.Status);
   */
  async parseWebhook(request) {
    let payload;

    try {
      payload = await request.json();
    } catch (error) {
      throw new BunnyWebhookError('Invalid JSON payload');
    }

    // Validate required fields
    if (!payload.VideoGuid) {
      throw new BunnyWebhookError('Missing VideoGuid in payload');
    }

    if (typeof payload.Status === 'undefined') {
      throw new BunnyWebhookError('Missing Status in payload');
    }

    // Check webhook timestamp for replay protection
    if (payload.Timestamp) {
      const webhookTime = new Date(payload.Timestamp).getTime();
      const now = Date.now();
      const age = now - webhookTime;

      if (age > MAX_WEBHOOK_AGE_MS) {
        throw new BunnyWebhookError('Webhook too old (possible replay attack)');
      }

      if (age < -60000) {
        // Allow 1 minute clock skew into future
        throw new BunnyWebhookError('Webhook timestamp in future');
      }
    }

    return payload;
  }

  /**
   * Handle successful video encoding
   *
   * Updates KV storage with ready status and HLS URL.
   * Downloads thumbnail from BunnyStream and uploads to Blossom storage.
   *
   * @param {Object} payload - Webhook payload
   * @param {Object} env - Cloudflare Worker environment
   * @returns {Promise<void>}
   *
   * @example
   * await handler.handleVideoEncoded(payload, env);
   */
  async handleVideoEncoded(payload, env) {
    const videoId = payload.VideoGuid;
    const libraryId = payload.VideoLibraryId;

    // Get sha256 from bunny:video:{videoId} mapping
    const videoKey = `bunny:video:${videoId}`;
    const videoDataStr = await env.MEDIA_KV.get(videoKey);

    let sha256 = null;
    let videoData = null;

    if (videoDataStr) {
      videoData = JSON.parse(videoDataStr);
      sha256 = videoData.sha256;
    } else {
      console.warn(`No KV entry found for Bunny video ${videoId}`);
    }

    // Log to D1 database immediately (before any early returns)
    // Generate URLs for D1 logging (even if we don't have full videoData)
    const tempPullZone = env.BUNNY_STREAM_PULL_ZONE;
    const tempHlsUrl = tempPullZone ? `https://${tempPullZone}/${videoId}/playlist.m3u8` : null;
    const tempThumbnailUrl = tempPullZone ? `https://${tempPullZone}/${videoId}/thumbnail.jpg` : null;
    await logWebhookEvent(env, payload, sha256, {
      hlsUrl: tempHlsUrl,
      thumbnailUrl: tempThumbnailUrl,
      mp4Url: tempHlsUrl ? tempHlsUrl.replace('/playlist.m3u8', '/play_{resolution}_00001.mp4') : null
    });

    // If no KV entry, we can't do the rest of the processing
    if (!videoDataStr) {
      return;
    }

    // For uploads/ files, we need to fetch originalHash from BunnyStream
    if (!sha256 && videoData.uploadsPath) {
      console.log(`[Webhook] uploads/ file detected: ${videoData.uploadsPath}. Fetching originalHash from BunnyStream...`);

      try {
        // Fetch video details from BunnyStream to get originalHash
        const bunnyClient = new (await import('./bunny-client.mjs')).BunnyStreamClient(
          env.BUNNY_STREAM_ACCESS_KEY,
          env.BUNNY_STREAM_LIBRARY_ID
        );

        const videoInfo = await bunnyClient.getVideo(videoId);
        const originalHash = videoInfo.originalHash;

        if (!originalHash) {
          console.error(`[Webhook] BunnyStream did not provide originalHash for ${videoId}`);
          // Continue without SHA256 - we'll handle this gracefully
        } else {
          sha256 = originalHash.toLowerCase();
          console.log(`[Webhook] Extracted originalHash: ${sha256.substring(0, 12)}... for ${videoData.uploadsPath}`);

          // Create proper blob:{sha256} entry
          const blobKey = `blob:${sha256}`;
          const now = Math.floor(Date.now() / 1000);
          const blobMetadata = {
            sha256,
            uploadsPath: videoData.uploadsPath,
            r2Key: videoData.r2Key,
            size: videoData.size,
            type: videoData.type || 'video/mp4',
            uploaded: videoData.uploaded || now,
            bunny: {
              videoId: videoId,
              guid: payload.VideoGuid,
              libraryId: libraryId,
              status: 'ready'
            }
          };

          await env.MEDIA_KV.put(blobKey, JSON.stringify(blobMetadata));
          console.log(`[Webhook] Created blob:${sha256.substring(0, 12)} entry for uploads/ file`);

          // Clean up temporary entry
          const tempKey = `upload-temp:${videoData.uploadsPath}`;
          await env.MEDIA_KV.delete(tempKey);
          console.log(`[Webhook] Cleaned up temporary entry: ${tempKey}`);
        }
      } catch (error) {
        console.error(`[Webhook] Failed to fetch originalHash:`, error);
        // Continue anyway - we'll handle this case
      }
    }

    // Get pull zone from env
    const pullZone = env.BUNNY_STREAM_PULL_ZONE;
    if (!pullZone) {
      throw new BunnyWebhookError('BUNNY_STREAM_PULL_ZONE not configured', 500);
    }

    // Generate HLS URL
    const hlsUrl = `https://${pullZone}/${videoId}/playlist.m3u8`;

    // Download and upload thumbnail to Blossom
    let thumbnailSha256 = null;
    let thumbnailUrl = `https://${pullZone}/${videoId}/thumbnail.jpg`;

    try {
      // Download thumbnail from BunnyStream
      const thumbnailResponse = await fetch(thumbnailUrl);

      if (thumbnailResponse.ok) {
        const thumbnailData = await thumbnailResponse.arrayBuffer();

        // Calculate SHA-256 of thumbnail
        const hashBuffer = await crypto.subtle.digest('SHA-256', thumbnailData);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        thumbnailSha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        // Upload thumbnail to R2 (Blossom storage)
        await env.R2_BLOBS.put(`${thumbnailSha256}.jpg`, thumbnailData, {
          httpMetadata: {
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable'
          }
        });

        // Store thumbnail metadata in KV
        const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
        const thumbnailBlobKey = `blob:${thumbnailSha256}`;
        const thumbnailMetadata = {
          sha256: thumbnailSha256,
          size: thumbnailData.byteLength,
          type: 'image/jpeg',
          uploaded: Math.floor(Date.now() / 1000),
          source: 'bunnystream',
          videoSha256: sha256,
          videoId: videoId
        };

        await env.MEDIA_KV.put(thumbnailBlobKey, JSON.stringify(thumbnailMetadata));

        console.log(`✅ Thumbnail uploaded to Blossom: ${thumbnailSha256} (${thumbnailData.byteLength} bytes)`);
        console.log(`   Thumbnail URL: https://${cdnDomain}/${thumbnailSha256}.jpg`);
      } else {
        console.warn(`Failed to download thumbnail from ${thumbnailUrl}: ${thumbnailResponse.status}`);
      }
    } catch (error) {
      console.error(`Error uploading thumbnail to Blossom:`, error);
      // Continue anyway - thumbnail upload is non-critical
    }

    // Check duration limit (tell users 6 seconds, enforce at 7 seconds for tolerance)
    const duration = payload.Length || 0;
    const MAX_DURATION_SECONDS = 7;
    let isDurationRejected = false;

    if (duration > MAX_DURATION_SECONDS) {
      isDurationRejected = true;
      console.log(`⛔ Video ${videoId} (sha256: ${sha256?.substring(0, 12)}) rejected: duration ${duration}s exceeds ${MAX_DURATION_SECONDS}s limit`);

      // Store duration rejection in KV for GET request blocking
      if (sha256) {
        await env.MEDIA_KV.put(`duration-rejected:${sha256}`, JSON.stringify({
          duration,
          maxAllowed: 6, // User-facing limit
          actualLimit: MAX_DURATION_SECONDS,
          rejectedAt: Date.now(),
          videoId,
          reason: 'Video duration exceeds maximum allowed length'
        }));
      }
    }

    // Update bunny:video:{videoId} with ready status
    const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
    const updatedVideoData = {
      ...videoData,
      status: isDurationRejected ? 'rejected' : 'ready',
      hlsUrl,
      thumbnailUrl,
      thumbnailSha256,
      thumbnailBlossomUrl: thumbnailSha256 ? `https://${cdnDomain}/${thumbnailSha256}.jpg` : null,
      duration: payload.Length || null,
      durationRejected: isDurationRejected,
      encodeProgress: payload.EncodeProgress || 100,
      encodedAt: Date.now(),
      lastWebhook: {
        status: payload.Status,
        timestamp: payload.Timestamp || new Date().toISOString()
      }
    };

    await env.MEDIA_KV.put(videoKey, JSON.stringify(updatedVideoData));

    // Update blob:{sha256} with Bunny streaming info
    const blobKey = `blob:${sha256}`;
    const blobDataStr = await env.MEDIA_KV.get(blobKey);

    if (blobDataStr) {
      const blobData = JSON.parse(blobDataStr);

      blobData.bunny = {
        videoId,
        guid: videoId,
        libraryId: libraryId?.toString() || env.BUNNY_STREAM_LIBRARY_ID,
        status: 'ready',
        hlsUrl,
        thumbnailUrl,
        thumbnailSha256,
        thumbnailBlossomUrl: thumbnailSha256 ? `https://${cdnDomain}/${thumbnailSha256}.jpg` : null,
        duration: payload.Length || null,
        encodedAt: Date.now()
      };

      // Update provider status
      if (blobData.provider === 'bunny' || blobData.provider === 'dual') {
        // Keep as is
      } else if (blobData.r2) {
        blobData.provider = 'dual';
      } else {
        blobData.provider = 'bunny';
      }

      await env.MEDIA_KV.put(blobKey, JSON.stringify(blobData));
    }

    console.log(`Video ${videoId} (sha256: ${sha256}) encoded successfully. HLS: ${hlsUrl}`);

    // Update video metadata table
    if (sha256) {
      await updateVideoMetadata(env, sha256, {
        video_guid: videoId,
        video_id: videoId,
        bunny_library_id: libraryId?.toString() || env.BUNNY_STREAM_LIBRARY_ID,
        status: 'ready',
        hls_url: hlsUrl,
        thumbnail_url: thumbnailSha256 ? `https://${cdnDomain}/${thumbnailSha256}.jpg` : thumbnailUrl,
        mp4_url: null,
        uploaded_by: blobData?.owner || null,
        uploaded_at: blobData?.uploaded ? new Date(blobData.uploaded * 1000).toISOString() : null,
        file_size: blobData?.size || null,
        mime_type: blobData?.type || 'video/mp4'
      });
    }
  }

  /**
   * Handle video encoding failure
   *
   * Updates KV storage with error status and message.
   *
   * @param {Object} payload - Webhook payload
   * @param {Object} env - Cloudflare Worker environment
   * @returns {Promise<void>}
   *
   * @example
   * await handler.handleVideoFailed(payload, env);
   */
  async handleVideoFailed(payload, env) {
    const videoId = payload.VideoGuid;
    const errorMessage = payload.Message || payload.ErrorMessage || 'Encoding failed';

    // Get sha256 from bunny:video:{videoId} mapping
    const videoKey = `bunny:video:${videoId}`;
    const videoDataStr = await env.MEDIA_KV.get(videoKey);

    let sha256 = null;
    let videoData = null;

    if (videoDataStr) {
      videoData = JSON.parse(videoDataStr);
      sha256 = videoData.sha256;
    } else {
      console.warn(`No KV entry found for failed Bunny video ${videoId}`);
    }

    // Log error event to D1 immediately (before any early returns)
    await logWebhookEvent(env, payload, sha256);

    // If no KV entry, we can't do the rest of the processing
    if (!videoDataStr) {
      return;
    }

    // Update bunny:video:{videoId} with error status
    const updatedVideoData = {
      ...videoData,
      status: 'error',
      error: errorMessage,
      lastWebhook: {
        status: payload.Status,
        timestamp: payload.Timestamp || new Date().toISOString()
      }
    };

    await env.MEDIA_KV.put(videoKey, JSON.stringify(updatedVideoData));

    // Update blob:{sha256} with error info
    const blobKey = `blob:${sha256}`;
    const blobDataStr = await env.MEDIA_KV.get(blobKey);

    if (blobDataStr) {
      const blobData = JSON.parse(blobDataStr);

      if (blobData.bunny) {
        blobData.bunny.status = 'error';
        blobData.bunny.error = errorMessage;
      } else {
        blobData.bunny = {
          videoId,
          guid: videoId,
          status: 'error',
          error: errorMessage
        };
      }

      await env.MEDIA_KV.put(blobKey, JSON.stringify(blobData));
    }

    console.error(`Video ${videoId} (sha256: ${sha256}) encoding failed: ${errorMessage}`);
  }

  /**
   * Handle video deletion
   *
   * Updates KV storage to remove Bunny references.
   *
   * @param {Object} payload - Webhook payload
   * @param {Object} env - Cloudflare Worker environment
   * @returns {Promise<void>}
   *
   * @example
   * await handler.handleVideoDeleted(payload, env);
   */
  async handleVideoDeleted(payload, env) {
    const videoId = payload.VideoGuid;

    // Get sha256 from bunny:video:{videoId} mapping
    const videoKey = `bunny:video:${videoId}`;
    const videoDataStr = await env.MEDIA_KV.get(videoKey);

    let sha256 = null;
    let videoData = null;

    if (videoDataStr) {
      videoData = JSON.parse(videoDataStr);
      sha256 = videoData.sha256;
    } else {
      console.warn(`No KV entry found for deleted Bunny video ${videoId}`);
    }

    // Log deletion event to D1 immediately (before any early returns)
    await logWebhookEvent(env, payload, sha256);

    // If no KV entry, we can't do the rest of the processing
    if (!videoDataStr) {
      return;
    }

    // Delete bunny:video:{videoId} entry
    await env.MEDIA_KV.delete(videoKey);

    // Update blob:{sha256} to remove Bunny info
    const blobKey = `blob:${sha256}`;
    const blobDataStr = await env.MEDIA_KV.get(blobKey);

    if (blobDataStr) {
      const blobData = JSON.parse(blobDataStr);

      // Remove bunny field
      delete blobData.bunny;

      // Update provider
      if (blobData.r2) {
        blobData.provider = 'r2';
      } else {
        // No storage left, this is unusual
        console.warn(`Video ${sha256} has no storage after Bunny deletion`);
      }

      await env.MEDIA_KV.put(blobKey, JSON.stringify(blobData));
    }

    console.log(`Video ${videoId} (sha256: ${sha256}) deleted from Bunny`);
  }

  /**
   * Main webhook processing entry point
   *
   * Verifies signature, parses payload, and routes to appropriate handler.
   * Returns appropriate HTTP response for Bunny.
   *
   * @param {Request} request - Incoming webhook request
   * @param {Object} env - Cloudflare Worker environment
   * @returns {Promise<Response>} HTTP response
   *
   * @example
   * // In worker's fetch handler:
   * if (url.pathname === '/webhooks/bunny') {
   *   const handler = new BunnyWebhookHandler();
   *   return await handler.process(request, env);
   * }
   */
  async process(request, env) {
    try {
      // TODO: Add rate limiting to prevent webhook flooding
      // Consider implementing with Cloudflare Rate Limiting or KV-based tracking

      // Verify bearer token (quick authentication check)
      if (env.BUNNY_WEBHOOK_TOKEN) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader !== `Bearer ${env.BUNNY_WEBHOOK_TOKEN}`) {
          console.warn('Webhook bearer token verification failed');
          return new Response('Unauthorized', { status: 401 });
        }
      }

      // Verify HMAC-SHA1 signature (payload integrity check)
      if (env.BUNNY_SIGNING_KEY) {
        const isValid = await this.verifySignature(request, env.BUNNY_SIGNING_KEY);

        if (!isValid) {
          console.warn('Webhook signature verification failed');
          return new Response('Unauthorized', { status: 401 });
        }
      } else {
        console.log('Webhook signature verification skipped (no signing key configured)');
      }

      // Parse and validate payload
      const payload = await this.parseWebhook(request);

      // Route based on status code
      const status = payload.Status;

      // Status 3 or 4 = Video encoded successfully
      if (status === VideoStatus.FINISHED || status === VideoStatus.RESOLUTION_FINISHED) {
        await this.handleVideoEncoded(payload, env);
        return new Response('OK', { status: 200 });
      }

      // Status 5 = Encoding failed
      if (status === VideoStatus.ERROR) {
        await this.handleVideoFailed(payload, env);
        return new Response('OK', { status: 200 });
      }

      // Status 6 = Virus detected
      if (status === VideoStatus.VIRUS_DETECTED) {
        await this.handleVideoFailed(payload, env);
        return new Response('OK', { status: 200 });
      }

      // Other statuses (queued, processing, encoding) - just acknowledge
      console.log(`Webhook for video ${payload.VideoGuid}: status=${status} (${VideoStatusLabel[status]})`);
      return new Response('OK', { status: 200 });

    } catch (error) {
      if (error instanceof BunnyWebhookError) {
        console.error('Webhook error:', error.message);
        return new Response(error.message, { status: error.statusCode });
      }

      console.error('Webhook processing error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
}
