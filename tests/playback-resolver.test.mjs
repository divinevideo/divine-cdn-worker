// ABOUTME: Comprehensive unit tests for PlaybackResolver
// ABOUTME: Tests URL resolution, fallback logic, and Accept header parsing

import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackResolver, Provider, PlaybackStatus } from '../src/streaming/playback-resolver.mjs';
import { VideoStatus, VideoStatusLabel } from '../src/streaming/bunny-client.mjs';

// Mock environment
function createMockEnv(options = {}) {
  const kvStore = new Map();

  return {
    MEDIA_KV: {
      async get(key) {
        return kvStore.get(key) || null;
      },
      async put(key, value) {
        kvStore.set(key, value);
      },
      async delete(key) {
        kvStore.delete(key);
      }
    },
    STREAM_DOMAIN: 'cdn.divine.video',
    BUNNY_STREAM_PULL_ZONE: 'vz-test123.b-cdn.net',
    // Default to Bunny enabled for legacy tests; set to 'false' for MT tests
    BUNNY_STREAM_ENABLED: options.bunnyEnabled === false ? 'false' : 'true',
    ...options
  };
}

const TEST_SHA256 = 'a'.repeat(64);
const TEST_GUID = 'test-guid-123';

// Helper to create blob metadata
function createBlobMetadata(options = {}) {
  const base = {
    sha256: TEST_SHA256,
    size: 12345,
    type: 'video/mp4',
    uploaded: 1700000000
  };

  if (options.bunny) {
    base.bunny = options.bunny;
  }

  return base;
}

// Tests for resolveUrl()
test('resolveUrl: returns null for non-existent video', async () => {
  const env = createMockEnv();
  const resolver = new PlaybackResolver();

  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);
  assert.strictEqual(result, null);
});

test('resolveUrl: throws error for invalid format', async () => {
  const env = createMockEnv();
  const resolver = new PlaybackResolver();

  await assert.rejects(
    async () => await resolver.resolveUrl(TEST_SHA256, 'invalid', env),
    /Invalid format/
  );
});

test('resolveUrl: returns R2 MP4 for video without Bunny metadata', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.url, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
  assert.strictEqual(result.provider, Provider.R2_MP4);
  assert.strictEqual(result.status, PlaybackStatus.READY);
});

