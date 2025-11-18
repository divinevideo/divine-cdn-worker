// ABOUTME: Fetch failed videos from BunnyStream to investigate encoding errors
// ABOUTME: Queries BunnyStream API for videos with error status (5 or 6)

import { BunnyStreamClient, VideoStatus } from './src/streaming/bunny-client.mjs';

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

async function getFailedVideos() {
  console.error('Fetching failed videos from BunnyStream...');
  console.error('');

  const failedVideos = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await bunnyClient.listVideos(currentPage, 100, 'date');

    console.error(`Page ${currentPage}: checking ${result.items.length} videos...`);

    // Filter for error status (5 = ERROR, 6 = VIRUS_DETECTED)
    const failedInPage = result.items
      .filter(v => v.status === VideoStatus.ERROR || v.status === VideoStatus.VIRUS_DETECTED)
      .map(v => ({
        videoId: v.guid,
        title: v.title,
        status: v.status,
        statusLabel: v.status === VideoStatus.ERROR ? 'ERROR' : 'VIRUS_DETECTED',
        originalHash: v.originalHash,
        dateUploaded: v.dateUploaded,
        transcodingMessages: v.transcodingMessages || []
      }));

    failedVideos.push(...failedInPage);

    hasMore = result.currentPage < result.totalPages;
    currentPage++;
  }

  console.error('');
  console.error(`Found ${failedVideos.length} failed videos`);
  console.error('');

  // Output JSON to stdout
  console.log(JSON.stringify(failedVideos, null, 2));

  // Summary to stderr
  console.error('='.repeat(60));
  console.error('Common Error Messages:');
  const errorMessages = {};
  failedVideos.forEach(v => {
    if (v.transcodingMessages && v.transcodingMessages.length > 0) {
      const msg = v.transcodingMessages[0].message || 'Unknown error';
      errorMessages[msg] = (errorMessages[msg] || 0) + 1;
    }
  });

  Object.entries(errorMessages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([msg, count]) => {
      console.error(`  ${count}x: ${msg}`);
    });
  console.error('');
  console.error('Save to file: node get_failed_videos.mjs > failed_videos.json');
}

getFailedVideos().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
