import { schnorr } from '@noble/curves/secp256k1.js';
import crypto from 'crypto';
import fs from 'fs';

const PRIVATE_KEY_HEX = 'a'.repeat(64);
const SERVER_URL = 'https://blossom.divine.video';

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
  return bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
}

function signEvent(event, privateKeyHex) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const idBytes = new Uint8Array(sha256(Buffer.from(serialized, 'utf-8')));
  const id = bytesToHex(idBytes);
  const sig = bytesToHex(schnorr.sign(idBytes, hexToBytes(privateKeyHex)));
  return { ...event, id, sig };
}

async function uploadVideo(filePath) {
  const pubkey = getPublicKey(PRIVATE_KEY_HEX);
  const videoData = fs.readFileSync(filePath);
  const fileHash = bytesToHex(sha256(videoData));

  console.log('=== Upload Test ===');
  console.log('File:', filePath);
  console.log('Hash:', fileHash);
  console.log('Size:', videoData.length, 'bytes');

  const now = Math.floor(Date.now() / 1000);
  const event = {
    kind: 24242,
    pubkey,
    created_at: now - 10,
    tags: [['t', 'upload'], ['expiration', String(now + 300)], ['x', fileHash]],
    content: 'Test upload'
  };
  const signedEvent = signEvent(event, PRIVATE_KEY_HEX);
  const base64Event = Buffer.from(JSON.stringify(signedEvent)).toString('base64');

  console.log('\nUploading...');
  const response = await fetch(`${SERVER_URL}/upload`, {
    method: 'PUT',
    headers: { 'Authorization': `Nostr ${base64Event}`, 'Content-Type': 'video/mp4' },
    body: videoData
  });

  console.log('Status:', response.status);
  const body = await response.text();
  try {
    console.log('Response:', JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log('Response:', body);
  }
}

uploadVideo('/tmp/eight_sec.mp4');
