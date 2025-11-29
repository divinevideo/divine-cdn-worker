// ABOUTME: Tests for NIP-96 compatible query parameter routing to Media Transformations
// ABOUTME: Verifies ?w=, ?thumb, ?audio params route to correct cdn-cgi/media endpoints

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaTransformUrl, getMediaTransformVariants } from '../src/streaming/playback-resolver.mjs';

const TEST_SHA256 = 'a'.repeat(64);
const TEST_DOMAIN = 'cdn.divine.video';

// ============================================================================
// buildMediaTransformUrl Tests
// ============================================================================

test('buildMediaTransformUrl: ?w=1280 returns 720p video URL', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { w: '1280' });

  assert.strictEqual(
    result,
    `https://${TEST_DOMAIN}/cdn-cgi/media/mode=video,width=1280/${TEST_SHA256}`
  );
});

test('buildMediaTransformUrl: ?w=854 returns 480p video URL', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { w: '854' });

  assert.strictEqual(
    result,
    `https://${TEST_DOMAIN}/cdn-cgi/media/mode=video,width=854/${TEST_SHA256}`
  );
});

test('buildMediaTransformUrl: ?w=640 returns 360p video URL', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { w: '640' });

  assert.strictEqual(
    result,
    `https://${TEST_DOMAIN}/cdn-cgi/media/mode=video,width=640/${TEST_SHA256}`
  );
});

test('buildMediaTransformUrl: ?thumb returns first-frame thumbnail URL', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { thumb: '' });

  assert.strictEqual(
    result,
    `https://${TEST_DOMAIN}/cdn-cgi/media/mode=frame,time=0s,width=480/${TEST_SHA256}`
  );
});

test('buildMediaTransformUrl: ?audio returns audio extraction URL', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { audio: '' });

  assert.strictEqual(
    result,
    `https://${TEST_DOMAIN}/cdn-cgi/media/mode=audio/${TEST_SHA256}`
  );
});

test('buildMediaTransformUrl: no params returns null (serve original)', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, {});

  assert.strictEqual(result, null);
});

test('buildMediaTransformUrl: unknown params returns null (serve original)', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { foo: 'bar' });

  assert.strictEqual(result, null);
});

test('buildMediaTransformUrl: invalid width returns null', () => {
  const result = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { w: 'notanumber' });

  assert.strictEqual(result, null);
});

test('buildMediaTransformUrl: width out of range returns null', () => {
  // CF Media Transformations supports 10-2000px
  const tooSmall = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { w: '5' });
  const tooBig = buildMediaTransformUrl(TEST_SHA256, TEST_DOMAIN, { w: '3000' });

  assert.strictEqual(tooSmall, null);
  assert.strictEqual(tooBig, null);
});

// ============================================================================
// getMediaTransformVariants Tests (clean URL format)
// ============================================================================

test('getMediaTransformVariants: returns NIP-96 compatible URLs', () => {
  const variants = getMediaTransformVariants(TEST_SHA256, TEST_DOMAIN);

  // Should use clean query param format, not cdn-cgi paths
  assert.strictEqual(variants.original, `https://${TEST_DOMAIN}/${TEST_SHA256}`);
  assert.strictEqual(variants.hd, `https://${TEST_DOMAIN}/${TEST_SHA256}?w=1280`);
  assert.strictEqual(variants.sd, `https://${TEST_DOMAIN}/${TEST_SHA256}?w=854`);
  assert.strictEqual(variants.mobile, `https://${TEST_DOMAIN}/${TEST_SHA256}?w=640`);
  assert.strictEqual(variants.thumbnail, `https://${TEST_DOMAIN}/${TEST_SHA256}?thumb`);
  assert.strictEqual(variants.audio, `https://${TEST_DOMAIN}/${TEST_SHA256}?audio`);
});
