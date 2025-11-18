// ABOUTME: Upload strategy router for BunnyStream integration
// ABOUTME: Handles upload routing, strategy selection, and Bunny video management

import { BunnyStreamClient, BunnyStreamError } from './bunny-client.mjs';

/**
 * Hash-based distribution function
 * Converts first 8 characters of SHA-256 to a number between 0-99
 * This ensures consistent routing for the same SHA-256
 *
 * @param {string} sha256 - SHA-256 hash (64 hex chars)
 * @returns {number} Number between 0-99
 */
function hashToNumber(sha256) {
  return parseInt(sha256.substring(0, 8), 16) % 100;
}

/**
 * Select upload strategy based on environment configuration
 *
 * @param {Object} env - Cloudflare Worker environment bindings
 * @param {string} sha256 - SHA-256 hash of the content
 * @param {Object} metadata - Upload metadata (size, type, etc)
 * @returns {Object} Strategy decision
 * @returns {string} return.provider - 'r2' | 'bunny' | 'dual'
 * @returns {boolean} return.shouldUseBunny - Whether to use Bunny for this upload
 */
export function selectUploadStrategy(env, sha256, metadata) {
  // Check if BunnyStream is enabled
  const enabled = env.BUNNY_STREAM_ENABLED === 'true';
  console.log(`[UploadStrategy] BUNNY_STREAM_ENABLED=${env.BUNNY_STREAM_ENABLED}, enabled=${enabled}`);
  if (!enabled) {
    console.log('[UploadStrategy] Bunny disabled, using R2');
    return { provider: 'r2', shouldUseBunny: false };
  }

  // Get upload destination configuration
  const dest = env.BUNNY_UPLOAD_DEST || 'r2';
  console.log(`[UploadStrategy] BUNNY_UPLOAD_DEST=${dest}`);

  // Simple cases: explicit r2 or bunny
  if (dest === 'r2') {
    console.log('[UploadStrategy] Destination is r2-only');
    return { provider: 'r2', shouldUseBunny: false };
  }

  if (dest === 'bunny') {
    console.log('[UploadStrategy] Destination is bunny-only');
    return { provider: 'bunny', shouldUseBunny: true };
  }

  // Dual mode: use rollout percentage with hash-based selection
  if (dest === 'dual') {
    const rollout = parseInt(env.BUNNY_ROLLOUT_PERCENTAGE || '0', 10);
    const hashValue = hashToNumber(sha256);
    const shouldUseBunny = hashValue < rollout;
    console.log(`[UploadStrategy] Dual mode: rollout=${rollout}, hashValue=${hashValue}, shouldUseBunny=${shouldUseBunny}`);

    return {
      provider: shouldUseBunny ? 'bunny' : 'r2',
      shouldUseBunny
    };
  }

  // Unknown destination - default to r2 for safety
  console.warn(`[UploadStrategy] Unknown BUNNY_UPLOAD_DEST value: ${dest}, defaulting to r2`);
  return { provider: 'r2', shouldUseBunny: false };
}

/**
 * Handler for BunnyStream video uploads and management
 */
export class BunnyUploadHandler {
  /**
   * Create a new BunnyUploadHandler
   *
   * @param {Object} env - Cloudflare Worker environment bindings
   */
  constructor(env) {
    this.env = env;
    this.client = null;
  }

  /**
   * Get or create BunnyStream client instance
   *
   * @private
   * @returns {BunnyStreamClient|null} Client instance or null if not configured
   */
  _getClient() {
    if (!this.client) {
      const accessKey = this.env.BUNNY_STREAM_ACCESS_KEY;
      const libraryId = this.env.BUNNY_STREAM_LIBRARY_ID;

      if (!accessKey || !libraryId) {
        console.error('BunnyStream credentials not configured');
        return null;
      }

      const options = {
        apiEndpoint: this.env.BUNNY_API_ENDPOINT || 'https://video.bunnycdn.com',
        region: this.env.BUNNY_STREAM_REGION || ''
      };

      this.client = new BunnyStreamClient(accessKey, libraryId, options);
    }

    return this.client;
  }

