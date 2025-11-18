// ABOUTME: Playback URL resolver for BunnyStream HLS and R2 MP4 videos
// ABOUTME: Provides fallback logic prioritizing HLS streaming with MP4 fallback

import { VideoStatus, VideoStatusLabel } from './bunny-client.mjs';

/**
 * Provider types for video playback
 * @readonly
 * @enum {string}
 */
export const Provider = {
  BUNNY_HLS: 'bunny-hls',
  BUNNY_MP4: 'bunny-mp4',
  R2_MP4: 'r2-mp4'
};

/**
 * Playback status
 * @readonly
 * @enum {string}
 */
export const PlaybackStatus = {
  READY: 'ready',
  PROCESSING: 'processing',
  UNAVAILABLE: 'unavailable'
};

/**
 * Resolves playback URLs for videos with intelligent fallback logic
 *
 * Priority order:
 * 1. Bunny HLS (if available and ready)
 * 2. Bunny MP4 (if available)
 * 3. R2 MP4 (always available as fallback)
 *
 * @example
 * const resolver = new PlaybackResolver();
 * const result = await resolver.resolveUrl(sha256, 'auto', env);
 * console.log(result.url, result.provider, result.status);
 */
export class PlaybackResolver {
  /**
   * Resolve the best playback URL for a video
   *
   * @param {string} sha256 - Video SHA-256 hash
   * @param {string} format - Requested format: 'hls' | 'mp4' | 'auto'
   * @param {Object} env - Worker environment bindings
   * @returns {Promise<Object|null>} Playback result or null if video doesn't exist
   * @returns {string} return.url - Playback URL
   * @returns {string} return.provider - Provider type (bunny-hls, bunny-mp4, r2-mp4)
   * @returns {string} return.status - Status (ready, processing, unavailable)
   * @returns {Object} [return.alternates] - Alternative URLs
   * @returns {string} [return.alternates.hls] - HLS URL if available
   * @returns {string} [return.alternates.mp4] - MP4 URL if available
   *
   * @example
   * // Request HLS only
   * const result = await resolver.resolveUrl(sha256, 'hls', env);
   * if (!result) return new Response('Not found', { status: 404 });
   * if (result.status === 'processing') {
   *   return new Response('Video still processing', { status: 202 });
   * }
   *
   * @example
   * // Auto selection (prefer HLS, fallback to MP4)
   * const result = await resolver.resolveUrl(sha256, 'auto', env);
   * return Response.redirect(result.url, 302);
   */
  async resolveUrl(sha256, format, env) {
    // Validate format
    if (!['hls', 'mp4', 'auto'].includes(format)) {
      throw new Error(`Invalid format: ${format}. Must be 'hls', 'mp4', or 'auto'`);
    }

    // Check for duration rejection (videos exceeding length limit)
    const durationRejection = await env.MEDIA_KV.get(`duration-rejected:${sha256}`);
    if (durationRejection) {
      // Return null to indicate video is not available (will result in 404)
      return null;
    }

    // Get blob metadata from KV
    const blobData = await env.MEDIA_KV.get(`blob:${sha256}`);
    if (!blobData) {
      // Video doesn't exist in our system
      return null;
    }

    const blob = JSON.parse(blobData);
    const bunny = blob.bunny || null;
    const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';

    // Build result object
    const result = {
      url: null,
      provider: null,
      status: PlaybackStatus.UNAVAILABLE,
      alternates: {}
    };

    // Build R2 MP4 URL (always available as fallback)
    const r2Url = `https://${cdnDomain}/${sha256}.mp4`;

    // Check if Bunny is available and ready
    const bunnyReady = bunny &&
                       bunny.status === VideoStatusLabel[VideoStatus.FINISHED] &&
                       bunny.hlsUrl;

    const bunnyProcessing = bunny &&
                            (bunny.status === VideoStatusLabel[VideoStatus.PROCESSING] ||
                             bunny.status === VideoStatusLabel[VideoStatus.ENCODING] ||
                             bunny.status === VideoStatusLabel[VideoStatus.QUEUED]);

    // Handle HLS format request
    if (format === 'hls') {
      if (bunnyReady) {
        result.url = bunny.hlsUrl;
        result.provider = Provider.BUNNY_HLS;
        result.status = PlaybackStatus.READY;
        result.alternates.mp4 = r2Url;
        if (bunny.mp4Url) {
          result.alternates.mp4 = bunny.mp4Url;
        }
      } else if (bunnyProcessing) {
        // HLS not ready yet, but processing
        result.status = PlaybackStatus.PROCESSING;
        result.alternates.mp4 = r2Url;
      } else {
        // HLS not available
        result.status = PlaybackStatus.UNAVAILABLE;
        result.alternates.mp4 = r2Url;
      }
      return result;
    }

    // Handle MP4 format request
    if (format === 'mp4') {
      if (bunny && bunny.mp4Url) {
        // Prefer Bunny MP4
        result.url = bunny.mp4Url;
        result.provider = Provider.BUNNY_MP4;
        result.status = PlaybackStatus.READY;
        if (bunny.hlsUrl) {
          result.alternates.hls = bunny.hlsUrl;
        }
      } else {
        // Fallback to R2 MP4
        result.url = r2Url;
        result.provider = Provider.R2_MP4;
        result.status = PlaybackStatus.READY;
        if (bunnyReady) {
          result.alternates.hls = bunny.hlsUrl;
        }
      }
      return result;
    }

    // Handle auto format (prefer HLS, fallback to MP4)
    if (format === 'auto') {
      if (bunnyReady) {
        // Use Bunny HLS
        result.url = bunny.hlsUrl;
        result.provider = Provider.BUNNY_HLS;
        result.status = PlaybackStatus.READY;
        result.alternates.mp4 = bunny.mp4Url || r2Url;
      } else if (bunny && bunny.mp4Url) {
        // Bunny HLS not ready, use Bunny MP4
        result.url = bunny.mp4Url;
        result.provider = Provider.BUNNY_MP4;
        result.status = bunnyProcessing ? PlaybackStatus.PROCESSING : PlaybackStatus.READY;
        if (bunnyProcessing) {
          result.alternates.hls = 'pending';
        }
      } else {
        // Fallback to R2 MP4
        result.url = r2Url;
        result.provider = Provider.R2_MP4;
        result.status = bunnyProcessing ? PlaybackStatus.PROCESSING : PlaybackStatus.READY;
        if (bunnyProcessing) {
          result.alternates.hls = 'pending';
        }
      }
      return result;
    }

    return result;
  }

