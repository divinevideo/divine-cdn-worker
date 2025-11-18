#!/usr/bin/env node
// Test D1 webhook logging with real video upload

import { webcrypto } from 'crypto';
import { readFileSync } from 'fs';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const UPLOAD_URL = 'https://blossom.divine.video/upload';

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function sha256(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(hash));
}

async function generateKeypair() {
  // Dynamic import like the worker does
  const { schnorr } = await import('@noble/curves/secp256k1.js');

  const privkey = crypto.getRandomValues(new Uint8Array(32));
  const pubkey = schnorr.getPublicKey(privkey);

  return {
    privkey: bytesToHex(privkey),
    pubkey: bytesToHex(pubkey)
  };
}

async function createAuthEvent(pubkey, privkey, sha256Hash, expiration) {
  const event = {
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],
      ['x', sha256Hash],
      ['expiration', expiration.toString()]
    ],
    content: 'Upload to Blossom',
    pubkey
  };

  // Create event ID (NIP-01 serialization)
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);

  event.id = await sha256(serialized);

  // Sign with schnorr
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const sig = schnorr.sign(hexToBytes(event.id), hexToBytes(privkey));
  event.sig = bytesToHex(sig);

  return event;
}

async function testUpload(videoPath) {
  console.log('🧪 Testing D1 webhook logging with real video\n');

  // Read video file
  const videoBuffer = readFileSync(videoPath);
  const videoSha256 = await sha256(videoBuffer);

  console.log(`📹 Video: ${videoPath}`);
  console.log(`   Size: ${videoBuffer.length} bytes (${(videoBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`   SHA-256: ${videoSha256}\n`);

  // Generate keypair
  const { privkey, pubkey } = await generateKeypair();
  console.log(`🔑 Generated Nostr keypair`);
  console.log(`   Pubkey: ${pubkey.substring(0, 16)}...\n`);

  // Create auth event
  const expiration = Math.floor(Date.now() / 1000) + 300; // 5 min
  const authEvent = await createAuthEvent(pubkey, privkey, videoSha256, expiration);

  console.log(`✍️  Created kind 24242 auth event with REAL signature`);
  console.log(`   Event ID: ${authEvent.id.substring(0, 16)}...`);
  console.log(`   Signature: ${authEvent.sig.substring(0, 16)}...\n`);

  // Encode auth header
  const authHeader = 'Nostr ' + Buffer.from(JSON.stringify(authEvent)).toString('base64');

  try {
    console.log('📤 Uploading to production...');
    const response = await fetch(UPLOAD_URL, {
      method: 'PUT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'video/mp4'
      },
      body: videoBuffer
    });

    const result = await response.json();

    if (response.ok) {
      console.log('✅ Upload successful!');
      console.log(`   URL: ${result.url}`);
      console.log(`   SHA-256: ${result.sha256}`);
      console.log(`   Video GUID: ${result.bunny?.videoGuid || 'N/A'}\n`);

      console.log('⏳ Waiting 30 seconds for Bunny encoding and webhooks...');
      await new Promise(resolve => setTimeout(resolve, 30000));

      console.log('\n✅ Check D1 database for webhook events:');
      console.log(`   Go to: https://dash.cloudflare.com → Workers & Pages → D1 → blossom-webhook-events`);
      console.log(`   Run query:\n`);
      console.log(`   SELECT video_guid, status_name, timestamp, hls_url`);
      console.log(`   FROM bunny_webhook_events`);
      console.log(`   WHERE sha256 = '${videoSha256}'`);
      console.log(`   ORDER BY received_at DESC;\n`);

    } else {
      console.error('❌ Upload failed:', response.status, result);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

const videoPath = process.argv[2] || 'test_.mp4';
testUpload(videoPath);
