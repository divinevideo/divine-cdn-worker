// ABOUTME: Unit tests for Cloudflare Media Transformations thumbnail extractor
// ABOUTME: Tests first-frame extraction, retry logic, and fallback behavior

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstFrame, shouldAttemptMediaTransformation } from '../src/thumbnail-extractor.mjs';

// ============================================================================
// shouldAttemptMediaTransformation Tests
// ============================================================================

test('shouldAttemptMediaTransformation: returns false when disabled', () => {
  const env = { MEDIA_TRANSFORMATIONS_ENABLED: 'false' };
  assert.equal(shouldAttemptMediaTransformation(env, 1000), false);
});

test('shouldAttemptMediaTransformation: returns false when env var missing', () => {
  const env = {};
  assert.equal(shouldAttemptMediaTransformation(env, 1000), false);
});

test('shouldAttemptMediaTransformation: returns false when video exceeds 40MB', () => {
  const env = { MEDIA_TRANSFORMATIONS_ENABLED: 'true' };
  const size = 41 * 1024 * 1024; // 41MB
  assert.equal(shouldAttemptMediaTransformation(env, size), false);
});

test('shouldAttemptMediaTransformation: returns true when enabled and under 40MB', () => {
  const env = { MEDIA_TRANSFORMATIONS_ENABLED: 'true' };
  const size = 10 * 1024 * 1024; // 10MB
  assert.equal(shouldAttemptMediaTransformation(env, size), true);
});

test('shouldAttemptMediaTransformation: returns true at exactly 40MB boundary', () => {
  const env = { MEDIA_TRANSFORMATIONS_ENABLED: 'true' };
  const size = 40 * 1024 * 1024; // exactly 40MB
  assert.equal(shouldAttemptMediaTransformation(env, size), true);
});

// ============================================================================
// extractFirstFrame Tests
// ============================================================================

/**
 * Mock fetch for testing extractFirstFrame
 */
function createMockFetch(responses) {
  let callIndex = 0;
  const calls = [];

  const mockFetch = async (url) => {
    calls.push(url);
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;

    return {
      ok: response.ok,
      status: response.status || (response.ok ? 200 : 400),
      headers: {
        get: (name) => response.headers?.[name] || null
      },
      arrayBuffer: async () => response.data || new ArrayBuffer(100)
    };
  };

  mockFetch.getCalls = () => calls;
  return mockFetch;
}

test('extractFirstFrame: returns success with image data for valid video', async () => {
  const imageData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer; // JPEG magic bytes

  const mockFetch = createMockFetch([{
    ok: true,
    headers: { 'content-type': 'image/jpeg' },
    data: imageData
  }]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video' };
  const result = await extractFirstFrame('abc123', env, mockFetch);

  assert.equal(result.success, true);
  assert.ok(result.data);
  assert.equal(result.contentType, 'image/jpeg');
});

test('extractFirstFrame: constructs correct URL with sha256 and width', async () => {
  const mockFetch = createMockFetch([{
    ok: true,
    headers: { 'content-type': 'image/jpeg' }
  }]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video', THUMBNAIL_WIDTH: '320' };
  await extractFirstFrame('deadbeef123456', env, mockFetch);

  const calls = mockFetch.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0],
    'https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s,width=320/deadbeef123456'
  );
});

test('extractFirstFrame: uses default width of 480 when not specified', async () => {
  const mockFetch = createMockFetch([{
    ok: true,
    headers: { 'content-type': 'image/jpeg' }
  }]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video' };
  await extractFirstFrame('abc123', env, mockFetch);

  const calls = mockFetch.getCalls();
  assert.ok(calls[0].includes('width=480'));
});

test('extractFirstFrame: returns invalid_format error for err=9412', async () => {
  const mockFetch = createMockFetch([{
    ok: false,
    status: 400,
    headers: { 'cf-resized': 'err=9412' }
  }]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video' };
  const result = await extractFirstFrame('abc123', env, mockFetch);

  assert.equal(result.success, false);
  assert.equal(result.error, 'invalid_format');
  assert.equal(result.code, 9412);
  // Should NOT retry for 9412
  assert.equal(mockFetch.getCalls().length, 1);
});

test('extractFirstFrame: returns too_large error for err=9413', async () => {
  const mockFetch = createMockFetch([{
    ok: false,
    status: 400,
    headers: { 'cf-resized': 'err=9413' }
  }]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video' };
  const result = await extractFirstFrame('abc123', env, mockFetch);

  assert.equal(result.success, false);
  assert.equal(result.error, 'too_large');
  assert.equal(result.code, 9413);
  // Should NOT retry for 9413
  assert.equal(mockFetch.getCalls().length, 1);
});

test('extractFirstFrame: retries on 404 (propagation delay) and succeeds', async () => {
  const mockFetch = createMockFetch([
    { ok: false, status: 404, headers: { 'cf-resized': 'err=9404' } },
    { ok: false, status: 404, headers: { 'cf-resized': 'err=9404' } },
    { ok: true, headers: { 'content-type': 'image/jpeg' } }
  ]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video' };
  const result = await extractFirstFrame('abc123', env, mockFetch);

  assert.equal(result.success, true);
  assert.equal(mockFetch.getCalls().length, 3);
});

test('extractFirstFrame: returns max_retries_exceeded after all retries fail', async () => {
  const mockFetch = createMockFetch([
    { ok: false, status: 404, headers: { 'cf-resized': 'err=9404' } },
    { ok: false, status: 404, headers: { 'cf-resized': 'err=9404' } },
    { ok: false, status: 404, headers: { 'cf-resized': 'err=9404' } },
    { ok: false, status: 404, headers: { 'cf-resized': 'err=9404' } }
  ]);

  const env = { STREAM_DOMAIN: 'cdn.divine.video' };
  const result = await extractFirstFrame('abc123', env, mockFetch);

  assert.equal(result.success, false);
  assert.equal(result.error, 'max_retries_exceeded');
  // Initial attempt + 3 retries = 4 calls
  assert.equal(mockFetch.getCalls().length, 4);
});

test('extractFirstFrame: uses default domain when STREAM_DOMAIN not specified', async () => {
  const mockFetch = createMockFetch([{
    ok: true,
    headers: { 'content-type': 'image/jpeg' }
  }]);

  const env = {};
  await extractFirstFrame('abc123', env, mockFetch);

  const calls = mockFetch.getCalls();
  assert.ok(calls[0].includes('cdn.divine.video'));
});