  /**
   * Get preferred format based on Accept header
   *
   * @param {string} sha256 - Video SHA-256 hash
   * @param {string} acceptHeader - HTTP Accept header value
   * @param {Object} env - Worker environment bindings
   * @returns {Promise<Object|null>} Playback result based on Accept header
   *
   * @example
   * // Client requesting HLS
   * const result = await resolver.getPreferredFormat(sha256, 'application/vnd.apple.mpegurl', env);
   * // Returns HLS URL if available
   *
   * @example
   * // Client requesting MP4
   * const result = await resolver.getPreferredFormat(sha256, 'video/mp4', env);
   * // Returns MP4 URL
   */
  async getPreferredFormat(sha256, acceptHeader, env) {
    if (!acceptHeader) {
      // No Accept header, use auto
      return await this.resolveUrl(sha256, 'auto', env);
    }

    const accept = acceptHeader.toLowerCase();

    // Check for HLS preference
    if (accept.includes('application/vnd.apple.mpegurl') ||
        accept.includes('application/x-mpegurl')) {
      return await this.resolveUrl(sha256, 'hls', env);
    }

    // Check for MP4 preference
    if (accept.includes('video/mp4')) {
      return await this.resolveUrl(sha256, 'mp4', env);
    }

    // Default to auto
    return await this.resolveUrl(sha256, 'auto', env);
  }

  /**
   * Get fallback chain of URLs in priority order
   *
   * @param {string} sha256 - Video SHA-256 hash
   * @param {Object} env - Worker environment bindings
   * @returns {Promise<Array<Object>>} Array of URLs in priority order
   * @returns {string} return[].url - Playback URL
   * @returns {string} return[].provider - Provider type
   * @returns {string} return[].status - Availability status
   *
   * @example
   * const chain = await resolver.getFallbackChain(sha256, env);
   * // Returns: [
   * //   { url: 'https://...playlist.m3u8', provider: 'bunny-hls', status: 'ready' },
   * //   { url: 'https://...video.mp4', provider: 'bunny-mp4', status: 'ready' },
   * //   { url: 'https://cdn.divine.video/abc.mp4', provider: 'r2-mp4', status: 'ready' }
   * // ]
   */
  async getFallbackChain(sha256, env) {
    const blobData = await env.MEDIA_KV.get(`blob:${sha256}`);
    if (!blobData) {
      return [];
    }

    const blob = JSON.parse(blobData);
    const bunny = blob.bunny || null;
    const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
    const chain = [];

    // Priority 1: Bunny HLS
    if (bunny && bunny.hlsUrl) {
      const status = bunny.status === VideoStatusLabel[VideoStatus.FINISHED]
        ? PlaybackStatus.READY
        : PlaybackStatus.PROCESSING;

      chain.push({
        url: bunny.hlsUrl,
        provider: Provider.BUNNY_HLS,
        status
      });
    }

    // Priority 2: Bunny MP4
    if (bunny && bunny.mp4Url) {
      const status = bunny.status === VideoStatusLabel[VideoStatus.FINISHED]
        ? PlaybackStatus.READY
        : PlaybackStatus.PROCESSING;

      chain.push({
        url: bunny.mp4Url,
        provider: Provider.BUNNY_MP4,
        status
      });
    }

    // Priority 3: R2 MP4 (always available)
    chain.push({
      url: `https://${cdnDomain}/${sha256}.mp4`,
      provider: Provider.R2_MP4,
      status: PlaybackStatus.READY
    });

    return chain;
  }

  /**
   * Get the best available URL (highest priority ready URL)
   *
   * @param {string} sha256 - Video SHA-256 hash
   * @param {Object} env - Worker environment bindings
   * @returns {Promise<Object|null>} Best available URL or null if not found
   * @returns {string} return.url - Playback URL
   * @returns {string} return.provider - Provider type
   * @returns {string} return.status - Always 'ready'
   *
   * @example
   * const best = await resolver.getBestUrl(sha256, env);
   * if (best) {
   *   return Response.redirect(best.url, 302);
   * }
   */
  async getBestUrl(sha256, env) {
    const chain = await this.getFallbackChain(sha256, env);

    // Find first ready URL
    const ready = chain.find(item => item.status === PlaybackStatus.READY);

    return ready || null;
  }
}