test('resolveUrl: returns Bunny HLS when available and ready (auto format)', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`,
      encodedAt: 1700001000
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.url, `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`);
  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
  assert.strictEqual(result.status, PlaybackStatus.READY);
  assert.ok(result.alternates.mp4);
});

test('resolveUrl: falls back to Bunny MP4 when HLS not ready (auto format)', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.PROCESSING],
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.url, `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`);
  assert.strictEqual(result.provider, Provider.BUNNY_MP4);
  assert.strictEqual(result.status, PlaybackStatus.PROCESSING);
  assert.strictEqual(result.alternates.hls, 'pending');
});

test('resolveUrl: falls back to R2 MP4 when Bunny is processing (auto format)', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.PROCESSING]
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.url, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
  assert.strictEqual(result.provider, Provider.R2_MP4);
  assert.strictEqual(result.status, PlaybackStatus.PROCESSING);
  assert.strictEqual(result.alternates.hls, 'pending');
});

test('resolveUrl: HLS format returns HLS only when ready', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'hls', env);

  assert.strictEqual(result.url, `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`);
  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
  assert.strictEqual(result.status, PlaybackStatus.READY);
  assert.ok(result.alternates.mp4);
});

test('resolveUrl: HLS format returns processing status when not ready', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.ENCODING]
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'hls', env);

  assert.strictEqual(result.url, null);
  assert.strictEqual(result.provider, null);
  assert.strictEqual(result.status, PlaybackStatus.PROCESSING);
  assert.strictEqual(result.alternates.mp4, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
});

test('resolveUrl: HLS format returns unavailable when Bunny not configured', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'hls', env);

  assert.strictEqual(result.url, null);
  assert.strictEqual(result.provider, null);
  assert.strictEqual(result.status, PlaybackStatus.UNAVAILABLE);
  assert.strictEqual(result.alternates.mp4, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
});

test('resolveUrl: MP4 format prefers Bunny MP4 over R2', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'mp4', env);

  assert.strictEqual(result.url, `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`);
  assert.strictEqual(result.provider, Provider.BUNNY_MP4);
  assert.strictEqual(result.status, PlaybackStatus.READY);
  assert.strictEqual(result.alternates.hls, `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`);
});

test('resolveUrl: MP4 format falls back to R2 when Bunny unavailable', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'mp4', env);

  assert.strictEqual(result.url, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
  assert.strictEqual(result.provider, Provider.R2_MP4);
  assert.strictEqual(result.status, PlaybackStatus.READY);
});

test('resolveUrl: handles video in queued state', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.QUEUED]
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.url, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
  assert.strictEqual(result.provider, Provider.R2_MP4);
  assert.strictEqual(result.status, PlaybackStatus.PROCESSING);
});

test('resolveUrl: handles video in error state', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.ERROR],
      error: 'Encoding failed'
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  // Should fall back to R2
  assert.strictEqual(result.url, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
  assert.strictEqual(result.provider, Provider.R2_MP4);
  assert.strictEqual(result.status, PlaybackStatus.READY);
});

// Tests for getPreferredFormat()
test('getPreferredFormat: returns HLS for application/vnd.apple.mpegurl', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.getPreferredFormat(TEST_SHA256, 'application/vnd.apple.mpegurl', env);

  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
});

test('getPreferredFormat: returns HLS for application/x-mpegurl', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.getPreferredFormat(TEST_SHA256, 'application/x-mpegurl', env);

  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
});

test('getPreferredFormat: returns MP4 for video/mp4', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.getPreferredFormat(TEST_SHA256, 'video/mp4', env);

  assert.strictEqual(result.provider, Provider.BUNNY_MP4);
});

test('getPreferredFormat: returns auto for */*', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.getPreferredFormat(TEST_SHA256, '*/*', env);

  // Should prefer HLS in auto mode
  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
});

test('getPreferredFormat: returns auto when Accept header is null', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.getPreferredFormat(TEST_SHA256, null, env);

  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
});

test('getPreferredFormat: handles case-insensitive Accept header', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.getPreferredFormat(TEST_SHA256, 'APPLICATION/VND.APPLE.MPEGURL', env);

  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
});

// Tests for getFallbackChain()
test('getFallbackChain: returns empty array for non-existent video', async () => {
  const env = createMockEnv();
  const resolver = new PlaybackResolver();

  const chain = await resolver.getFallbackChain(TEST_SHA256, env);
  assert.deepStrictEqual(chain, []);
});

test('getFallbackChain: returns only R2 for video without Bunny', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const chain = await resolver.getFallbackChain(TEST_SHA256, env);

  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].provider, Provider.R2_MP4);
  assert.strictEqual(chain[0].status, PlaybackStatus.READY);
});

test('getFallbackChain: returns all three options when Bunny fully ready', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const chain = await resolver.getFallbackChain(TEST_SHA256, env);

  assert.strictEqual(chain.length, 3);
  assert.strictEqual(chain[0].provider, Provider.BUNNY_HLS);
  assert.strictEqual(chain[0].status, PlaybackStatus.READY);
  assert.strictEqual(chain[1].provider, Provider.BUNNY_MP4);
  assert.strictEqual(chain[1].status, PlaybackStatus.READY);
  assert.strictEqual(chain[2].provider, Provider.R2_MP4);
  assert.strictEqual(chain[2].status, PlaybackStatus.READY);
});

test('getFallbackChain: marks Bunny URLs as processing when not ready', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.ENCODING],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const chain = await resolver.getFallbackChain(TEST_SHA256, env);

  assert.strictEqual(chain.length, 3);
  assert.strictEqual(chain[0].status, PlaybackStatus.PROCESSING);
  assert.strictEqual(chain[1].status, PlaybackStatus.PROCESSING);
  assert.strictEqual(chain[2].status, PlaybackStatus.READY);
});

test('getFallbackChain: respects priority order', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const chain = await resolver.getFallbackChain(TEST_SHA256, env);

  // Verify order: HLS -> MP4 (Bunny) -> MP4 (R2)
  assert.ok(chain[0].url.includes('playlist.m3u8'));
  assert.ok(chain[1].url.includes('vz-test123.b-cdn.net'));
  assert.ok(chain[1].url.includes('video.mp4'));
  assert.ok(chain[2].url.includes('cdn.divine.video'));
});

// Tests for getBestUrl()
test('getBestUrl: returns null for non-existent video', async () => {
  const env = createMockEnv();
  const resolver = new PlaybackResolver();

  const best = await resolver.getBestUrl(TEST_SHA256, env);
  assert.strictEqual(best, null);
});

test('getBestUrl: returns R2 when Bunny not configured', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const best = await resolver.getBestUrl(TEST_SHA256, env);

  assert.strictEqual(best.provider, Provider.R2_MP4);
  assert.strictEqual(best.status, PlaybackStatus.READY);
});

test('getBestUrl: returns Bunny HLS when ready', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const best = await resolver.getBestUrl(TEST_SHA256, env);

  assert.strictEqual(best.provider, Provider.BUNNY_HLS);
  assert.strictEqual(best.status, PlaybackStatus.READY);
});

test('getBestUrl: skips processing Bunny URLs and returns R2', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.ENCODING],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const best = await resolver.getBestUrl(TEST_SHA256, env);

  // Should skip processing Bunny HLS and return ready R2 MP4
  assert.strictEqual(best.provider, Provider.R2_MP4);
  assert.strictEqual(best.status, PlaybackStatus.READY);
});

test('getBestUrl: always returns status=ready', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`,
      mp4Url: `https://vz-test123.b-cdn.net/${TEST_GUID}/video.mp4`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const best = await resolver.getBestUrl(TEST_SHA256, env);

  assert.strictEqual(best.status, PlaybackStatus.READY);
});

