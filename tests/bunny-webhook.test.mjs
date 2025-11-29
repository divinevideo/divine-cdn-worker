// ABOUTME: Unit tests for BunnyStream webhook handler
// ABOUTME: Tests signature verification, payload parsing, and event handling

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { BunnyWebhookHandler, BunnyWebhookError } from '../src/streaming/bunny-webhook.mjs';
import { VideoStatus } from '../src/streaming/bunny-client.mjs';

/**
 * Create a mock KV store for testing
 */
class MockKV {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async put(key, value) {
    this.store.set(key, value);
  }

  async delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

/**
 * Create a mock webhook request with signature
 */
async function createMockRequest(payload, secret, options = {}) {
  const body = JSON.stringify(payload);

  // Calculate HMAC-SHA1 signature (Bunny uses SHA-1)
  let signature = null;
  if (secret && !options.skipSignature) {
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

    signature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test_bearer_token_67890'  // Add bearer token for tests
  });

  if (signature && !options.invalidSignature) {
    headers.set('x-bunny-signature', signature);
  } else if (options.invalidSignature) {
    headers.set('x-bunny-signature', 'invalid_signature_12345');
  }

  return new Request('https://example.com/webhooks/bunny', {
    method: 'POST',
    headers,
    body
  });
}

describe('BunnyWebhookHandler', () => {
  let handler;
  let mockKV;
  let mockEnv;

  beforeEach(() => {
    handler = new BunnyWebhookHandler();
    mockKV = new MockKV();
    mockEnv = {
      MEDIA_KV: mockKV,
      BUNNY_SIGNING_KEY: 'test_secret_key_12345',
      BUNNY_WEBHOOK_SECRET: 'test_secret_key_12345',  // Alias for tests using old name
      BUNNY_WEBHOOK_TOKEN: 'test_bearer_token_67890',
      BUNNY_STREAM_PULL_ZONE: 'vz-test123.b-cdn.net',
      BUNNY_STREAM_LIBRARY_ID: '12345',
      BUNNY_STREAM_ACCESS_KEY: 'test_access_key',
      STREAM_DOMAIN: 'cdn.divine.video'
    };
  });

  describe('verifySignature', () => {
    it('should verify valid HMAC-SHA1 signature', async () => {
      const payload = { VideoGuid: 'test-123', Status: 3 };
      const request = await createMockRequest(payload, mockEnv.BUNNY_SIGNING_KEY);

      const isValid = await handler.verifySignature(request, mockEnv.BUNNY_SIGNING_KEY);
      assert.strictEqual(isValid, true);
    });

    it('should reject invalid signature', async () => {
      const payload = { VideoGuid: 'test-123', Status: 3 };
      const request = await createMockRequest(payload, mockEnv.BUNNY_SIGNING_KEY, { invalidSignature: true });

      const isValid = await handler.verifySignature(request, mockEnv.BUNNY_SIGNING_KEY);
      assert.strictEqual(isValid, false);
    });

    it('should reject missing signature', async () => {
      const payload = { VideoGuid: 'test-123', Status: 3 };
      const request = await createMockRequest(payload, null, { skipSignature: true });

      const isValid = await handler.verifySignature(request, mockEnv.BUNNY_SIGNING_KEY);
      assert.strictEqual(isValid, false);
    });

    it('should throw error if secret not configured', async () => {
      const payload = { VideoGuid: 'test-123', Status: 3 };
      const request = await createMockRequest(payload, null);

      await assert.rejects(
        async () => await handler.verifySignature(request, null),
        {
          name: 'BunnyWebhookError',
          message: 'Webhook secret not configured'
        }
      );
    });

    it('should use constant-time comparison', async () => {
      const payload = { VideoGuid: 'test-123', Status: 3 };

      // Create two requests with different payloads
      const request1 = await createMockRequest(payload, mockEnv.BUNNY_SIGNING_KEY);
      const request2 = await createMockRequest({ ...payload, Status: 4 }, mockEnv.BUNNY_SIGNING_KEY);

      // Get signature from request1 but validate request2 (signature mismatch)
      const sig1 = request1.headers.get('X-Bunny-Signature');
      const request2Modified = new Request(request2.url, {
        method: request2.method,
        headers: new Headers({
          'Content-Type': 'application/json',
          'X-Bunny-Signature': sig1
        }),
        body: await request2.text()
      });

      const isValid = await handler.verifySignature(request2Modified, mockEnv.BUNNY_WEBHOOK_SECRET);
      assert.strictEqual(isValid, false);
    });
  });

  describe('parseWebhook', () => {
    it('should parse valid webhook payload', async () => {
      const payload = {
        VideoGuid: 'abc-123-def',
        Status: 3,
        VideoLibraryId: 12345,
        Length: 120,
        EncodeProgress: 100,
        Timestamp: new Date().toISOString()
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);
      const parsed = await handler.parseWebhook(request);

      assert.strictEqual(parsed.VideoGuid, 'abc-123-def');
      assert.strictEqual(parsed.Status, 3);
      assert.strictEqual(parsed.Length, 120);
    });

    it('should reject payload without VideoGuid', async () => {
      const payload = { Status: 3 };
      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);

      await assert.rejects(
        async () => await handler.parseWebhook(request),
        {
          name: 'BunnyWebhookError',
          message: 'Missing VideoGuid in payload'
        }
      );
    });

    it('should reject payload without Status', async () => {
      const payload = { VideoGuid: 'abc-123' };
      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);

      await assert.rejects(
        async () => await handler.parseWebhook(request),
        {
          name: 'BunnyWebhookError',
          message: 'Missing Status in payload'
        }
      );
    });

    it('should reject invalid JSON', async () => {
      const request = new Request('https://example.com/webhooks/bunny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json {'
      });

      await assert.rejects(
        async () => await handler.parseWebhook(request),
        {
          name: 'BunnyWebhookError',
          message: 'Invalid JSON payload'
        }
      );
    });

    it('should reject webhook older than 5 minutes', async () => {
      const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
      const payload = {
        VideoGuid: 'abc-123',
        Status: 3,
        Timestamp: oldTimestamp
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);

      await assert.rejects(
        async () => await handler.parseWebhook(request),
        {
          name: 'BunnyWebhookError',
          message: 'Webhook too old (possible replay attack)'
        }
      );
    });

    it('should reject webhook with future timestamp', async () => {
      const futureTimestamp = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 minutes in future
      const payload = {
        VideoGuid: 'abc-123',
        Status: 3,
        Timestamp: futureTimestamp
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);

      await assert.rejects(
        async () => await handler.parseWebhook(request),
        {
          name: 'BunnyWebhookError',
          message: 'Webhook timestamp in future'
        }
      );
    });

    it('should accept webhook within 1 minute clock skew', async () => {
      const nearFutureTimestamp = new Date(Date.now() + 30 * 1000).toISOString(); // 30 seconds in future
      const payload = {
        VideoGuid: 'abc-123',
        Status: 3,
        Timestamp: nearFutureTimestamp
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);
      const parsed = await handler.parseWebhook(request);

      assert.strictEqual(parsed.VideoGuid, 'abc-123');
    });
  });

  describe('handleVideoEncoded', () => {
    it('should update KV with ready status and HLS URL', async () => {
      const sha256 = 'a'.repeat(64);
      const videoId = 'video-guid-123';

      // Setup: Store bunny:video mapping
      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({
        sha256,
        status: 'processing'
      }));

      // Setup: Store blob metadata
      await mockKV.put(`blob:${sha256}`, JSON.stringify({
        sha256,
        size: 1024,
        type: 'video/mp4',
        uploaded: Date.now(),
        provider: 'bunny'
      }));

      const payload = {
        VideoGuid: videoId,
        VideoLibraryId: 12345,
        Status: VideoStatus.FINISHED,
        Length: 6,  // Under 7 second duration limit
        EncodeProgress: 100,
        ThumbnailFileName: 'https://vz-test123.b-cdn.net/video-guid-123/thumbnail.jpg',
        Timestamp: new Date().toISOString()
      };

      await handler.handleVideoEncoded(payload, mockEnv);

      // Verify bunny:video updated
      const videoData = JSON.parse(await mockKV.get(`bunny:video:${videoId}`));
      assert.strictEqual(videoData.status, 'ready');
      assert.strictEqual(videoData.hlsUrl, `https://vz-test123.b-cdn.net/${videoId}/playlist.m3u8`);
      assert.strictEqual(videoData.duration, 6);
      assert.ok(videoData.encodedAt);

      // Verify blob updated
      const blobData = JSON.parse(await mockKV.get(`blob:${sha256}`));
      assert.strictEqual(blobData.bunny.status, 'ready');
      assert.strictEqual(blobData.bunny.hlsUrl, `https://vz-test123.b-cdn.net/${videoId}/playlist.m3u8`);
      assert.strictEqual(blobData.bunny.duration, 6);
      assert.strictEqual(blobData.provider, 'bunny');
    });

    it('should update provider to dual if R2 exists', async () => {
      const sha256 = 'b'.repeat(64);
      const videoId = 'video-guid-456';

      // Setup with existing R2 storage
      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256, status: 'processing' }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({
        sha256,
        size: 1024,
        type: 'video/mp4',
        uploaded: Date.now(),
        provider: 'r2',
        r2: { key: `videos/${sha256}.mp4`, uploaded: Date.now() }
      }));

      const payload = {
        VideoGuid: videoId,
        VideoLibraryId: 12345,
        Status: VideoStatus.FINISHED,
        Length: 5  // Under 7 second duration limit
      };

      await handler.handleVideoEncoded(payload, mockEnv);

      const blobData = JSON.parse(await mockKV.get(`blob:${sha256}`));
      assert.strictEqual(blobData.provider, 'dual');
      assert.ok(blobData.r2); // R2 data preserved
      assert.ok(blobData.bunny); // Bunny data added
    });

    it('should handle missing bunny:video entry gracefully', async () => {
      const payload = {
        VideoGuid: 'nonexistent-video',
        Status: VideoStatus.FINISHED,
        Length: 60
      };

      // Should not throw, just log warning
      await handler.handleVideoEncoded(payload, mockEnv);
    });
  });

  describe('handleVideoFailed', () => {
    it('should update KV with error status and message', async () => {
      const sha256 = 'c'.repeat(64);
      const videoId = 'video-guid-789';
      const errorMessage = 'Invalid video format';

      // Setup
      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256, status: 'processing' }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({
        sha256,
        size: 1024,
        type: 'video/mp4',
        provider: 'bunny'
      }));

      const payload = {
        VideoGuid: videoId,
        Status: VideoStatus.ERROR,
        Message: errorMessage,
        Timestamp: new Date().toISOString()
      };

      await handler.handleVideoFailed(payload, mockEnv);

      // Verify bunny:video updated
      const videoData = JSON.parse(await mockKV.get(`bunny:video:${videoId}`));
      assert.strictEqual(videoData.status, 'error');
      assert.strictEqual(videoData.error, errorMessage);

      // Verify blob updated
      const blobData = JSON.parse(await mockKV.get(`blob:${sha256}`));
      assert.strictEqual(blobData.bunny.status, 'error');
      assert.strictEqual(blobData.bunny.error, errorMessage);
    });

    it('should use default error message if not provided', async () => {
      const sha256 = 'd'.repeat(64);
      const videoId = 'video-guid-999';

      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256, status: 'processing' }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({ sha256, provider: 'bunny' }));

      const payload = {
        VideoGuid: videoId,
        Status: VideoStatus.ERROR
      };

      await handler.handleVideoFailed(payload, mockEnv);

      const videoData = JSON.parse(await mockKV.get(`bunny:video:${videoId}`));
      assert.strictEqual(videoData.error, 'Encoding failed');
    });
  });

  describe('handleVideoDeleted', () => {
    it('should remove Bunny data from KV', async () => {
      const sha256 = 'e'.repeat(64);
      const videoId = 'video-guid-del';

      // Setup
      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256 }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({
        sha256,
        provider: 'bunny',
        bunny: { videoId, status: 'ready', hlsUrl: 'https://example.com/video.m3u8' }
      }));

      const payload = {
        VideoGuid: videoId,
        Status: 0 // Status doesn't matter for deletion
      };

      await handler.handleVideoDeleted(payload, mockEnv);

      // Verify bunny:video deleted
      const videoData = await mockKV.get(`bunny:video:${videoId}`);
      assert.strictEqual(videoData, null);

      // Verify blob updated
      const blobData = JSON.parse(await mockKV.get(`blob:${sha256}`));
      assert.strictEqual(blobData.bunny, undefined);
    });

    it('should update provider to r2 if R2 storage exists', async () => {
      const sha256 = 'f'.repeat(64);
      const videoId = 'video-guid-del2';

      // Setup with dual storage
      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256 }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({
        sha256,
        provider: 'dual',
        r2: { key: `videos/${sha256}.mp4` },
        bunny: { videoId, status: 'ready' }
      }));

      const payload = { VideoGuid: videoId, Status: 0 };
      await handler.handleVideoDeleted(payload, mockEnv);

      const blobData = JSON.parse(await mockKV.get(`blob:${sha256}`));
      assert.strictEqual(blobData.provider, 'r2');
      assert.ok(blobData.r2);
      assert.strictEqual(blobData.bunny, undefined);
    });
  });

  describe('process', () => {
    it('should return 401 for invalid signature', async () => {
      const payload = { VideoGuid: 'test-123', Status: 3 };
      const request = await createMockRequest(payload, mockEnv.BUNNY_SIGNING_KEY, { invalidSignature: true });

      const response = await handler.process(request, mockEnv);
      assert.strictEqual(response.status, 401);
    });

    it('should return 400 for invalid payload', async () => {
      const invalidBody = 'invalid json';

      // Create valid signature for invalid JSON (signature will pass, but JSON parsing will fail)
      // Note: Bunny uses SHA-1 for webhook signatures
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(mockEnv.BUNNY_SIGNING_KEY),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      );

      const signatureBytes = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(invalidBody)
      );

      const signature = Array.from(new Uint8Array(signatureBytes))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const request = new Request('https://example.com/webhooks/bunny', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bunny-Signature': signature,
          'Authorization': 'Bearer test_bearer_token_67890'
        },
        body: invalidBody
      });

      const response = await handler.process(request, mockEnv);
      assert.strictEqual(response.status, 400);
    });

    it('should return 200 for successful encoding webhook', async () => {
      const sha256 = 'g'.repeat(64);
      const videoId = 'video-success';

      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256, status: 'processing' }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({ sha256, provider: 'bunny' }));

      const payload = {
        VideoGuid: videoId,
        Status: VideoStatus.FINISHED,
        Length: 5,  // Under 7 second duration limit
        Timestamp: new Date().toISOString()
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);
      const response = await handler.process(request, mockEnv);

      assert.strictEqual(response.status, 200);

      // Verify data updated
      const videoData = JSON.parse(await mockKV.get(`bunny:video:${videoId}`));
      assert.strictEqual(videoData.status, 'ready');
    });

    it('should return 200 for failed encoding webhook', async () => {
      const sha256 = 'h'.repeat(64);
      const videoId = 'video-fail';

      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256, status: 'processing' }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({ sha256, provider: 'bunny' }));

      const payload = {
        VideoGuid: videoId,
        Status: VideoStatus.ERROR,
        Message: 'Test error',
        Timestamp: new Date().toISOString()
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);
      const response = await handler.process(request, mockEnv);

      assert.strictEqual(response.status, 200);

      // Verify error recorded
      const videoData = JSON.parse(await mockKV.get(`bunny:video:${videoId}`));
      assert.strictEqual(videoData.status, 'error');
      assert.strictEqual(videoData.error, 'Test error');
    });

    it('should return 200 for virus detected webhook', async () => {
      const sha256 = 'i'.repeat(64);
      const videoId = 'video-virus';

      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256, status: 'processing' }));
      await mockKV.put(`blob:${sha256}`, JSON.stringify({ sha256, provider: 'bunny' }));

      const payload = {
        VideoGuid: videoId,
        Status: VideoStatus.VIRUS_DETECTED,
        Message: 'Virus detected',
        Timestamp: new Date().toISOString()
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);
      const response = await handler.process(request, mockEnv);

      assert.strictEqual(response.status, 200);
    });

    it('should acknowledge intermediate status updates', async () => {
      const payload = {
        VideoGuid: 'video-processing',
        Status: VideoStatus.ENCODING,
        EncodeProgress: 50,
        Timestamp: new Date().toISOString()
      };

      const request = await createMockRequest(payload, mockEnv.BUNNY_WEBHOOK_SECRET);
      const response = await handler.process(request, mockEnv);

      assert.strictEqual(response.status, 200);
    });

    it('should return 500 for processing errors', async () => {
      // Create env without required config
      const badEnv = {
        MEDIA_KV: mockKV,
        BUNNY_WEBHOOK_SECRET: 'test_secret',
        // Missing BUNNY_STREAM_PULL_ZONE
      };

      const sha256 = 'j'.repeat(64);
      const videoId = 'video-error';

      await mockKV.put(`bunny:video:${videoId}`, JSON.stringify({ sha256 }));

      const payload = {
        VideoGuid: videoId,
        Status: VideoStatus.FINISHED,
        Length: 100,
        Timestamp: new Date().toISOString()
      };

      const request = await createMockRequest(payload, badEnv.BUNNY_WEBHOOK_SECRET);
      const response = await handler.process(request, badEnv);

      assert.strictEqual(response.status, 500);
    });
  });

  describe('_constantTimeCompare', () => {
    it('should return true for equal strings', () => {
      const result = handler._constantTimeCompare('abc123', 'abc123');
      assert.strictEqual(result, true);
    });

    it('should return false for different strings of same length', () => {
      const result = handler._constantTimeCompare('abc123', 'abc456');
      assert.strictEqual(result, false);
    });

    it('should return false for strings of different length', () => {
      const result = handler._constantTimeCompare('abc', 'abcdef');
      assert.strictEqual(result, false);
    });

    it('should be case sensitive', () => {
      const result = handler._constantTimeCompare('ABC', 'abc');
      assert.strictEqual(result, false);
    });
  });
});
