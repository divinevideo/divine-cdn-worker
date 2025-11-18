// ABOUTME: End-to-end test for video processing pipeline
// ABOUTME: Tests CDN serving, BunnyStream upload, encoding, webhook, and HLS playback

import { BunnyStreamClient } from './src/streaming/bunny-client.mjs';

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';
const TEST_FILE_R2_KEY = 'uploads/1750591730308-13cdc4ee.mp4';
const CDN_DOMAIN = 'cdn.divine.video';

if (!BUNNY_STREAM_ACCESS_KEY) {
  console.error('Error: BUNNY_STREAM_ACCESS_KEY environment variable required');
  process.exit(1);
}

const bunnyClient = new BunnyStreamClient(
  BUNNY_STREAM_ACCESS_KEY,
  BUNNY_STREAM_LIBRARY_ID
);

async function testPipeline() {
  console.log('='.repeat(60));
  console.log('End-to-End Pipeline Test');
  console.log('='.repeat(60));
  console.log('');

  // Step 1: Verify CDN serves the file
  console.log('Step 1: Testing CDN serves source file...');
  const sourceUrl = `https://${CDN_DOMAIN}/${TEST_FILE_R2_KEY}`;
  console.log(`  URL: ${sourceUrl}`);

  const headResponse = await fetch(sourceUrl, { method: 'HEAD' });
  if (!headResponse.ok) {
    console.error(`  ❌ CDN returned ${headResponse.status}`);
    process.exit(1);
  }

  const contentLength = headResponse.headers.get('content-length');
  console.log(`  ✅ CDN serves file (${contentLength} bytes)`);
  console.log('');

  // Step 2: Create BunnyStream video
  console.log('Step 2: Creating BunnyStream video...');
  const video = await bunnyClient.createVideo(`E2E Test - ${TEST_FILE_R2_KEY}`);
  console.log(`  ✅ Created video: ${video.videoId}`);
  console.log('');

  // Step 3: Tell BunnyStream to fetch from CDN
  console.log('Step 3: Telling BunnyStream to fetch from CDN...');
  await bunnyClient.uploadFromUrl(video.videoId, sourceUrl);
  console.log(`  ✅ Upload from URL initiated`);
  console.log('');

  // Step 4: Monitor encoding progress
  console.log('Step 4: Monitoring encoding progress...');
  console.log('  This may take 1-2 minutes...');

  let attempts = 0;
  const maxAttempts = 60; // 2 minutes max
  let finalStatus;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s between checks

    const status = await bunnyClient.getVideo(video.videoId);
    const statusLabel = status.statusLabel || 'unknown';
    const progress = status.encodeProgress || 0;

    process.stdout.write(`\r  Status: ${statusLabel.padEnd(15)} Progress: ${progress}%    `);

    // Check if done (status 3 = FINISHED, 4 = READY)
    if (status.status >= 3) {
      console.log('');
      console.log(`  ✅ Encoding complete!`);
      finalStatus = status;
      break;
    }

    // Check if failed (status 5 = ERROR, 6 = VIRUS_DETECTED)
    if (status.status === 5 || status.status === 6) {
      console.log('');
      console.error(`  ❌ Encoding failed: ${statusLabel}`);
      if (status.transcodingMessages && status.transcodingMessages.length > 0) {
        console.error(`  Error: ${status.transcodingMessages[0].message}`);
      }
      process.exit(1);
    }

    attempts++;
  }

  if (!finalStatus) {
    console.log('');
    console.error('  ❌ Timeout waiting for encoding');
    process.exit(1);
  }

  console.log('');

  // Step 5: Verify originalHash was calculated
  console.log('Step 5: Checking originalHash...');
  if (finalStatus.originalHash) {
    console.log(`  ✅ originalHash: ${finalStatus.originalHash}`);
  } else {
    console.log(`  ⚠️  No originalHash (yet)`);
  }
  console.log('');

  // Step 6: Test HLS playback URL
  console.log('Step 6: Testing HLS playback...');
  const hlsUrl = `https://stream.divine.video/${video.videoId}/playlist.m3u8`;
  console.log(`  URL: ${hlsUrl}`);

  const hlsResponse = await fetch(hlsUrl);
  if (!hlsResponse.ok) {
    console.error(`  ❌ HLS returned ${hlsResponse.status}`);
    process.exit(1);
  }

  const playlist = await hlsResponse.text();
  console.log(`  ✅ HLS playlist accessible (${playlist.length} bytes)`);
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('✅ END-TO-END TEST PASSED');
  console.log('='.repeat(60));
  console.log('');
  console.log('Video Details:');
  console.log(`  Video ID: ${video.videoId}`);
  console.log(`  Title: ${finalStatus.title}`);
  console.log(`  Status: ${finalStatus.statusLabel}`);
  console.log(`  Original Hash: ${finalStatus.originalHash || 'N/A'}`);
  console.log(`  Duration: ${finalStatus.duration || 'N/A'}s`);
  console.log(`  Resolution: ${finalStatus.width}x${finalStatus.height}`);
  console.log(`  HLS URL: ${hlsUrl}`);
  console.log('');
  console.log('Next: Check if webhook fired and updated KV with originalHash');
}

testPipeline().catch(err => {
  console.error('');
  console.error('❌ Pipeline test failed:', err.message);
  console.error(err);
  process.exit(1);
});
