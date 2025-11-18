// ABOUTME: Unit tests for BunnyStream upload strategy router
// ABOUTME: Tests strategy selection, hash-based distribution, and upload handler

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectUploadStrategy, BunnyUploadHandler } from '../src/streaming/upload-strategy.mjs';

/**
 * Mock environment for testing
 */
function createMockEnv(overrides = {}) {
  const kvStore = new Map();

  const MEDIA_KV = {
    async get(key, options) {
      const value = kvStore.get(key);
      if (!value) return null;
      if (options?.type === 'json') {
        return JSON.parse(value);
      }
      return value;
    },
    async put(key, value, options) {
      kvStore.set(key, value);
    },
    async delete(key) {
      kvStore.delete(key);
    }
  };

  return {
    MEDIA_KV,
    BUNNY_STREAM_ENABLED: 'false',
    BUNNY_UPLOAD_DEST: 'r2',
    BUNNY_ROLLOUT_PERCENTAGE: '0',
    BUNNY_STREAM_ACCESS_KEY: '',
    BUNNY_STREAM_LIBRARY_ID: '',
    BUNNY_API_ENDPOINT: 'https://video.bunnycdn.com',
    BUNNY_STREAM_REGION: '',
    ...overrides
  };
}

// Test hashes - these will deterministically hash to specific values
const TEST_HASHES = {
  // Hash starting with '00' -> parseInt('00000000', 16) % 100 = 0
  LOW: '0000000000000000000000000000000000000000000000000000000000000000',
  // Hash starting with '32' -> parseInt('32000000', 16) % 100 = 48
  MID: '3200000000000000000000000000000000000000000000000000000000000000',
  // Hash starting with 'ff' -> parseInt('ff000000', 16) % 100 = 95
  HIGH: 'ff00000000000000000000000000000000000000000000000000000000000000'
};

// ============================================================================
// Strategy Selection Tests
// ============================================================================

test('selectUploadStrategy: returns r2 when BunnyStream disabled', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'false'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.MID, {});

  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

test('selectUploadStrategy: returns r2 when BUNNY_UPLOAD_DEST is r2', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'r2'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.MID, {});

  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

test('selectUploadStrategy: returns bunny when BUNNY_UPLOAD_DEST is bunny', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'bunny'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.MID, {});

  assert.equal(result.provider, 'bunny');
  assert.equal(result.shouldUseBunny, true);
});

test('selectUploadStrategy: dual mode with 0% rollout routes to r2', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '0'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.LOW, {});

  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

test('selectUploadStrategy: dual mode with 100% rollout routes to bunny', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '100'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.HIGH, {});

  assert.equal(result.provider, 'bunny');
  assert.equal(result.shouldUseBunny, true);
});

test('selectUploadStrategy: dual mode with 50% rollout uses hash-based distribution', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '50'
  });

  // LOW hash (0) < 50 -> bunny
  const lowResult = selectUploadStrategy(env, TEST_HASHES.LOW, {});
  assert.equal(lowResult.provider, 'bunny');
  assert.equal(lowResult.shouldUseBunny, true);

  // MID hash (48) < 50 -> bunny
  const midResult = selectUploadStrategy(env, TEST_HASHES.MID, {});
  assert.equal(midResult.provider, 'bunny');
  assert.equal(midResult.shouldUseBunny, true);

  // HIGH hash (95) >= 50 -> r2
  const highResult = selectUploadStrategy(env, TEST_HASHES.HIGH, {});
  assert.equal(highResult.provider, 'r2');
  assert.equal(highResult.shouldUseBunny, false);
});

test('selectUploadStrategy: dual mode provides consistent routing for same hash', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '50'
  });

  const hash = TEST_HASHES.MID;

  // Call multiple times with same hash
  const result1 = selectUploadStrategy(env, hash, {});
  const result2 = selectUploadStrategy(env, hash, {});
  const result3 = selectUploadStrategy(env, hash, {});

  // All should return same result
  assert.equal(result1.provider, result2.provider);
  assert.equal(result2.provider, result3.provider);
  assert.equal(result1.shouldUseBunny, result2.shouldUseBunny);
  assert.equal(result2.shouldUseBunny, result3.shouldUseBunny);
});

