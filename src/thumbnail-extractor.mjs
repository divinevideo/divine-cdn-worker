// ABOUTME: Cloudflare Media Transformations thumbnail extractor
// ABOUTME: Extracts first-frame thumbnails from videos via cdn-cgi/media endpoint

const MAX_VIDEO_SIZE_BYTES = 40 * 1024 * 1024; // 40MB Cloudflare limit
const RETRY_DELAYS_MS = [500, 1000, 2000]; // Exponential backoff delays

/**
 * Check if Media Transformations should be attempted for a video
 *
 * @param {Object} env - Worker environment
 * @param {number} videoSize - Video size in bytes
 * @returns {boolean} True if should attempt Media Transformations
 */
export function shouldAttemptMediaTransformation(env, videoSize) {
  // Check feature flag
  if (env.MEDIA_TRANSFORMATIONS_ENABLED !== 'true') {
    return false;
  }

  // Check size limit (40MB max for CF Media Transformations)
  if (videoSize > MAX_VIDEO_SIZE_BYTES) {
    return false;
  }

  return true;
}

/**
 * Extract first frame from video using Cloudflare Media Transformations
 *
 * @param {string} sha256 - SHA256 hash of the video
 * @param {Object} env - Worker environment
 * @param {Function} [fetchFn] - Optional fetch function for testing
 * @returns {Promise<Object>} Result with success, data, contentType, or error
 */
export async function extractFirstFrame(sha256, env, fetchFn = fetch) {
  const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
  const width = env.THUMBNAIL_WIDTH || '480';

  const url = `https://${cdnDomain}/cdn-cgi/media/mode=frame,time=0s,width=${width}/${sha256}`;

  // Initial attempt + retries
  const maxAttempts = 1 + RETRY_DELAYS_MS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before retry (not on first attempt)
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }

    const response = await fetchFn(url);

    if (response.ok) {
      return {
        success: true,
        data: await response.arrayBuffer(),
        contentType: response.headers.get('content-type') || 'image/jpeg'
      };
    }

    // Check for non-retryable errors
    const cfResized = response.headers.get('cf-resized') || '';

    // 9412 = Invalid video format - won't succeed on retry
    if (cfResized.includes('9412')) {
      return { success: false, error: 'invalid_format', code: 9412 };
    }

    // 9413 = Video too large - won't succeed on retry
    if (cfResized.includes('9413')) {
      return { success: false, error: 'too_large', code: 9413 };
    }

    // For other errors (including 9404/not found), continue retrying
  }

  return { success: false, error: 'max_retries_exceeded' };
}

// Retry delays for duration check - longer than thumbnail extraction
// because we need to wait for R2 -> CDN propagation after fresh upload
const DURATION_CHECK_DELAYS_MS = [2000, 3000, 5000]; // Wait longer for CDN propagation

/**
 * Check if video duration exceeds the maximum allowed limit using Media Transformations
 *
 * Uses a clever trick: try to extract a frame at time=maxSeconds
 * - If successful (HTTP 200): video is longer than maxSeconds
 * - If error 9401 "Seek time exceeds duration": video is shorter than maxSeconds
 * - Other errors: can't determine, returns null
 *
 * Includes retry logic for 9404 errors (CDN propagation delay after R2 upload)
 *
 * @param {string} sha256 - SHA256 hash of the video
 * @param {Object} env - Worker environment
 * @param {number} [maxSeconds=7] - Maximum allowed duration in seconds
 * @param {Function} [fetchFn] - Optional fetch function for testing
 * @returns {Promise<Object>} Result with exceedsLimit (boolean or null if unknown)
 */
export async function checkVideoDuration(sha256, env, maxSeconds = 7, fetchFn = fetch) {
  const cdnDomain = env.STREAM_DOMAIN || 'cdn.divine.video';
  const url = `https://${cdnDomain}/cdn-cgi/media/mode=frame,time=${maxSeconds}s,width=480/${sha256}`;

  const maxAttempts = 1 + DURATION_CHECK_DELAYS_MS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before retry (not on first attempt)
    if (attempt > 0) {
      console.log(`[DurationCheck] Retry ${attempt}/${DURATION_CHECK_DELAYS_MS.length} after ${DURATION_CHECK_DELAYS_MS[attempt - 1]}ms`);
      await new Promise(r => setTimeout(r, DURATION_CHECK_DELAYS_MS[attempt - 1]));
    }

    try {
      const response = await fetchFn(url);

      if (response.ok) {
        // Frame extracted successfully at maxSeconds - video is too long
        return {
          exceedsLimit: true,
          message: `Video duration exceeds ${maxSeconds} seconds`
        };
      }

      // Check the error code
      const cfResized = response.headers.get('cf-resized') || '';

      // 9401 = "Seek time exceeds media duration" - video is shorter than maxSeconds
      if (cfResized.includes('9401')) {
        return {
          exceedsLimit: false,
          message: `Video duration is within ${maxSeconds} second limit`
        };
      }

      // 9412 = Invalid video format - can't determine duration (won't improve with retry)
      if (cfResized.includes('9412')) {
        return {
          exceedsLimit: null,
          error: 'invalid_format',
          code: 9412,
          message: 'Cannot determine duration - invalid video format'
        };
      }

      // 9408 = Origin error (video might be blocked/rejected already)
      if (cfResized.includes('9408')) {
        return {
          exceedsLimit: null,
          error: 'origin_error',
          code: 9408,
          message: 'Cannot determine duration - origin error'
        };
      }

      // 9404 = Not found - could be CDN propagation delay, retry
      if (cfResized.includes('9404') || cfResized.includes('9402')) {
        console.log(`[DurationCheck] Got ${cfResized} (attempt ${attempt + 1}/${maxAttempts})`);
        continue; // Retry
      }

      // Other errors - can't determine
      return {
        exceedsLimit: null,
        error: 'unknown',
        code: cfResized ? parseInt(cfResized.match(/\d+/)?.[0]) : null,
        message: 'Cannot determine duration'
      };

    } catch (error) {
      console.error('[DurationCheck] Error:', error);
      // Network error - retry
      continue;
    }
  }

  // All retries exhausted
  return {
    exceedsLimit: null,
    error: 'max_retries_exceeded',
    message: 'Cannot determine duration after retries'
  };
}
