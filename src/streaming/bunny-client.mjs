// ABOUTME: BunnyStream API client for video streaming and encoding
// ABOUTME: Handles video uploads, status checks, and management via Bunny.net Stream API

/**
 * Video status codes from Bunny Stream API
 * @readonly
 * @enum {number}
 */
export const VideoStatus = {
  QUEUED: 0,
  PROCESSING: 1,
  ENCODING: 2,
  FINISHED: 3,
  RESOLUTION_FINISHED: 4,
  ERROR: 5,
  VIRUS_DETECTED: 6
};

/**
 * Human-readable status labels
 * @readonly
 * @enum {string}
 */
export const VideoStatusLabel = {
  [VideoStatus.QUEUED]: 'queued',
  [VideoStatus.PROCESSING]: 'processing',
  [VideoStatus.ENCODING]: 'encoding',
  [VideoStatus.FINISHED]: 'ready',
  [VideoStatus.RESOLUTION_FINISHED]: 'ready',
  [VideoStatus.ERROR]: 'error',
  [VideoStatus.VIRUS_DETECTED]: 'virus_detected'
};

/**
 * BunnyStream API error class
 */
export class BunnyStreamError extends Error {
  constructor(message, statusCode = null, response = null) {
    super(message);
    this.name = 'BunnyStreamError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

/**
 * Client for interacting with Bunny.net Stream API
 *
 * @example
 * const client = new BunnyStreamClient(env.BUNNY_STREAM_ACCESS_KEY, env.BUNNY_STREAM_LIBRARY_ID);
 * const video = await client.createVideo('My Video');
 * console.log(video.videoId, video.uploadUrl);
 */
export class BunnyStreamClient {
  /**
   * Create a new BunnyStream client
   *
   * @param {string} accessKey - Bunny Stream API access key
   * @param {string} libraryId - Bunny Stream library ID
   * @param {Object} options - Optional configuration
   * @param {string} [options.apiEndpoint='https://video.bunnycdn.com'] - API base URL
   * @param {number} [options.timeout=30000] - Request timeout in milliseconds
   * @param {string} [options.region=''] - Region code (e.g., 'ny', 'la', 'sg') or empty for global
   */
  constructor(accessKey, libraryId, options = {}) {
    if (!accessKey || !libraryId) {
      throw new Error('accessKey and libraryId are required');
    }

    this.accessKey = accessKey;
    this.libraryId = libraryId;
    this.apiEndpoint = options.apiEndpoint || 'https://video.bunnycdn.com';
    this.timeout = options.timeout || 30000;
    this.region = options.region || '';
  }

  /**
   * Make an authenticated request to the Bunny Stream API
   *
   * @private
   * @param {string} path - API path (e.g., '/videos')
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} Response data
   * @throws {BunnyStreamError} If request fails
   */
  async _request(path, options = {}) {
    const url = `${this.apiEndpoint}/library/${this.libraryId}${path}`;

    const headers = {
      'AccessKey': this.accessKey,
      'Accept': 'application/json',
      ...options.headers
    };

    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Handle successful deletion (204 No Content)
      if (response.status === 204) {
        return { success: true };
      }

      // Read response body
      const contentType = response.headers.get('content-type');
      let data = null;

      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        data = { message: text };
      }

      // Handle errors
      if (!response.ok) {
        const message = data?.message || data?.Message || `API request failed with status ${response.status}`;
        throw new BunnyStreamError(message, response.status, data);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new BunnyStreamError('Request timeout', null, null);
      }

      if (error instanceof BunnyStreamError) {
        throw error;
      }

      throw new BunnyStreamError(`Network error: ${error.message}`, null, null);
    }
  }

  /**
   * Create a new video and get an upload URL
   *
   * @param {string} title - Video title
   * @param {string} [collectionId=null] - Optional collection ID to organize videos
   * @returns {Promise<Object>} Video creation response
   * @returns {string} return.videoId - Unique video ID
   * @returns {string} return.guid - Video GUID (used in URLs)
   * @returns {number} return.libraryId - Library ID
   *
   * @example
   * const video = await client.createVideo('My Video', 'collection-123');
   * // Upload video to video.uploadUrl
   */
  async createVideo(title, collectionId = null) {
    const body = { title };

    if (collectionId) {
      body.collectionId = collectionId;
    }

    const data = await this._request('/videos', {
      method: 'POST',
      body
    });

    return {
      videoId: data.guid || data.videoId,
      guid: data.guid,
      libraryId: data.libraryId
    };
  }

