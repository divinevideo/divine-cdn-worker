// ABOUTME: Fast parallel retry script for failed BunnyStream uploads
// ABOUTME: Processes multiple videos concurrently to maximize throughput

import { BunnyStreamClient, VideoStatus } from './src/streaming/bunny-client.mjs';

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';
const CDN_DOMAIN = process.env.CDN_DOMAIN || 'cdn.divine.video';
const R2_LIST_ENDPOINT = process.env.R2_LIST_ENDPOINT || 'https://blossom.divine.video/_list_r2';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10'); // Process 10 videos at once

if (!BUNNY_STREAM_ACCESS_KEY) {
  console.error('Error: BUNNY_STREAM_ACCESS_KEY environment variable required');
  process.exit(1);
}

const bunnyClient = new BunnyStreamClient(
  BUNNY_STREAM_ACCESS_KEY,
  BUNNY_STREAM_LIBRARY_ID
);

/**
 * Find full R2 key for a partial ID from BunnyStream title
 */
async function findR2File(partialId) {
  const response = await fetch(`${R2_LIST_ENDPOINT}?prefix=uploads/${partialId}&limit=1`);
  const data = await response.json();

  if (data.objects && data.objects.length > 0) {
    return data.objects[0].key;
  }

  return null;
}

/**
 * Process a single VIRUS_DETECTED video
 */
async function processVideo(video) {
  // Extract partial ID from title
  const match = video.title.match(/Video (\d+-[a-f0-9]+)/);
  if (!match) {
    return { status: 'failed', reason: 'cannot_parse_title', video: video.guid };
  }

  const partialId = match[1];

  // Find full filename in R2
  let r2Key;
  try {
    r2Key = await findR2File(partialId);
  } catch (error) {
    return { status: 'failed', reason: 'r2_lookup_error', video: video.guid, error: error.message };
  }

  if (!r2Key) {
    return { status: 'not_found', video: video.guid, partialId };
  }

  // Retry upload
  const sourceUrl = `https://${CDN_DOMAIN}/${r2Key}`;
  try {
    await bunnyClient.uploadFromUrl(video.guid, sourceUrl);
    return { status: 'retried', video: video.guid, r2Key };
  } catch (error) {
    return { status: 'failed', reason: 'upload_error', video: video.guid, error: error.message };
  }
}

/**
 * Process videos in parallel with concurrency limit
 */
async function processVideosParallel(videos, concurrency) {
  const results = [];
  const queue = [...videos];
  const active = new Set();

  while (queue.length > 0 || active.size > 0) {
    // Start new tasks up to concurrency limit
    while (active.size < concurrency && queue.length > 0) {
      const video = queue.shift();
      const promise = processVideo(video)
        .then(result => {
          active.delete(promise);
          results.push(result);
          return result;
        })
        .catch(error => {
          active.delete(promise);
          const result = { status: 'failed', reason: 'exception', video: video.guid, error: error.message };
          results.push(result);
          return result;
        });

      active.add(promise);
    }

    // Wait for at least one to complete
    if (active.size > 0) {
      await Promise.race(active);
    }
  }

  return results;
}

async function retryFailed() {
  console.log(`Starting parallel retry (concurrency: ${CONCURRENCY})...`);
  console.log('');

  let totalRetried = 0;
  let totalFailed = 0;
  let totalNotFound = 0;
  let totalSkipped = 0;
  let currentPage = 1;
  let hasMore = true;

  const startTime = Date.now();

  while (hasMore) {
    const pageStartTime = Date.now();
    console.log(`Processing page ${currentPage}...`);

    const result = await bunnyClient.listVideos(currentPage, 100);

    if (result.items.length === 0) {
      console.log('No more videos found');
      break;
    }

    // Filter for VIRUS_DETECTED videos
    const virusVideos = result.items.filter(v => v.status === VideoStatus.VIRUS_DETECTED);

    if (virusVideos.length === 0) {
      console.log(`  Page ${currentPage}: No VIRUS_DETECTED videos (${result.items.length} total, all skipped)`);
      totalSkipped += result.items.length;
      currentPage++;
      continue;
    }

    // Process in parallel
    const results = await processVideosParallel(virusVideos, CONCURRENCY);

    // Tally results
    let pageRetried = 0;
    let pageFailed = 0;
    let pageNotFound = 0;

    for (const res of results) {
      if (res.status === 'retried') {
        pageRetried++;
        console.log(`  ✅ ${res.video}: ${res.r2Key}`);
      } else if (res.status === 'not_found') {
        pageNotFound++;
        console.log(`  ⚠️  ${res.video}: file not found (${res.partialId})`);
      } else if (res.status === 'failed') {
        pageFailed++;
        console.log(`  ❌ ${res.video}: ${res.reason}${res.error ? ' - ' + res.error : ''}`);
      }
    }

    const pageSkipped = result.items.length - virusVideos.length;
    totalRetried += pageRetried;
    totalFailed += pageFailed;
    totalNotFound += pageNotFound;
    totalSkipped += pageSkipped;

    const pageTime = ((Date.now() - pageStartTime) / 1000).toFixed(1);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (totalRetried / (Date.now() - startTime) * 1000).toFixed(1);

    console.log(`  Page ${currentPage} (${pageTime}s): retried=${pageRetried}, failed=${pageFailed}, not_found=${pageNotFound}, skipped=${pageSkipped}`);
    console.log(`  Totals (${totalTime}s, ${rate}/s): retried=${totalRetried}, failed=${totalFailed}, not_found=${totalNotFound}, skipped=${totalSkipped}`);
    console.log('');

    hasMore = result.items.length > 0;
    currentPage++;

    // Optional: limit pages for testing
    // if (currentPage > 10) break;
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = totalRetried > 0 ? (totalRetried / (Date.now() - startTime) * 1000).toFixed(1) : 0;

  console.log('='.repeat(60));
  console.log('Parallel Retry Complete');
  console.log('='.repeat(60));
  console.log(`Total time: ${totalTime}s`);
  console.log(`Retry rate: ${rate} videos/second`);
  console.log(`Total retried: ${totalRetried}`);
  console.log(`Total failed: ${totalFailed}`);
  console.log(`Total not found: ${totalNotFound}`);
  console.log(`Total skipped: ${totalSkipped}`);
  console.log(`Pages processed: ${currentPage - 1}`);
}

retryFailed().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
