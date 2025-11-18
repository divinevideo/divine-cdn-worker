#!/usr/bin/env node
// Quick script to count objects in R2 buckets
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const accountId = 'c84e7a9bf7ed99cb41b8e73566568c75';
const buckets = ['nostrvine-media', 'yestr-avatars', 'blossom-blobs'];

// Check if credentials are in env
if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.log('⚠️  R2 credentials not found in environment');
  console.log('Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to use this script');
  process.exit(1);
}

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

async function countObjects(bucket) {
  try {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1000
    });
    
    const response = await s3Client.send(command);
    const count = response.Contents?.length || 0;
    const truncated = response.IsTruncated;
    
    console.log(`\n📦 ${bucket}:`);
    console.log(`   Objects: ${count}${truncated ? '+' : ''} ${truncated ? '(more available)' : ''}`);
    
    if (count > 0 && response.Contents) {
      // Show a few examples
      console.log(`   Examples:`);
      response.Contents.slice(0, 5).forEach(obj => {
        console.log(`     - ${obj.Key} (${(obj.Size / 1024).toFixed(2)} KB)`);
      });
    }
    
    return count;
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return 0;
  }
}

async function main() {
  console.log('🔍 Checking R2 buckets for avatar data...\n');
  
  for (const bucket of buckets) {
    await countObjects(bucket);
  }
}

main().catch(console.error);
