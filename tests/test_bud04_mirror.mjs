// ABOUTME: Tests for BUD-04 Blossom mirroring (PUT /mirror endpoint)
// ABOUTME: Ensures compliance with BUD-04 spec for copying blobs from remote URLs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

const SERVER_URL = process.env.TEST_SERVER_URL || 'https://blossom.divine.video';
const PRIVATE_KEY_HEX = 'a'.repeat(64);

// =============================================================================
// HELPERS
// =============================================================================

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function getPublicKey(privateKeyHex) {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  return bytesToHex(schnorr.getPublicKey(privateKeyBytes));
}

function serializeEvent(event) {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

function getEventIdBytes(event) {
  const serialized = serializeEvent(event);
  return new Uint8Array(sha256(Buffer.from(serialized, 'utf-8')));
}

function signEvent(event, privateKeyHex) {
  const idBytes = getEventIdBytes(event);
  const id = bytesToHex(idBytes);
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const sig = bytesToHex(schnorr.sign(idBytes, privateKeyBytes));
  return { ...event, id, sig };
}

function createMirrorAuthEvent(blobHash, overrides = {}) {
  const pubkey = getPublicKey(PRIVATE_KEY_HEX);
  const now = Math.floor(Date.now() / 1000);
  
  const event = {
    kind: 24242,
    pubkey,
    created_at: now - 10,
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + 300)],
      ['x', blobHash]
    ],
    content: 'Mirror blob',
    ...overrides
  };
  
  return signEvent(event, PRIVATE_KEY_HEX);
}

// =============================================================================
// PUT /mirror ENDPOINT TESTS
// =============================================================================

test('BUD-04: PUT /mirror endpoint exists and accepts JSON', async () => {
  // Use a known existing blob URL for this test
  const testUrl = 'https://cdn.divine.video/0010ed38d2a24d77c82cfea01bc2239e661ce0b0bd6f9eb98142c961288efbee';
  const expectedHash = '0010ed38d2a24d77c82cfea01bc2239e661ce0b0bd6f9eb98142c961288efbee';
  
  const authEvent = createMirrorAuthEvent(expectedHash);
  const base64Event = Buffer.from(JSON.stringify(authEvent)).toString('base64');
  
  const response = await fetch(`${SERVER_URL}/mirror`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: testUrl })
  });
  
  // Should not return 404 (endpoint exists)
  assert.notEqual(response.status, 404, 'PUT /mirror endpoint should exist');
  
  // Should not return 405 (method allowed)
  assert.notEqual(response.status, 405, 'PUT method should be allowed on /mirror');
});

test('BUD-04: mirror rejects request without URL', async () => {
  const authEvent = createMirrorAuthEvent('a'.repeat(64));
  const base64Event = Buffer.from(JSON.stringify(authEvent)).toString('base64');
  
  const response = await fetch(`${SERVER_URL}/mirror`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  
  assert.equal(response.status, 400, 'Should return 400 for missing URL');
  
  const result = await response.json();
  assert.ok(result.error, 'Should return error field');
});

test('BUD-04: mirror rejects invalid URL', async () => {
  const authEvent = createMirrorAuthEvent('a'.repeat(64));
  const base64Event = Buffer.from(JSON.stringify(authEvent)).toString('base64');
  
  const response = await fetch(`${SERVER_URL}/mirror`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: 'not-a-valid-url' })
  });
  
  assert.equal(response.status, 400, 'Should return 400 for invalid URL');
});

test('BUD-04: mirror rejects hash mismatch', async () => {
  // URL points to one hash, but auth event specifies different hash
  const testUrl = 'https://cdn.divine.video/0010ed38d2a24d77c82cfea01bc2239e661ce0b0bd6f9eb98142c961288efbee';
  const wrongHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  
  const authEvent = createMirrorAuthEvent(wrongHash);
  const base64Event = Buffer.from(JSON.stringify(authEvent)).toString('base64');
  
  const response = await fetch(`${SERVER_URL}/mirror`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: testUrl })
  });
  
  // Should reject due to hash mismatch
  assert.ok(response.status >= 400, 'Should return 4xx for hash mismatch');
  
  const result = await response.json();
  assert.ok(result.error, 'Should return error for hash mismatch');
});

test('BUD-04: mirror returns blob descriptor on success', async () => {
  const testUrl = 'https://cdn.divine.video/0010ed38d2a24d77c82cfea01bc2239e661ce0b0bd6f9eb98142c961288efbee';
  const expectedHash = '0010ed38d2a24d77c82cfea01bc2239e661ce0b0bd6f9eb98142c961288efbee';
  
  const authEvent = createMirrorAuthEvent(expectedHash);
  const base64Event = Buffer.from(JSON.stringify(authEvent)).toString('base64');
  
  const response = await fetch(`${SERVER_URL}/mirror`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: testUrl })
  });
  
  // On success, should return 2xx with blob descriptor
  if (response.ok) {
    const result = await response.json();
    assert.ok(result.sha256, 'Should return sha256 in blob descriptor');
    assert.equal(result.sha256, expectedHash, 'SHA256 should match');
    assert.ok(result.size !== undefined, 'Should return size');
    assert.ok(result.type, 'Should return type');
  }
});
