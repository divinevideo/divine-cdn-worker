// ABOUTME: Live integration test for BUD-01 compliant uploads
// ABOUTME: Tests real signed event uploads against production server

import { schnorr } from '@noble/curves/secp256k1.js';
import crypto from 'crypto';

// Test private key (DO NOT USE IN PRODUCTION) - hex string
const PRIVATE_KEY_HEX = 'a'.repeat(64);

// Helper to convert bytes to hex
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper to convert hex to bytes
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// SHA-256 hash helper
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}
const SERVER_URL = process.env.BLOSSOM_SERVER || 'https://blossom-sdk-worker.protestnet.workers.dev';

function getPublicKey(privateKeyHex) {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  return bytesToHex(schnorr.getPublicKey(privateKeyBytes));
}

function serializeEvent(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
}

function getEventIdBytes(event) {
  const serialized = serializeEvent(event);
  const hash = sha256(Buffer.from(serialized, 'utf-8'));
  return new Uint8Array(hash);  // Convert Buffer to Uint8Array
}

function getEventId(event) {
  return bytesToHex(getEventIdBytes(event));
}

function signEvent(event, privateKeyHex) {
  const idBytes = getEventIdBytes(event);
  const id = bytesToHex(idBytes);
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const sig = bytesToHex(schnorr.sign(idBytes, privateKeyBytes));
  return { ...event, id, sig };
}

function createAuthEvent(pubkey, action, tags = []) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: 24242,
    pubkey: pubkey,
    created_at: now - 10,  // 10 seconds ago
    tags: [
      ['t', action],
      ['expiration', String(now + 300)],  // 5 minutes from now
      ...tags
    ],
    content: `Blossom ${action}`
  };
}

async function testUpload() {
  const pubkey = getPublicKey(PRIVATE_KEY_HEX);
  console.log('=== BUD-01 Live Upload Test ===');
  console.log('Server:', SERVER_URL);
  console.log('Public key:', pubkey.substring(0, 16) + '...');

  // Test data
  const testData = 'Hello Blossom! Timestamp: ' + Date.now();
  const testBytes = new TextEncoder().encode(testData);
  const fileHash = bytesToHex(sha256(testBytes));
  console.log('File hash:', fileHash.substring(0, 16) + '...');
  console.log('File size:', testBytes.length, 'bytes');

  // Create and sign BUD-01 event
  const event = createAuthEvent(pubkey, 'upload', [['x', fileHash]]);
  const signedEvent = signEvent(event, PRIVATE_KEY_HEX);
  console.log('Event ID:', signedEvent.id.substring(0, 16) + '...');

  // Base64 encode for Authorization header
  const eventJson = JSON.stringify(signedEvent);
  const base64Event = Buffer.from(eventJson).toString('base64');

  // Upload
  console.log('\n--- Uploading ---');
  const response = await fetch(`${SERVER_URL}/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'text/plain'
    },
    body: testData
  });

  console.log('Status:', response.status);

  if (response.status !== 200) {
    console.log('X-Reason:', response.headers.get('x-reason'));
    console.log('WWW-Authenticate:', response.headers.get('www-authenticate'));
    const body = await response.text();
    console.log('Body:', body);
    throw new Error(`Upload failed with status ${response.status}`);
  }

  const json = await response.json();
  console.log('\n✅ UPLOAD SUCCESS!');
  console.log('URL:', json.url);
  console.log('SHA256:', json.sha256);
  console.log('Size:', json.size);
  console.log('Type:', json.type);

  // Verify by fetching back from worker (CDN URL may differ)
  console.log('\n--- Verifying Download ---');
  const workerUrl = `${SERVER_URL}/${json.sha256}`;
  const getResponse = await fetch(workerUrl);
  console.log('GET Status:', getResponse.status);

  if (getResponse.status === 200) {
    const content = await getResponse.text();
    const matches = content === testData;
    console.log('Content matches:', matches ? '✅ YES' : '❌ NO');
    if (!matches) {
      console.log('Expected:', testData);
      console.log('Got:', content);
    }
  } else {
    console.log('❌ Download failed');
  }

  return json;
}

async function testExpiredEvent() {
  const pubkey = getPublicKey(PRIVATE_KEY_HEX);
  console.log('\n=== Test Expired Event (should fail) ===');

  const testData = 'test';
  const testBytes = new TextEncoder().encode(testData);
  const fileHash = bytesToHex(sha256(testBytes));

  const now = Math.floor(Date.now() / 1000);
  const event = {
    kind: 24242,
    pubkey: pubkey,
    created_at: now - 600,  // 10 minutes ago
    tags: [
      ['t', 'upload'],
      ['expiration', String(now - 60)],  // Expired 1 minute ago
      ['x', fileHash]
    ],
    content: 'Expired test'
  };

  const signedEvent = signEvent(event, PRIVATE_KEY_HEX);
  const base64Event = Buffer.from(JSON.stringify(signedEvent)).toString('base64');

  const response = await fetch(`${SERVER_URL}/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'text/plain'
    },
    body: testData
  });

  console.log('Status:', response.status);
  console.log('X-Reason:', response.headers.get('x-reason'));

  if (response.status === 401) {
    console.log('✅ Correctly rejected expired event');
  } else {
    console.log('❌ Should have rejected expired event');
  }
}

async function testWrongAction() {
  const pubkey = getPublicKey(PRIVATE_KEY_HEX);
  console.log('\n=== Test Wrong Action Tag (should fail) ===');

  const testData = 'test';
  const testBytes = new TextEncoder().encode(testData);
  const fileHash = bytesToHex(sha256(testBytes));

  // Use 'delete' action for upload endpoint
  const event = createAuthEvent(pubkey, 'delete', [['x', fileHash]]);
  const signedEvent = signEvent(event, PRIVATE_KEY_HEX);
  const base64Event = Buffer.from(JSON.stringify(signedEvent)).toString('base64');

  const response = await fetch(`${SERVER_URL}/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'text/plain'
    },
    body: testData
  });

  console.log('Status:', response.status);
  console.log('X-Reason:', response.headers.get('x-reason'));

  // BUD-01 validation rejects wrong action, returning generic 401
  // (specific reason logged server-side but not exposed to client)
  if (response.status === 401) {
    console.log('✅ Correctly rejected wrong action');
  } else {
    console.log('❌ Should have rejected wrong action');
  }
}

async function main() {
  try {
    await testUpload();
    await testExpiredEvent();
    await testWrongAction();
    console.log('\n=== All tests completed ===');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();
