// ABOUTME: D1 database logging for Bunny webhook events
// ABOUTME: Provides queryable history of video processing events

/**
 * Status code mapping for Bunny webhooks
 */
const BUNNY_STATUS_MAP = {
  0: 'queued',
  1: 'processing',
  2: 'encoding',
  3: 'finished',
  4: 'resolution_finished',
  5: 'error'
};

/**
 * Log a Bunny webhook event to D1 database
 *
 * @param {Object} env - Cloudflare Worker environment (must have DB binding)
 * @param {Object} payload - Webhook payload from Bunny
 * @param {string} sha256 - SHA-256 hash from our system (optional)
 * @param {Object} urls - Extracted URLs (optional)
 * @returns {Promise<void>}
 */
export async function logWebhookEvent(env, payload, sha256 = null, urls = {}) {
  // Skip if DB not configured
  if (!env.DB) {
    console.warn('[D1Logger] DB binding not configured, skipping webhook log');
    return;
  }

  try {
    const statusCode = payload.Status;
    const statusName = BUNNY_STATUS_MAP[statusCode] || `unknown_${statusCode}`;

    await env.DB.prepare(`
      INSERT INTO bunny_webhook_events (
        video_guid,
        video_id,
        sha256,
        status,
        status_name,
        timestamp,
        hls_url,
        thumbnail_url,
        mp4_url,
        error_message,
        webhook_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_guid, timestamp) DO UPDATE SET
        sha256 = excluded.sha256,
        hls_url = excluded.hls_url,
        thumbnail_url = excluded.thumbnail_url,
        mp4_url = excluded.mp4_url,
        error_message = excluded.error_message
    `)
      .bind(
        payload.VideoGuid,
        payload.VideoGuid, // video_id (Bunny uses GUID)
        sha256,
        statusCode,
        statusName,
        payload.Timestamp || new Date().toISOString(),
        urls.hlsUrl || null,
        urls.thumbnailUrl || null,
        urls.mp4Url || null,
        payload.ErrorMessage || null,
        JSON.stringify(payload)
      )
      .run();

    console.log(`[D1Logger] Logged ${statusName} event for ${payload.VideoGuid.substring(0, 12)}...`);
  } catch (error) {
    // Don't fail the webhook processing if D1 logging fails
    console.error('[D1Logger] Failed to log webhook event:', error);
  }
}

/**
 * Update video metadata in D1
 *
 * @param {Object} env - Cloudflare Worker environment
 * @param {string} sha256 - SHA-256 hash
 * @param {Object} data - Video metadata
 * @returns {Promise<void>}
 */
export async function updateVideoMetadata(env, sha256, data) {
  if (!env.DB) {
    return;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO video_metadata (
        sha256,
        video_guid,
        video_id,
        bunny_library_id,
        current_status,
        current_hls_url,
        current_thumbnail_url,
        current_mp4_url,
        uploaded_by,
        uploaded_at,
        file_size,
        mime_type,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sha256) DO UPDATE SET
        current_status = excluded.current_status,
        current_hls_url = excluded.current_hls_url,
        current_thumbnail_url = excluded.current_thumbnail_url,
        current_mp4_url = excluded.current_mp4_url,
        updated_at = CURRENT_TIMESTAMP
    `)
      .bind(
        sha256,
        data.video_guid,
        data.video_id,
        data.bunny_library_id,
        data.status,
        data.hls_url || null,
        data.thumbnail_url || null,
        data.mp4_url || null,
        data.uploaded_by || null,
        data.uploaded_at || null,
        data.file_size || null,
        data.mime_type || null
      )
      .run();

    console.log(`[D1Logger] Updated metadata for ${sha256.substring(0, 12)}...`);
  } catch (error) {
    console.error('[D1Logger] Failed to update metadata:', error);
  }
}

/**
 * Query recent webhook events
 *
 * @param {Object} env - Cloudflare Worker environment
 * @param {Object} options - Query options
 * @param {number} options.limit - Maximum number of events (default 100, max 500)
 * @param {string} options.sha256 - Filter by SHA-256 hash
 * @param {string} options.video_guid - Filter by video GUID
 * @param {string} options.status - Filter by status name
 * @returns {Promise<Array>} Array of events
 */
export async function queryWebhookEvents(env, options = {}) {
  if (!env.DB) {
    return [];
  }

  const { limit = 100, sha256, video_guid, status } = options;
  const safeLimit = Math.min(limit, 500); // Cap at 500
  let query = 'SELECT * FROM bunny_webhook_events WHERE 1=1';
  const bindings = [];

  if (sha256) {
    query += ' AND sha256 = ?';
    bindings.push(sha256);
  }

  if (video_guid) {
    query += ' AND video_guid = ?';
    bindings.push(video_guid);
  }

  if (status) {
    query += ' AND status_name = ?';
    bindings.push(status);
  }

  query += ' ORDER BY received_at DESC LIMIT ?';
  bindings.push(safeLimit);

  try {
    const result = await env.DB.prepare(query).bind(...bindings).all();
    return result.results || [];
  } catch (error) {
    console.error('[D1Logger] Query failed:', error);
    return [];
  }
}

/**
 * Get video metadata by SHA-256
 *
 * @param {Object} env - Cloudflare Worker environment
 * @param {string} sha256 - SHA-256 hash
 * @returns {Promise<Object|null>} Video metadata or null
 */
export async function getVideoMetadata(env, sha256) {
  if (!env.DB) {
    return null;
  }

  try {
    const result = await env.DB.prepare(
      'SELECT * FROM video_metadata WHERE sha256 = ?'
    ).bind(sha256).first();
    return result;
  } catch (error) {
    console.error('[D1Logger] Query failed:', error);
    return null;
  }
}

/**
 * Get video metadata by video GUID
 *
 * @param {Object} env - Cloudflare Worker environment
 * @param {string} video_guid - Video GUID
 * @returns {Promise<Object|null>} Video metadata or null
 */
export async function getVideoMetadataByGuid(env, video_guid) {
  if (!env.DB) {
    return null;
  }

  try {
    const result = await env.DB.prepare(
      'SELECT * FROM video_metadata WHERE video_guid = ?'
    ).bind(video_guid).first();
    return result;
  } catch (error) {
    console.error('[D1Logger] Query failed:', error);
    return null;
  }
}

/**
 * Get videos by uploader (Nostr pubkey)
 *
 * @param {Object} env - Cloudflare Worker environment
 * @param {string} pubkey - Nostr public key
 * @param {number} limit - Maximum results (default 100, max 500)
 * @returns {Promise<Array>} Array of video metadata
 */
export async function getVideosByUploader(env, pubkey, limit = 100) {
  if (!env.DB) {
    return [];
  }

  const safeLimit = Math.min(limit, 500);

  try {
    const result = await env.DB.prepare(
      'SELECT * FROM video_metadata WHERE uploaded_by = ? ORDER BY uploaded_at DESC LIMIT ?'
    ).bind(pubkey, safeLimit).all();
    return result.results || [];
  } catch (error) {
    console.error('[D1Logger] Query failed:', error);
    return [];
  }
}