// Edge cases
test('resolveUrl: handles Bunny metadata with only HLS URL', async () => {
  const env = createMockEnv();
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      guid: TEST_GUID,
      libraryId: '12345',
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
      // No mp4Url
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
  assert.strictEqual(result.alternates.mp4, `https://cdn.divine.video/${TEST_SHA256}.mp4`);
});

test('resolveUrl: uses custom STREAM_DOMAIN from env', async () => {
  const env = createMockEnv();
  env.STREAM_DOMAIN = 'custom.cdn.example.com';
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'mp4', env);

  assert.strictEqual(result.url, `https://custom.cdn.example.com/${TEST_SHA256}.mp4`);
});

// ============================================================================
// Media Transformations Tests (when BUNNY_STREAM_ENABLED is false)
// ============================================================================

test('resolveUrl: returns Media Transformations URLs when Bunny disabled', async () => {
  const env = createMockEnv({ bunnyEnabled: false });
  const blob = createBlobMetadata();
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  assert.strictEqual(result.provider, Provider.MEDIA_TRANSFORMS);
  assert.strictEqual(result.status, PlaybackStatus.READY);
  assert.strictEqual(result.url, `https://cdn.divine.video/${TEST_SHA256}`);
  assert.ok(result.variants);
  assert.strictEqual(result.variants.original, `https://cdn.divine.video/${TEST_SHA256}`);
  assert.ok(result.variants.hd.includes('cdn-cgi/media'));
  assert.ok(result.variants.thumbnail.includes('mode=frame'));
});

test('resolveUrl: uses Bunny for legacy videos even when Bunny disabled', async () => {
  const env = createMockEnv({ bunnyEnabled: false });
  const blob = createBlobMetadata({
    bunny: {
      videoId: TEST_GUID,
      status: VideoStatusLabel[VideoStatus.FINISHED],
      hlsUrl: `https://vz-test123.b-cdn.net/${TEST_GUID}/playlist.m3u8`
    }
  });
  await env.MEDIA_KV.put(`blob:${TEST_SHA256}`, JSON.stringify(blob));

  const resolver = new PlaybackResolver();
  const result = await resolver.resolveUrl(TEST_SHA256, 'auto', env);

  // Should still use Bunny HLS for legacy videos with bunny metadata
  assert.strictEqual(result.provider, Provider.BUNNY_HLS);
  assert.strictEqual(result.status, PlaybackStatus.READY);
});
