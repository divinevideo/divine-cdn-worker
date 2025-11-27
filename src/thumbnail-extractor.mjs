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
