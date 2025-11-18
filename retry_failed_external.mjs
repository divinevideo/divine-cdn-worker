// ABOUTME: Standalone script to retry failed BunnyStream uploads
// ABOUTME: Runs outside Worker to avoid timeout limits, processes VIRUS_DETECTED videos

import { BunnyStreamClient, VideoStatus } from './src/streaming/bunny-client.mjs';

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';
const CDN_DOMAIN = process.env.CDN_DOMAIN || 'cdn.divine.video';
const R2_LIST_ENDPOINT = process.env.R2_LIST_ENDPOINT || 'https://blossom.divine.video/_list_r2';

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

async function retryFailed() {
  console.log('Starting retry of failed BunnyStream videos...');
  console.log('');

  let totalRetried = 0;
  let totalFailed = 0;
  let totalNotFound = 0;
  let totalSkipped = 0;
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    console.log(`Processing page ${currentPage}...`);

    const result = await bunnyClient.listVideos(currentPage, 100);

    if (result.items.length === 0) {
      console.log('No more videos found');
      break;
    }

    let pageRetried = 0;
    let pageFailed = 0;
    let pageNotFound = 0;
    let pageSkipped = 0;

    for (const video of result.items) {
      // Only process VIRUS_DETECTED videos
      if (video.status !== VideoStatus.VIRUS_DETECTED) {
        pageSkipped++;
        continue;
      }

      // Extract partial ID from title (e.g., "Video 1754062302456-2c")
      const match = video.title.match(/Video (\d+-[a-f0-9]+)/);
      if (!match) {
        console.log(`  Skipping ${video.guid}: can't parse title "${video.title}"`);
        pageFailed++;
        continue;
      }

      const partialId = match[1];

      // Find full filename in R2
      let r2Key;
      try {
        r2Key = await findR2File(partialId);
      } catch (error) {
        console.error(`  Error looking up R2 file for ${partialId}:`, error.message);
        pageFailed++;
        continue;
      }

      if (!r2Key) {
        console.log(`  Not found: ${partialId}`);
        pageNotFound++;
        continue;
      }

      // Retry upload
      const sourceUrl = `https://${CDN_DOMAIN}/${r2Key}`;
      try {
        await bunnyClient.uploadFromUrl(video.guid, sourceUrl);
        console.log(`  ✅ Retried ${video.guid}: ${r2Key}`);
        pageRetried++;
      } catch (error) {
        console.error(`  ❌ Failed ${video.guid}:`, error.message);
        pageFailed++;
      }
    }

    totalRetried += pageRetried;
    totalFailed += pageFailed;
    totalNotFound += pageNotFound;
    totalSkipped += pageSkipped;

    console.log(`  Page ${currentPage}: retried=${pageRetried}, failed=${pageFailed}, not_found=${pageNotFound}, skipped=${pageSkipped}`);
    console.log(`  Running totals: retried=${totalRetried}, failed=${totalFailed}, not_found=${totalNotFound}, skipped=${totalSkipped}`);
    console.log('');

    hasMore = result.items.length > 0;
    currentPage++;

    // Optional: limit pages for testing
    // if (currentPage > 10) break;
  }

  console.log('='.repeat(60));
  console.log('Retry Complete');
  console.log('='.repeat(60));
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
