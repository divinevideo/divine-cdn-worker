#!/usr/bin/env node
/**
 * Test script to examine actual R2 file sizes and understand why they're being filtered
 */

const BATCH_SIZE = 1000;
const MIN_SIZE = 200000; // 200KB
const MAX_SIZE = 20000000; // 20MB

async function testR2Sizes() {
  console.log('Fetching R2 file list via Worker API...');

  const response = await fetch('https://blossom.divine.video/backfill-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: BATCH_SIZE, skipExisting: false })
  });

  const data = await response.json();

  console.log('\n=== API Response Summary ===');
  console.log('Processed:', data.summary.processed);
  console.log('Uploaded:', data.summary.newlyBackfilled);
  console.log('Errors:', data.summary.errors);
  console.log('Videos returned:', data.videos?.length || 0);

  // Now let's test the size filter by fetching R2 list directly via another endpoint
  // We need to create a test endpoint that returns raw R2 list data
  console.log('\n=== We need raw R2 data to debug ===');
  console.log('Current API only returns processed results.');
  console.log('Need to check actual R2 file sizes before filtering.');
}

testR2Sizes().catch(console.error);
