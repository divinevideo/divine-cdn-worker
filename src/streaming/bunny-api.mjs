// ABOUTME: Public read-only API endpoints for querying Bunny video data
// ABOUTME: Provides video metadata and webhook event history from D1 database

import {
  queryWebhookEvents,
  getVideoMetadata,
  getVideoMetadataByGuid,
  getVideosByUploader
} from './d1-logger.mjs';

/**
 * Handle Bunny API requests
 *
 * Routes:
 *   GET /bunny/video/:sha256          - Get video by SHA-256
 *   GET /bunny/video/guid/:guid       - Get video by Bunny GUID
 *   GET /bunny/video/uploader/:pubkey - Get videos by uploader
 *   GET /bunny/events                 - List webhook events (with filters)
 *   GET /bunny/events/:video_guid     - Get events for specific video
 *   GET /bunny/recent                 - Recent videos
 *   GET /bunny/failed                 - Failed encodings
 *   GET /bunny/processing             - Currently processing videos
 *
 * @param {Request} request - HTTP request
 * @param {Object} env - Cloudflare Worker environment
 * @param {string} pathname - URL pathname
 * @returns {Promise<Response>}
 */
export async function handleBunnyAPI(request, env, pathname) {
  const url = new URL(request.url);

  // GET /bunny/video/:sha256
  if (pathname.match(/^\/bunny\/video\/[0-9a-f]{64}$/)) {
    const sha256 = pathname.split('/').pop();
    return await handleGetVideoByHash(env, sha256);
  }

  // GET /bunny/video/guid/:guid
  if (pathname.match(/^\/bunny\/video\/guid\/.+$/)) {
    const guid = pathname.split('/').pop();
    return await handleGetVideoByGuid(env, guid);
  }

  // GET /bunny/video/uploader/:pubkey
  if (pathname.match(/^\/bunny\/video\/uploader\/[0-9a-f]{64}$/)) {
    const pubkey = pathname.split('/').pop();
    const limit = parseInt(url.searchParams.get('limit')) || 100;
    return await handleGetVideosByUploader(env, pubkey, limit);
  }

  // GET /bunny/events/:video_guid
  if (pathname.match(/^\/bunny\/events\/.+$/) && !pathname.endsWith('/events')) {
    const guid = pathname.split('/').pop();
    return await handleGetEventsByGuid(env, guid);
  }

  // GET /bunny/events
  if (pathname === '/bunny/events') {
    const options = {
      sha256: url.searchParams.get('sha256'),
      video_guid: url.searchParams.get('video_guid'),
      status: url.searchParams.get('status'),
      limit: parseInt(url.searchParams.get('limit')) || 100
    };
    return await handleListEvents(env, options);
  }

  // GET /bunny/recent
  if (pathname === '/bunny/recent') {
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    return await handleRecentVideos(env, limit);
  }

  // GET /bunny/failed
  if (pathname === '/bunny/failed') {
    const limit = parseInt(url.searchParams.get('limit')) || 100;
    return await handleListEvents(env, { status: 'error', limit });
  }

  // GET /bunny/processing
  if (pathname === '/bunny/processing') {
    const limit = parseInt(url.searchParams.get('limit')) || 100;
    return await handleListEvents(env, { status: 'processing', limit });
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * Get video metadata and latest event by SHA-256
 */
async function handleGetVideoByHash(env, sha256) {
  const metadata = await getVideoMetadata(env, sha256);

  if (!metadata) {
    return jsonResponse({ error: 'Video not found' }, 404);
  }

  // Get latest webhook event for this video
  const events = await queryWebhookEvents(env, { sha256, limit: 1 });
  const latestEvent = events[0] || null;

  return jsonResponse({
    metadata,
    latestEvent,
    eventsCount: events.length
  });
}

/**
 * Get video metadata and latest event by Bunny GUID
 */
async function handleGetVideoByGuid(env, video_guid) {
  const metadata = await getVideoMetadataByGuid(env, video_guid);

  if (!metadata) {
    return jsonResponse({ error: 'Video not found' }, 404);
  }

  // Get latest webhook event for this video
  const events = await queryWebhookEvents(env, { video_guid, limit: 1 });
  const latestEvent = events[0] || null;

  return jsonResponse({
    metadata,
    latestEvent,
    eventsCount: events.length
  });
}

/**
 * Get videos by uploader pubkey
 */
async function handleGetVideosByUploader(env, pubkey, limit) {
  const videos = await getVideosByUploader(env, pubkey, limit);

  return jsonResponse({
    uploader: pubkey,
    count: videos.length,
    videos
  });
}

/**
 * Get all webhook events for a specific video GUID
 */
async function handleGetEventsByGuid(env, video_guid) {
  const events = await queryWebhookEvents(env, { video_guid, limit: 500 });

  return jsonResponse({
    video_guid,
    count: events.length,
    events
  });
}

/**
 * List webhook events with filters
 */
async function handleListEvents(env, options) {
  const events = await queryWebhookEvents(env, options);

  return jsonResponse({
    count: events.length,
    filters: options,
    events
  });
}

/**
 * Get recent videos (from video_metadata table)
 */
async function handleRecentVideos(env, limit) {
  if (!env.DB) {
    return jsonResponse({ error: 'Database not configured' }, 503);
  }

  const safeLimit = Math.min(limit, 500);

  try {
    const result = await env.DB.prepare(
      'SELECT * FROM video_metadata ORDER BY uploaded_at DESC LIMIT ?'
    ).bind(safeLimit).all();

    return jsonResponse({
      count: result.results.length,
      videos: result.results || []
    });
  } catch (error) {
    console.error('[BunnyAPI] Recent videos query failed:', error);
    return jsonResponse({ error: 'Query failed' }, 500);
  }
}

/**
 * Helper to create JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'public, max-age=60' // Cache for 1 minute
    }
  });
}
