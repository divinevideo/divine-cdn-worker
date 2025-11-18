// ABOUTME: Fetch accurate stats from BunnyStream by paginating through all videos
// ABOUTME: Counts videos by status, identifies failures, ready videos, and processing

import { BunnyStreamClient, VideoStatus, VideoStatusLabel } from './src/streaming/bunny-client.mjs';

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';

if (!BUNNY_STREAM_ACCESS_KEY) {
  console.error('Error: BUNNY_STREAM_ACCESS_KEY environment variable required');
  process.exit(1);
}

const bunnyClient = new BunnyStreamClient(
  BUNNY_STREAM_ACCESS_KEY,
  BUNNY_STREAM_LIBRARY_ID
);

async function getStats() {
  console.error('Fetching all videos from BunnyStream...');
  console.error('This will take several minutes for 157k videos...');
  console.error('');

  const stats = {
    total: 0,
    byStatus: {},
    withOriginalHash: 0,
    withoutOriginalHash: 0,
    zeroBytes: 0,
    ready: 0,
    processing: 0,
    failed: 0,
    totalStorage: 0
  };

  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await bunnyClient.listVideos(currentPage, 100, 'date');

      console.error(`Page ${currentPage}: ${result.items.length} videos (total so far: ${stats.total + result.items.length})`);

      result.items.forEach(v => {
        stats.total++;

        // Count by status
        const statusLabel = VideoStatusLabel[v.status] || 'unknown';
        stats.byStatus[statusLabel] = (stats.byStatus[statusLabel] || 0) + 1;

        // Count originalHash
        if (v.originalHash) {
          stats.withOriginalHash++;
        } else {
          stats.withoutOriginalHash++;
        }

        // Count zero bytes
        if (v.storageSize === 0) {
          stats.zeroBytes++;
        }

        // Count ready (status 3 or 4)
        if (v.status >= VideoStatus.FINISHED) {
          stats.ready++;
        }

        // Count processing (status 0-2)
        if (v.status >= VideoStatus.QUEUED && v.status <= VideoStatus.ENCODING) {
          stats.processing++;
        }

        // Count failed (status 5-6)
        if (v.status === VideoStatus.ERROR || v.status === VideoStatus.VIRUS_DETECTED) {
          stats.failed++;
        }

        stats.totalStorage += v.storageSize || 0;
      });

      // Continue until we get an empty page (Bunny API doesn't provide totalPages)
      hasMore = result.items.length > 0;
      currentPage++;

      // Rate limit to avoid overwhelming API
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error) {
      console.error(`Error on page ${currentPage}:`, error.message);
      // Retry once
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
  }

  return stats;
}

async function main() {
  const stats = await getStats();

  console.error('');
  console.error('='.repeat(60));
  console.error('BunnyStream Statistics');
  console.error('='.repeat(60));
  console.error('');
  console.error(`Total videos: ${stats.total}`);
  console.error(`Total storage: ${(stats.totalStorage / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.error('');
  console.error('By Status:');
  Object.entries(stats.byStatus)
    .sort((a, b) => b[1] - a[1])
    .forEach(([status, count]) => {
      const pct = ((count / stats.total) * 100).toFixed(1);
      console.error(`  ${status.padEnd(20)} ${count.toLocaleString().padStart(8)} (${pct}%)`);
    });
  console.error('');
  console.error('Original Hash:');
  console.error(`  With originalHash:    ${stats.withOriginalHash.toLocaleString()}`);
  console.error(`  Without originalHash: ${stats.withoutOriginalHash.toLocaleString()}`);
  console.error('');
  console.error('Processing Status:');
  console.error(`  Ready (status 3-4):   ${stats.ready.toLocaleString()}`);
  console.error(`  Processing (0-2):     ${stats.processing.toLocaleString()}`);
  console.error(`  Failed (5-6):         ${stats.failed.toLocaleString()}`);
  console.error('');
  console.error('Issues:');
  console.error(`  Zero bytes:           ${stats.zeroBytes.toLocaleString()}`);
  console.error('');

  // Output JSON to stdout
  console.log(JSON.stringify(stats, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
