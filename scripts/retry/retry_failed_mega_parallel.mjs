// ABOUTME: MEGA parallel retry - processes multiple pages AND videos concurrently
// ABOUTME: Maximum throughput for cloud-scale systems (CF Workers + BunnyStream)

import { BunnyStreamClient, VideoStatus } from './src/streaming/bunny-client.mjs';

const BUNNY_STREAM_ACCESS_KEY = process.env.BUNNY_STREAM_ACCESS_KEY;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || '515420';
const CDN_DOMAIN = process.env.CDN_DOMAIN || 'cdn.divine.video';
const R2_LIST_ENDPOINT = process.env.R2_LIST_ENDPOINT || 'https://blossom.divine.video/_list_r2';
const VIDEO_CONCURRENCY = parseInt(process.env.VIDEO_CONCURRENCY || '50'); // Process 50 videos at once
const PAGE_CONCURRENCY = parseInt(process.env.PAGE_CONCURRENCY || '1'); // Process 1 page at a time (BunnyStream API limit)
const START_PAGE = parseInt(process.env.START_PAGE || '1');

if (!BUNNY_STREAM_ACCESS_KEY) {
  console.error('Error: BUNNY_STREAM_ACCESS_KEY environment variable required');
  process.exit(1);
}

const bunnyClient = new BunnyStreamClient(
  BUNNY_STREAM_ACCESS_KEY,
  BUNNY_STREAM_LIBRARY_ID,
  { timeout: 60000 } // 60 seconds timeout instead of default 30s
);

async function findR2File(partialId) {
  const response = await fetch(`${R2_LIST_ENDPOINT}?prefix=uploads/${partialId}&limit=1`);
  const data = await response.json();
  return data.objects?.[0]?.key || null;
}

async function processVideo(video) {
  const match = video.title.match(/Video (\d+-[a-f0-9]+)/);
  if (!match) {
    return { status: 'failed', reason: 'cannot_parse_title', video: video.guid };
  }

  const partialId = match[1];

  try {
    const r2Key = await findR2File(partialId);
    if (!r2Key) {
      return { status: 'not_found', video: video.guid, partialId };
    }

    const sourceUrl = `https://${CDN_DOMAIN}/${r2Key}`;
    await bunnyClient.uploadFromUrl(video.guid, sourceUrl);
    return { status: 'retried', video: video.guid, r2Key };
  } catch (error) {
    return { status: 'failed', reason: 'error', video: video.guid, error: error.message };
  }
}

async function processVideosParallel(videos, concurrency) {
  const results = [];
  const queue = [...videos];
  const active = new Set();

  while (queue.length > 0 || active.size > 0) {
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

    if (active.size > 0) {
      await Promise.race(active);
    }
  }

  return results;
}

async function processPage(pageNum, stats, retryCount = 0) {
  const maxRetries = 5;
  const baseDelay = 5000; // 5 seconds

  try {
    const result = await bunnyClient.listVideos(pageNum, 100);

    if (result.items.length === 0) {
      return { page: pageNum, empty: true };
    }

    const virusVideos = result.items.filter(v => v.status === VideoStatus.VIRUS_DETECTED);

    if (virusVideos.length === 0) {
      stats.skipped += result.items.length;
      return { page: pageNum, skipped: result.items.length };
    }

    const results = await processVideosParallel(virusVideos, VIDEO_CONCURRENCY);

    const pageStats = {
      page: pageNum,
      retried: results.filter(r => r.status === 'retried').length,
      failed: results.filter(r => r.status === 'failed').length,
      notFound: results.filter(r => r.status === 'not_found').length,
      skipped: result.items.length - virusVideos.length
    };

    stats.retried += pageStats.retried;
    stats.failed += pageStats.failed;
    stats.notFound += pageStats.notFound;
    stats.skipped += pageStats.skipped;

    return pageStats;
  } catch (error) {
    // Check if it's a timeout and we haven't exceeded max retries
    if (error.message.includes('timeout') && retryCount < maxRetries) {
      const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
      console.log(`Page ${pageNum} timeout (attempt ${retryCount + 1}/${maxRetries}), retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return processPage(pageNum, stats, retryCount + 1);
    }

    console.error(`Error on page ${pageNum}:`, error.message);
    return { page: pageNum, error: error.message };
  }
}

async function retryFailed() {
  console.log(`Starting MEGA parallel retry:`);
  console.log(`  Video concurrency: ${VIDEO_CONCURRENCY}`);
  console.log(`  Page concurrency: ${PAGE_CONCURRENCY}`);
  console.log(`  Starting from page: ${START_PAGE}`);
  console.log('');

  const stats = {
    retried: 0,
    failed: 0,
    notFound: 0,
    skipped: 0
  };

  let currentPage = START_PAGE;
  const startTime = Date.now();

  while (true) {
    // Process PAGE_CONCURRENCY pages in parallel
    const pagePromises = [];
    for (let i = 0; i < PAGE_CONCURRENCY; i++) {
      pagePromises.push(processPage(currentPage + i, stats));
    }

    const pageResults = await Promise.all(pagePromises);

    // Check if we hit the end
    const allEmpty = pageResults.every(r => r.empty);
    if (allEmpty) {
      console.log('Reached end of video list');
      break;
    }

    // Log progress
    pageResults.forEach(r => {
      if (r.retried > 0) {
        console.log(`Page ${r.page}: ✅ retried=${r.retried}, failed=${r.failed}, not_found=${r.notFound}, skipped=${r.skipped}`);
      } else if (!r.empty && !r.error) {
        console.log(`Page ${r.page}: skipped=${r.skipped || 100}`);
      }
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = stats.retried > 0 ? (stats.retried / (Date.now() - startTime) * 1000).toFixed(1) : 0;
    console.log(`Pages ${currentPage}-${currentPage + PAGE_CONCURRENCY - 1} (${elapsed}s, ${rate}/s): total retried=${stats.retried}, failed=${stats.failed}, not_found=${stats.notFound}, skipped=${stats.skipped}`);
    console.log('');

    currentPage += PAGE_CONCURRENCY;

    // Safety limit
    if (currentPage > 2000) {
      console.log('Reached page limit (2000)');
      break;
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = stats.retried > 0 ? (stats.retried / (Date.now() - startTime) * 1000).toFixed(1) : 0;

  console.log('='.repeat(60));
  console.log('MEGA Parallel Retry Complete');
  console.log('='.repeat(60));
  console.log(`Total time: ${totalTime}s`);
  console.log(`Retry rate: ${rate} videos/second`);
  console.log(`Total retried: ${stats.retried}`);
  console.log(`Total failed: ${stats.failed}`);
  console.log(`Total not found: ${stats.notFound}`);
  console.log(`Total skipped: ${stats.skipped}`);
  console.log(`Pages processed: ${currentPage - START_PAGE}`);
}

retryFailed().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
