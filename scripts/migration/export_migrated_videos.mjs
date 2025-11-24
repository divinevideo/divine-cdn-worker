// ABOUTME: Export migrated videos from KV with BunnyStream URLs for Nostr republishing
// ABOUTME: Queries MEDIA_KV for blob entries with bunny metadata and fetches HLS URLs

import { BunnyStreamClient } from './src/streaming/bunny-client.mjs';

/**
 * Export migrated videos with BunnyStream URLs
 * Usage: node export_migrated_videos.mjs [limit]
 */

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';
const BUNNY_STREAM_PULL_ZONE = 'stream.divine.video';

if (!BUNNY_STREAM_ACCESS_KEY) {
  console.error('Error: BUNNY_STREAM_ACCESS_KEY environment variable required');
  process.exit(1);
}

// Initialize BunnyStream client
const bunnyClient = new BunnyStreamClient(
  BUNNY_STREAM_ACCESS_KEY,
  BUNNY_STREAM_LIBRARY_ID
);

/**
 * Query BunnyStream for all videos, filter for those with originalHash
 */
async function getMigratedVideos(limit = 100) {
  console.error('Fetching migrated videos from BunnyStream...');

  const allVideos = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore && (limit === 0 || allVideos.length < limit)) {
    const pageSize = Math.min(100, limit - allVideos.length);
    const result = await bunnyClient.listVideos(currentPage, pageSize, 'date');

    console.error(`Page ${currentPage}: ${result.items.length} videos`);

    // Filter for videos with originalHash (these are our migrated videos)
    const migratedInPage = result.items
      .filter(v => v.originalHash && v.status >= 3) // status 3+ means finished/ready
      .map(v => ({
        sha256: v.originalHash.toLowerCase(),
        videoId: v.guid,
        title: v.title,
        status: v.status,
        hlsUrl: `https://${BUNNY_STREAM_PULL_ZONE}/${v.guid}/playlist.m3u8`,
        thumbnailUrl: v.thumbnailFileName ? `https://${BUNNY_STREAM_PULL_ZONE}/${v.guid}/${v.thumbnailFileName}` : null,
        duration: v.length,
        width: v.width,
        height: v.height
      }));

    allVideos.push(...migratedInPage);

    // Check if there are more pages
    hasMore = result.currentPage < result.totalPages;
    currentPage++;

    if (limit > 0 && allVideos.length >= limit) {
      break;
    }
  }

  return allVideos;
}

/**
 * Main export function
 */
async function exportVideos() {
  const limit = parseInt(process.argv[2]) || 0; // 0 = all videos

  console.error(`Exporting ${limit === 0 ? 'all' : limit} migrated videos...`);
  console.error('');

  const videos = await getMigratedVideos(limit);

  console.error('');
  console.error(`Found ${videos.length} migrated videos with originalHash`);
  console.error('');
  console.error('Format: SHA256, VideoID, HLS URL, Duration, Resolution');
  console.error('');

  // Output as JSON to stdout (errors go to stderr)
  console.log(JSON.stringify(videos, null, 2));

  // Summary to stderr
  console.error('');
  console.error('='.repeat(60));
  console.error('Summary:');
  console.error(`  Total migrated: ${videos.length}`);
  console.error(`  Ready for republishing: ${videos.filter(v => v.status >= 3).length}`);
  console.error('');
  console.error('Save to file: node export_migrated_videos.mjs > migrated_videos.json');
  console.error('CSV format: jq -r \'.[] | [.sha256, .videoId, .hlsUrl] | @csv\' migrated_videos.json');
}

exportVideos().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
