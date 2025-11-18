// ABOUTME: Quick check if BunnyStream API is responding
// ABOUTME: Run this periodically to see when the API is back online

import { BunnyStreamClient } from './src/streaming/bunny-client.mjs';

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';

if (!BUNNY_STREAM_ACCESS_KEY) {
  console.error('❌ BUNNY_STREAM_ACCESS_KEY environment variable required');
  process.exit(1);
}

const client = new BunnyStreamClient(BUNNY_STREAM_ACCESS_KEY, BUNNY_STREAM_LIBRARY_ID);

console.log('Checking BunnyStream API status...');
const start = Date.now();

try {
  const result = await client.listVideos(1, 5);
  const elapsed = Date.now() - start;
  console.log(`✅ API IS BACK UP! (${elapsed}ms)`);
  console.log(`   Got ${result.items.length} videos`);
  process.exit(0);
} catch (error) {
  const elapsed = Date.now() - start;
  console.log(`❌ API still down (${elapsed}ms): ${error.message}`);
  process.exit(1);
}