test('selectUploadStrategy: unknown destination defaults to r2', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'invalid-value'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.MID, {});

  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

// ============================================================================
// BunnyUploadHandler Tests
// ============================================================================

test('BunnyUploadHandler: initiateUpload returns null when client not configured', async () => {
  const env = createMockEnv({
    BUNNY_STREAM_ACCESS_KEY: '', // Missing credentials
    BUNNY_STREAM_LIBRARY_ID: ''
  });

  const handler = new BunnyUploadHandler(env);
  const result = await handler.initiateUpload(TEST_HASHES.MID, { type: 'video/mp4', size: 1000 }, env);

  assert.equal(result, null);
});

test('BunnyUploadHandler: getStreamingUrls returns null when no bunny metadata exists', async () => {
  const env = createMockEnv({
    BUNNY_STREAM_ACCESS_KEY: 'test-key',
    BUNNY_STREAM_LIBRARY_ID: 'test-lib'
  });

  const handler = new BunnyUploadHandler(env);
  const result = await handler.getStreamingUrls(TEST_HASHES.MID, env);

  assert.equal(result, null);
});

test('BunnyUploadHandler: getStreamingUrls returns cached URLs when status is ready', async () => {
  const env = createMockEnv({
    BUNNY_STREAM_ACCESS_KEY: 'test-key',
    BUNNY_STREAM_LIBRARY_ID: 'test-lib'
  });

  const sha256 = TEST_HASHES.MID;
  const blobData = {
    sha256,
    size: 1000,
    type: 'video/mp4',
    bunny: {
      videoId: 'test-video-id',
      guid: 'test-guid',
      status: 'ready',
      hlsUrl: 'https://vz-test.b-cdn.net/test-guid/playlist.m3u8',
      mp4Url: 'https://vz-test.b-cdn.net/test-guid/play_720p.mp4'
    }
  };

  await env.MEDIA_KV.put(`blob:${sha256}`, JSON.stringify(blobData));

  const handler = new BunnyUploadHandler(env);
  const result = await handler.getStreamingUrls(sha256, env);

  assert.notEqual(result, null);
  assert.equal(result.hlsUrl, blobData.bunny.hlsUrl);
  assert.equal(result.mp4Url, blobData.bunny.mp4Url);
  assert.equal(result.status, 'ready');
});

test('BunnyUploadHandler: updateVideoMetadata updates both KV entries', async () => {
  const env = createMockEnv({
    BUNNY_STREAM_ACCESS_KEY: 'test-key',
    BUNNY_STREAM_LIBRARY_ID: 'test-lib'
  });

  const sha256 = TEST_HASHES.MID;
  const videoId = 'test-video-id';

  // Setup initial metadata
  const videoData = {
    sha256,
    videoId,
    guid: 'test-guid',
    status: 'processing',
    hlsUrl: null,
    createdAt: Date.now()
  };

  const blobData = {
    sha256,
    size: 1000,
    type: 'video/mp4',
    bunny: {
      videoId,
      guid: 'test-guid',
      status: 'processing',
      hlsUrl: null
    }
  };

  await env.MEDIA_KV.put(`bunny:video:${videoId}`, JSON.stringify(videoData));
  await env.MEDIA_KV.put(`blob:${sha256}`, JSON.stringify(blobData));

  // Update metadata
  const handler = new BunnyUploadHandler(env);
  const updates = {
    status: 'ready',
    hlsUrl: 'https://vz-test.b-cdn.net/test-guid/playlist.m3u8',
    mp4Url: 'https://vz-test.b-cdn.net/test-guid/play_720p.mp4'
  };

  const success = await handler.updateVideoMetadata(videoId, updates, env);

  assert.equal(success, true);

  // Verify bunny:video:{videoId} was updated
  const updatedVideo = await env.MEDIA_KV.get(`bunny:video:${videoId}`, { type: 'json' });
  assert.equal(updatedVideo.status, 'ready');
  assert.equal(updatedVideo.hlsUrl, updates.hlsUrl);

  // Verify blob:{sha256} was updated
  const updatedBlob = await env.MEDIA_KV.get(`blob:${sha256}`, { type: 'json' });
  assert.equal(updatedBlob.bunny.status, 'ready');
  assert.equal(updatedBlob.bunny.hlsUrl, updates.hlsUrl);
  assert.equal(updatedBlob.bunny.mp4Url, updates.mp4Url);
});