  /**
   * Get video details and status
   *
   * @param {string} videoId - Video ID or GUID
   * @returns {Promise<Object>} Video details
   * @returns {string} return.videoId - Video ID
   * @returns {string} return.guid - Video GUID
   * @returns {number} return.status - Status code (see VideoStatus enum)
   * @returns {string} return.statusLabel - Human-readable status
   * @returns {string} [return.hlsUrl] - HLS playlist URL (when ready)
   * @returns {string} [return.mp4Url] - MP4 direct URL (when ready)
   * @returns {string} [return.thumbnailUrl] - Thumbnail URL (when ready)
   * @returns {number} [return.duration] - Video duration in seconds
   * @returns {number} [return.width] - Video width in pixels
   * @returns {number} [return.height] - Video height in pixels
   *
   * @example
   * const video = await client.getVideo('video-guid-123');
   * if (video.status === VideoStatus.FINISHED) {
   *   console.log('HLS URL:', video.hlsUrl);
   * }
   */
  async getVideo(videoId) {
    const data = await this._request(`/videos/${videoId}`, {
      method: 'GET'
    });

    const status = data.status ?? VideoStatus.QUEUED;
    const statusLabel = VideoStatusLabel[status] || 'unknown';

    const result = {
      videoId: data.guid || data.videoId,
      guid: data.guid,
      title: data.title,
      status,
      statusLabel,
      availableResolutions: data.availableResolutions || null,
      thumbnailCount: data.thumbnailCount || 0,
      encodeProgress: data.encodeProgress || 0,
      originalHash: data.originalHash || null  // SHA256 hash calculated by BunnyStream
    };

    // Add URLs if available (status >= FINISHED)
    if (status >= VideoStatus.FINISHED) {
      // HLS playlist URL
      if (data.videoPlaylistUrl) {
        result.hlsUrl = data.videoPlaylistUrl;
      }

      // MP4 direct URL (if available)
      if (data.mp4Url) {
        result.mp4Url = data.mp4Url;
      }

      // Thumbnail URL
      if (data.thumbnailFileName) {
        result.thumbnailUrl = data.thumbnailFileName;
      }

      // Video metadata
      result.duration = data.length || 0;
      result.width = data.width || null;
      result.height = data.height || null;
      result.framerate = data.framerate || null;
      result.views = data.views || 0;
    }

    // Add error info if present
    if (status === VideoStatus.ERROR && data.errorMessage) {
      result.error = data.errorMessage;
    }

    return result;
  }

  /**
   * Delete a video from Bunny Stream
   *
   * @param {string} videoId - Video ID or GUID to delete
   * @returns {Promise<Object>} Deletion response
   * @returns {boolean} return.success - Whether deletion succeeded
   *
   * @example
   * await client.deleteVideo('video-guid-123');
   */
  async deleteVideo(videoId) {
    return await this._request(`/videos/${videoId}`, {
      method: 'DELETE'
    });
  }

  /**
   * Upload video from a URL (useful for backfilling from R2)
   *
   * @param {string} videoId - Video ID or GUID
   * @param {string} sourceUrl - Public URL of the video file
   * @param {Object} [options={}] - Upload options
   * @param {Object} [options.headers] - Custom headers for fetching source URL
   * @returns {Promise<Object>} Upload response
   * @returns {boolean} return.success - Whether upload initiated successfully
   * @returns {string} return.message - Status message
   *
   * @example
   * const video = await client.createVideo('Backfilled Video');
   * await client.uploadFromUrl(video.videoId, 'https://cdn.divine.video/abc123.mp4');
   */
  async uploadFromUrl(videoId, sourceUrl, options = {}) {
    const body = {
      url: sourceUrl
    };

    if (options.headers) {
      body.headers = options.headers;
    }

    const data = await this._request(`/videos/${videoId}/fetch`, {
      method: 'POST',
      body
    });

    return {
      success: data.success ?? true,
      message: data.message || 'Upload initiated'
    };
  }

  /**
   * List videos in the library
   *
   * @param {number} [page=1] - Page number (1-indexed)
   * @param {number} [itemsPerPage=100] - Items per page (max 100)
   * @param {string} [orderBy='date'] - Sort field (date, title, etc)
   * @returns {Promise<Object>} Video list response
   * @returns {Array} return.items - Array of video objects
   * @returns {number} return.currentPage - Current page number
   * @returns {number} return.totalItems - Total number of videos
   * @returns {number} return.totalPages - Total number of pages
   *
   * @example
   * const result = await client.listVideos(1, 50);
   * for (const video of result.items) {
   *   console.log(video.guid, video.title, video.status);
   * }
   */
  async listVideos(page = 1, itemsPerPage = 100, orderBy = 'date') {
    const params = new URLSearchParams({
      page: page.toString(),
      itemsPerPage: Math.min(itemsPerPage, 100).toString(),
      orderBy
    });

    const data = await this._request(`/videos?${params}`, {
      method: 'GET'
    });

    return {
      items: data.items || [],
      currentPage: data.currentPage || page,
      totalItems: data.totalItems || 0,
      totalPages: data.totalPages || 0
    };
  }

  /**
   * Get video upload URL for direct upload
   * Note: For most cases, use createVideo() which returns the upload URL directly
   *
   * @param {string} videoId - Video ID or GUID
   * @returns {Promise<string>} Upload URL
   *
   * @example
   * const uploadUrl = await client.getUploadUrl('video-guid-123');
   * // PUT video file to uploadUrl
   */
  async getUploadUrl(videoId) {
    // Bunny Stream videos have a direct upload URL pattern
    const region = this.region ? `${this.region}.` : '';
    return `https://${region}video.bunnycdn.com/library/${this.libraryId}/videos/${videoId}`;
  }

  /**
   * Update video metadata
   *
   * @param {string} videoId - Video ID or GUID
   * @param {Object} updates - Fields to update
   * @param {string} [updates.title] - New title
   * @param {string} [updates.collectionId] - New collection ID
   * @returns {Promise<Object>} Updated video object
   *
   * @example
   * await client.updateVideo('video-guid-123', { title: 'New Title' });
   */
  async updateVideo(videoId, updates) {
    const data = await this._request(`/videos/${videoId}`, {
      method: 'POST',
      body: updates
    });

    return data;
  }
}
