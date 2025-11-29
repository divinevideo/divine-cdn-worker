// ABOUTME: Test script for Cloudflare Media Transformations
// ABOUTME: Uploads a test video and verifies first-frame extraction works

import { schnorr } from '@noble/curves/secp256k1.js';
import crypto from 'crypto';
import fs from 'fs';

const PRIVATE_KEY_HEX = 'a'.repeat(64);
const SERVER_URL = 'https://cdn.divine.video';

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
  const hash = sha256(Buffer.from(serialized, 'utf-8'));
  return new Uint8Array(hash);
}

function signEvent(event, privateKeyHex) {
  const idBytes = getEventIdBytes(event);
  const id = bytesToHex(idBytes);
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const sig = bytesToHex(schnorr.sign(idBytes, privateKeyBytes));
  return { ...event, id, sig };
}

async function main() {
  const pubkey = getPublicKey(PRIVATE_KEY_HEX);
  
  // Read video file (use properly-encoded test video)
  const videoPath = '/tmp/test_video_proper.mp4';
  if (!fs.existsSync(videoPath)) {
    console.error('Test video not found. Create with:');
    console.error('ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=30 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 128k /tmp/test_video_proper.mp4');
    process.exit(1);
  }
  const videoData = fs.readFileSync(videoPath);
  const fileHash = bytesToHex(sha256(videoData));
  
  console.log('=== Uploading test video ===');
  console.log('SHA256:', fileHash);
  console.log('Size:', videoData.length, 'bytes');
  
  // Create auth event
  const now = Math.floor(Date.now() / 1000);
  const event = {
    kind: 24242,
    pubkey: pubkey,
    created_at: now - 10,
    tags: [['t', 'upload'], ['expiration', String(now + 300)], ['x', fileHash]],
    content: 'Upload test video'
  };
  
  const signedEvent = signEvent(event, PRIVATE_KEY_HEX);
  const base64Event = Buffer.from(JSON.stringify(signedEvent)).toString('base64');
  
  const response = await fetch(`${SERVER_URL}/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
      'Content-Type': 'video/mp4'
    },
    body: videoData
  });
  
  console.log('Upload status:', response.status);
  
  if (response.status !== 200) {
    console.log('Upload failed:', await response.text());
    return;
  }
  
  const result = await response.json();
  console.log('✅ Upload success!');
  console.log('URL:', result.url);
  console.log('SHA256:', result.sha256);
  
  // Wait a moment for R2 to propagate
  console.log('\nWaiting 2 seconds for R2 propagation...');
  await new Promise(r => setTimeout(r, 2000));
  
  // Test Media Transformations with different URL formats
  console.log('\n=== Testing Media Transformations ===');
  
  const testUrls = [
    `https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s,width=480/${result.sha256}`,
    `https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s/${result.sha256}`,
    `https://cdn.divine.video/cdn-cgi/media/mode=frame,time=0s,width=480/blobs/${result.sha256}`,
  ];
  
  for (const url of testUrls) {
    console.log('\nTesting:', url.replace(result.sha256, result.sha256.substring(0, 12) + '...'));
    
    const mtResponse = await fetch(url);
    console.log('  Status:', mtResponse.status);
    console.log('  Content-Type:', mtResponse.headers.get('content-type'));
    console.log('  cf-resized:', mtResponse.headers.get('cf-resized'));
    
    if (mtResponse.ok) {
      const data = await mtResponse.arrayBuffer();
      console.log('  ✅ SUCCESS! Image size:', data.byteLength, 'bytes');
    } else {
      console.log('  ❌ Failed');
    }
  }
}

main().catch(console.error);
