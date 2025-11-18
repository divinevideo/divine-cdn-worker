#!/usr/bin/env node
/**
 * Pre-calculate SHA256 hashes for all uploads/ files and store in KV
 * This is a one-time operation to build the index
 */

const BATCH_SIZE = 50; // Process 50 files at a time
const WORKER_URL = 'https://blossom.divine.video';

async function buildUploadsIndex() {
  console.log('Building SHA256 index for uploads/ files...\n');

  let cursor = undefined;
  let totalProcessed = 0;
  let totalIndexed = 0;
  let batches = 0;

  while (true) {
    batches++;
    console.log(`\n=== Batch ${batches} ===`);

    // Call worker endpoint to process a batch
    const body = cursor
      ? { batchSize: BATCH_SIZE, cursor }
      : { batchSize: BATCH_SIZE };

    const response = await fetch(`${WORKER_URL}/index-uploads-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error('Error:', response.status, await response.text());
      break;
    }

    const data = await response.json();

    console.log(`Processed: ${data.processed}`);
    console.log(`Indexed: ${data.indexed}`);
    console.log(`Skipped: ${data.skipped}`);
    console.log(`Errors: ${data.errors}`);

    totalProcessed += data.processed;
    totalIndexed += data.indexed;

    if (!data.hasMore) {
      console.log('\n✅ Index build complete!');
      break;
    }

    cursor = data.cursor;
    console.log(`Continuing with cursor...`);
  }

  console.log(`\n=== Final Results ===`);
  console.log(`Total files processed: ${totalProcessed}`);
  console.log(`Total indexed: ${totalIndexed}`);
}

buildUploadsIndex().catch(console.error);