  /**
   * Initiate a new video upload to BunnyStream
   *
   * @param {string} sha256 - SHA-256 hash of the video
   * @param {Object} metadata - Video metadata
   * @param {string} metadata.type - MIME type (e.g., 'video/mp4')
   * @param {number} metadata.size - File size in bytes
   * @param {Object} env - Cloudflare Worker environment bindings
   * @returns {Promise<Object|null>} Upload details or null on failure
   * @returns {string} return.uploadUrl - URL to PUT video file to
   * @returns {string} return.videoId - Bunny video ID (GUID)
   * @returns {string} return.guid - Bunny video GUID (same as videoId)
   */
  async initiateUpload(sha256, metadata, env) {
    const client = this._getClient();
    if (!client) {
      console.error('[BunnyUpload] Client not configured, cannot initiate upload');
      return null;
    }

    try {
      // Create video in BunnyStream
      const title = `Video ${sha256.substring(0, 16)}`;
      const video = await client.createVideo(title);

      // Get upload URL
      const uploadUrl = await client.getUploadUrl(video.videoId);

      // Store initial metadata in KV
      const kvData = {
        sha256,
        videoId: video.videoId,
        guid: video.guid,
        status: 'uploading',
        hlsUrl: null,
        createdAt: Date.now()
      };

      // Store by Bunny video ID for webhook lookups
      await env.MEDIA_KV.put(
        `bunny:video:${video.videoId}`,
        JSON.stringify(kvData),
        { expirationTtl: 86400 * 30 } // 30 days
      );

      console.log(`[BunnyUpload] Initiated upload for ${sha256.substring(0, 8)}, videoId=${video.videoId}`);

      return {
        uploadUrl,
        videoId: video.videoId,
        guid: video.guid
      };

    } catch (error) {
      // Log error but don't throw - caller should fallback to R2
      if (error instanceof BunnyStreamError) {
        console.error(`[BunnyUpload] Bunny API error (${error.statusCode}):`, error.message);
      } else {
        console.error('[BunnyUpload] Failed to initiate upload:', error);
      }
      return null;
    }
  }

  /**
   * Handle upload completion - update metadata in KV
   *
   * @param {string} sha256 - SHA-256 hash of the video
   * @param {string} videoId - Bunny video ID
   * @param {Object} env - Cloudflare Worker environment bindings
   * @returns {Promise<Object>} Status update
   * @returns {string} return.status - Current status ('processing' or 'error')
   */
  async handleUploadComplete(sha256, videoId, env) {
    const client = this._getClient();
    if (!client) {
      console.error('[BunnyUpload] Client not configured');
      return { status: 'error' };
    }

    try {
      // Fetch video status from Bunny
      const videoInfo = await client.getVideo(videoId);

      // Update bunny:video:{videoId} metadata
      const videoKvData = {
        sha256,
        videoId: videoInfo.videoId,
        guid: videoInfo.guid,
        status: videoInfo.statusLabel,
        hlsUrl: videoInfo.hlsUrl || null,
        createdAt: Date.now()
      };

      await env.MEDIA_KV.put(
        `bunny:video:${videoId}`,
        JSON.stringify(videoKvData),
        { expirationTtl: 86400 * 30 } // 30 days
      );

      // Update blob:{sha256} metadata with Bunny info
      const blobKey = `blob:${sha256}`;
      const existingBlob = await env.MEDIA_KV.get(blobKey, { type: 'json' });

      if (existingBlob) {
        existingBlob.bunny = {
          videoId: videoInfo.videoId,
          guid: videoInfo.guid,
          status: videoInfo.statusLabel,
          hlsUrl: videoInfo.hlsUrl || null
        };

        await env.MEDIA_KV.put(blobKey, JSON.stringify(existingBlob));
      }

      console.log(`[BunnyUpload] Upload complete for ${sha256.substring(0, 8)}, status=${videoInfo.statusLabel}`);

      return { status: videoInfo.statusLabel };

    } catch (error) {
      if (error instanceof BunnyStreamError) {
        console.error(`[BunnyUpload] Failed to check video status (${error.statusCode}):`, error.message);
      } else {
        console.error('[BunnyUpload] Failed to handle upload completion:', error);
      }
      return { status: 'error' };
    }
  }

