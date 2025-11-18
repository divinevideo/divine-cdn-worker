#!/usr/bin/env node
/**
 * Count actual file type distribution across entire R2 bucket
 */

async function countFileTypes() {
  let cursor = undefined;
  let totalFiles = 0;
  let totalMp4 = 0;
  let totalSha256Mp4 = 0;
  let totalPassFilter = 0;
  let batches = 0;

  console.log('Scanning entire R2 bucket...\n');

  while (true) {
    const body = cursor ? { limit: 1000, cursor } : { limit: 1000 };

    const response = await fetch('https://blossom.divine.video/debug-r2-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    totalFiles += data.stats.total;
    totalMp4 += data.stats.mp4Files;
    totalSha256Mp4 += data.stats.sha256Format;
    totalPassFilter += data.stats.passFilter;
    batches++;

    console.log(`Batch ${batches}: ${data.stats.total} files, ${data.stats.passFilter} valid videos (total so far: ${totalPassFilter})`);

    if (!data.pagination.truncated) {
      console.log('\nScan complete!');
      break;
    }

    cursor = data.pagination.cursor;
  }

  console.log('\n=== FINAL RESULTS ===');
  console.log(`Total files in R2: ${totalFiles.toLocaleString()}`);
  console.log(`Total MP4 files: ${totalMp4.toLocaleString()} (${(totalMp4/totalFiles*100).toFixed(1)}%)`);
  console.log(`SHA256-named MP4s: ${totalSha256Mp4.toLocaleString()} (${(totalSha256Mp4/totalFiles*100).toFixed(1)}%)`);
  console.log(`Valid Vine videos (pass filter): ${totalPassFilter.toLocaleString()} (${(totalPassFilter/totalFiles*100).toFixed(1)}%)`);
  console.log(`JPG/other files: ${(totalFiles - totalSha256Mp4).toLocaleString()} (${((totalFiles - totalSha256Mp4)/totalFiles*100).toFixed(1)}%)`);
}

countFileTypes().catch(console.error);