test('BunnyUploadHandler: updateVideoMetadata returns false when video not found', async () => {
  const env = createMockEnv({
    BUNNY_STREAM_ACCESS_KEY: 'test-key',
    BUNNY_STREAM_LIBRARY_ID: 'test-lib'
  });

  const handler = new BunnyUploadHandler(env);
  const success = await handler.updateVideoMetadata('non-existent-id', { status: 'ready' }, env);

  assert.equal(success, false);
});

test('BunnyUploadHandler: updateVideoMetadata handles error gracefully', async () => {
  const env = createMockEnv({
    BUNNY_STREAM_ACCESS_KEY: 'test-key',
    BUNNY_STREAM_LIBRARY_ID: 'test-lib'
  });

  // Break KV to cause error
  env.MEDIA_KV.get = async () => {
    throw new Error('Simulated KV failure');
  };

  const handler = new BunnyUploadHandler(env);
  const success = await handler.updateVideoMetadata('test-id', { status: 'ready' }, env);

  assert.equal(success, false);
});

// ============================================================================
// Hash Distribution Tests
// ============================================================================

test('Hash distribution: 10% rollout routes approximately 10% to bunny', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '10'
  });

  // Generate 100 test hashes
  const hashes = [];
  for (let i = 0; i < 100; i++) {
    const hex = i.toString(16).padStart(8, '0');
    hashes.push(hex + '0'.repeat(56));
  }

  // Count how many route to bunny
  let bunnyCount = 0;
  for (const hash of hashes) {
    const result = selectUploadStrategy(env, hash, {});
    if (result.shouldUseBunny) {
      bunnyCount++;
    }
  }

  // Should be exactly 10 (hashes 00-09 out of 00-99)
  assert.equal(bunnyCount, 10);
});

test('Hash distribution: 75% rollout routes approximately 75% to bunny', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '75'
  });

  // Generate 100 test hashes
  const hashes = [];
  for (let i = 0; i < 100; i++) {
    const hex = i.toString(16).padStart(8, '0');
    hashes.push(hex + '0'.repeat(56));
  }

  // Count how many route to bunny
  let bunnyCount = 0;
  for (const hash of hashes) {
    const result = selectUploadStrategy(env, hash, {});
    if (result.shouldUseBunny) {
      bunnyCount++;
    }
  }

  // Should be exactly 75 (hashes 00-74 out of 00-99)
  assert.equal(bunnyCount, 75);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('selectUploadStrategy: handles missing BUNNY_ROLLOUT_PERCENTAGE', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual'
  });
  delete env.BUNNY_ROLLOUT_PERCENTAGE;

  const result = selectUploadStrategy(env, TEST_HASHES.LOW, {});

  // Should default to 0% rollout
  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

test('selectUploadStrategy: handles invalid BUNNY_ROLLOUT_PERCENTAGE', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: 'invalid'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.LOW, {});

  // parseInt('invalid') returns NaN, which should be treated as 0
  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

test('selectUploadStrategy: handles negative BUNNY_ROLLOUT_PERCENTAGE', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '-10'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.LOW, {});

  // Negative rollout should route everything to r2
  assert.equal(result.provider, 'r2');
  assert.equal(result.shouldUseBunny, false);
});

test('selectUploadStrategy: handles >100 BUNNY_ROLLOUT_PERCENTAGE', () => {
  const env = createMockEnv({
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: '150'
  });

  const result = selectUploadStrategy(env, TEST_HASHES.HIGH, {});

  // >100 rollout should route everything to bunny
  assert.equal(result.provider, 'bunny');
  assert.equal(result.shouldUseBunny, true);
});
