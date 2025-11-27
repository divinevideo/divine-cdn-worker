// ABOUTME: Tests for BUD-01 Blossom auth validation (expiration, action tags, etc.)
// ABOUTME: Ensures compliance with Blossom spec beyond just signature verification

import test from 'node:test';
import assert from 'node:assert/strict';

// Import the validator we'll create
import { validateBud01Event } from '../src/bud01-validator.mjs';

const TEST_PUBKEY = 'b'.repeat(64);

// Helper to create a valid base event
function createBaseEvent(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: 24242,
    pubkey: TEST_PUBKEY,
    created_at: now - 60, // 1 minute ago
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + 300)] // 5 minutes from now
    ],
    content: 'Upload request',
    id: 'a'.repeat(64),
    sig: 'c'.repeat(128),
    ...overrides
  };
}

// =============================================================================
// EXPIRATION TAG VALIDATION
// =============================================================================

test('BUD-01: rejects event without expiration tag', async () => {
  const event = createBaseEvent();
  event.tags = event.tags.filter(t => t[0] !== 'expiration');

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'missing_expiration');
  assert.match(result.message, /expiration/i);
});

test('BUD-01: rejects expired event', async () => {
  const now = Math.floor(Date.now() / 1000);
  const event = createBaseEvent();
  event.tags = [
    ['t', 'upload'],
    ['expiration', String(now - 60)] // Expired 1 minute ago
  ];

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'expired');
  assert.match(result.message, /expired/i);
});

test('BUD-01: accepts event with valid future expiration', async () => {
  const event = createBaseEvent();

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, true);
});

test('BUD-01: rejects event with invalid expiration format', async () => {
  const event = createBaseEvent();
  event.tags = [
    ['t', 'upload'],
    ['expiration', 'not-a-number']
  ];

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'invalid_expiration');
});

// =============================================================================
// CREATED_AT VALIDATION
// =============================================================================

test('BUD-01: rejects event with future created_at', async () => {
  const now = Math.floor(Date.now() / 1000);
  const event = createBaseEvent({
    created_at: now + 3600 // 1 hour in future
  });

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'future_created_at');
  assert.match(result.message, /future/i);
});

test('BUD-01: accepts event with past created_at', async () => {
  const now = Math.floor(Date.now() / 1000);
  const event = createBaseEvent({
    created_at: now - 60 // 1 minute ago
  });

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, true);
});

test('BUD-01: allows small clock skew (within 60 seconds)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const event = createBaseEvent({
    created_at: now + 30 // 30 seconds in future (clock skew tolerance)
  });

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, true);
});

// =============================================================================
// ACTION TAG (t) VALIDATION
// =============================================================================

test('BUD-01: rejects event without action tag', async () => {
  const event = createBaseEvent();
  event.tags = event.tags.filter(t => t[0] !== 't');

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'missing_action');
});

test('BUD-01: rejects event with wrong action tag', async () => {
  const event = createBaseEvent();
  event.tags = event.tags.map(t => t[0] === 't' ? ['t', 'get'] : t);

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'action_mismatch');
  assert.match(result.message, /upload.*get/i);
});

test('BUD-01: accepts event with matching action tag', async () => {
  const event = createBaseEvent();

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, true);
});

test('BUD-01: validates delete action correctly', async () => {
  const event = createBaseEvent();
  event.tags = event.tags.map(t => t[0] === 't' ? ['t', 'delete'] : t);

  const result = validateBud01Event(event, { action: 'delete' });

  assert.equal(result.valid, true);
});

test('BUD-01: validates list action correctly', async () => {
  const event = createBaseEvent();
  event.tags = event.tags.map(t => t[0] === 't' ? ['t', 'list'] : t);

  const result = validateBud01Event(event, { action: 'list' });

  assert.equal(result.valid, true);
});

test('BUD-01: validates get action correctly', async () => {
  const event = createBaseEvent();
  event.tags = event.tags.map(t => t[0] === 't' ? ['t', 'get'] : t);

  const result = validateBud01Event(event, { action: 'get' });

  assert.equal(result.valid, true);
});

// =============================================================================
// SERVER TAG VALIDATION (OPTIONAL)
// =============================================================================

test('BUD-01: accepts event without server tag', async () => {
  const event = createBaseEvent();
  // No server tag - should be accepted

  const result = validateBud01Event(event, {
    action: 'upload',
    serverHost: 'blossom.divine.video'
  });

  assert.equal(result.valid, true);
});

test('BUD-01: accepts event with matching server tag', async () => {
  const event = createBaseEvent();
  event.tags.push(['server', 'https://blossom.divine.video']);

  const result = validateBud01Event(event, {
    action: 'upload',
    serverHost: 'blossom.divine.video'
  });

  assert.equal(result.valid, true);
});

test('BUD-01: rejects event with wrong server tag', async () => {
  const event = createBaseEvent();
  event.tags.push(['server', 'https://other-server.com']);

  const result = validateBud01Event(event, {
    action: 'upload',
    serverHost: 'blossom.divine.video'
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'server_mismatch');
});

// =============================================================================
// KIND VALIDATION
// =============================================================================

test('BUD-01: rejects event with wrong kind', async () => {
  const event = createBaseEvent({
    kind: 27235 // NIP-98 kind instead of Blossom 24242
  });

  const result = validateBud01Event(event, { action: 'upload' });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'invalid_kind');
  assert.match(result.message, /24242/);
});