  /**
   * Get streaming URLs for a video
   *
   * @param {string} sha256 - SHA-256 hash of the video
   * @param {Object} env - Cloudflare Worker environment bindings
   * @returns {Promise<Object|null>} Streaming URLs or null if not available
   * @returns {string|null} return.hlsUrl - HLS playlist URL
   * @returns {string|null} return.mp4Url - MP4 direct URL (if available)
   * @returns {string} return.status - Video status
   */
  async getStreamingUrls(sha256, env) {
    try {
      // First check blob metadata
      const blobKey = `blob:${sha256}`;
      const blobData = await env.MEDIA_KV.get(blobKey, { type: 'json' });

      if (!blobData || !blobData.bunny) {
        return null;
      }

      const bunnyInfo = blobData.bunny;

      // If status is ready and we have URLs, return immediately
      if (bunnyInfo.status === 'ready' && bunnyInfo.hlsUrl) {
        return {
          hlsUrl: bunnyInfo.hlsUrl,
          mp4Url: bunnyInfo.mp4Url || null,
          status: bunnyInfo.status
        };
      }

      // Otherwise, fetch fresh status from Bunny
      const client = this._getClient();
      if (!client) {
        return null;
      }

      const videoInfo = await client.getVideo(bunnyInfo.videoId);

      // Update KV with latest info
      bunnyInfo.status = videoInfo.statusLabel;
      bunnyInfo.hlsUrl = videoInfo.hlsUrl || null;
      bunnyInfo.mp4Url = videoInfo.mp4Url || null;

      blobData.bunny = bunnyInfo;
      await env.MEDIA_KV.put(blobKey, JSON.stringify(blobData));

      return {
        hlsUrl: videoInfo.hlsUrl || null,
        mp4Url: videoInfo.mp4Url || null,
        status: videoInfo.statusLabel
      };

    } catch (error) {
      if (error instanceof BunnyStreamError) {
        console.error(`[BunnyUpload] Failed to get streaming URLs (${error.statusCode}):`, error.message);
      } else {
        console.error('[BunnyUpload] Failed to get streaming URLs:', error);
      }
      return null;
    }
  }

  /**
   * Update video metadata after webhook event
   * Called by webhook handler when encoding completes or fails
   *
   * @param {string} videoId - Bunny video ID
   * @param {Object} updates - Fields to update
   * @param {string} [updates.status] - New status
   * @param {string} [updates.hlsUrl] - HLS playlist URL
   * @param {string} [updates.mp4Url] - MP4 direct URL
   * @param {string} [updates.error] - Error message (if failed)
   * @param {Object} env - Cloudflare Worker environment bindings
   * @returns {Promise<boolean>} Success status
   */
  async updateVideoMetadata(videoId, updates, env) {
    try {
      // Get existing video metadata
      const videoKey = `bunny:video:${videoId}`;
      const videoData = await env.MEDIA_KV.get(videoKey, { type: 'json' });

      if (!videoData) {
        console.warn(`[BunnyUpload] Video metadata not found for ${videoId}`);
        return false;
      }

      // Update video KV entry
      const updatedVideo = {
        ...videoData,
        ...updates,
        updatedAt: Date.now()
      };

      await env.MEDIA_KV.put(videoKey, JSON.stringify(updatedVideo));

      // Also update blob:{sha256} entry
      const blobKey = `blob:${videoData.sha256}`;
      const blobData = await env.MEDIA_KV.get(blobKey, { type: 'json' });

      if (blobData) {
        blobData.bunny = {
          videoId,
          guid: videoData.guid,
          status: updates.status || videoData.status,
          hlsUrl: updates.hlsUrl || videoData.hlsUrl,
          mp4Url: updates.mp4Url || videoData.mp4Url || null,
          error: updates.error || null
        };

        await env.MEDIA_KV.put(blobKey, JSON.stringify(blobData));
      }

      console.log(`[BunnyUpload] Updated metadata for ${videoId}, status=${updates.status || videoData.status}`);
      return true;

    } catch (error) {
      console.error('[BunnyUpload] Failed to update video metadata:', error);
      return false;
    }
  }
}
