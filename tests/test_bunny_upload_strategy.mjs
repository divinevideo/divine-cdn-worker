#!/usr/bin/env node
// ABOUTME: Integration test demonstrating BunnyStream upload strategy selection
// ABOUTME: Shows how upload routing works with different configurations

import { selectUploadStrategy, BunnyUploadHandler } from '../src/streaming/upload-strategy.mjs';

console.log('🎯 BunnyStream Upload Strategy Demo\n');
console.log('='.repeat(60));

// Test hashes with different distribution values
const testVideos = [
  { name: 'video-001.mp4', sha256: '0000000000000000000000000000000000000000000000000000000000000000' }, // 0
  { name: 'video-025.mp4', sha256: '1900000000000000000000000000000000000000000000000000000000000000' }, // 25
  { name: 'video-050.mp4', sha256: '3200000000000000000000000000000000000000000000000000000000000000' }, // 50
  { name: 'video-075.mp4', sha256: '4b00000000000000000000000000000000000000000000000000000000000000' }, // 75
  { name: 'video-099.mp4', sha256: 'ff00000000000000000000000000000000000000000000000000000000000000' }  // 99
];

// Mock environment configurations
const scenarios = [
  {
    name: 'Disabled (All to R2)',
    env: {
      BUNNY_STREAM_ENABLED: 'false'
    }
  },
  {
    name: 'R2 Only',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'r2'
    }
  },
  {
    name: 'Bunny Only',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'bunny'
    }
  },
  {
    name: 'Dual Mode - 0% Rollout',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'dual',
      BUNNY_ROLLOUT_PERCENTAGE: '0'
    }
  },
  {
    name: 'Dual Mode - 25% Rollout',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'dual',
      BUNNY_ROLLOUT_PERCENTAGE: '25'
    }
  },
  {
    name: 'Dual Mode - 50% Rollout',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'dual',
      BUNNY_ROLLOUT_PERCENTAGE: '50'
    }
  },
  {
    name: 'Dual Mode - 75% Rollout',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'dual',
      BUNNY_ROLLOUT_PERCENTAGE: '75'
    }
  },
  {
    name: 'Dual Mode - 100% Rollout',
    env: {
      BUNNY_STREAM_ENABLED: 'true',
      BUNNY_UPLOAD_DEST: 'dual',
      BUNNY_ROLLOUT_PERCENTAGE: '100'
    }
  }
];

// Run tests for each scenario
for (const scenario of scenarios) {
  console.log(`\n📋 Scenario: ${scenario.name}`);
  console.log('-'.repeat(60));

  for (const video of testVideos) {
    const result = selectUploadStrategy(
      scenario.env,
      video.sha256,
      { type: 'video/mp4', size: 5000000 }
    );

    const icon = result.shouldUseBunny ? '🐰' : '📦';
    const dest = result.shouldUseBunny ? 'Bunny' : 'R2   ';
    console.log(`${icon} ${video.name} -> ${dest} (hash value: ${parseInt(video.sha256.substring(0, 8), 16) % 100})`);
  }
}

// Demonstrate hash-based consistency
console.log('\n\n🔄 Hash-Based Consistency Test');
console.log('='.repeat(60));
console.log('Testing that same SHA-256 always routes to same provider...\n');

const consistencyEnv = {
  BUNNY_STREAM_ENABLED: 'true',
  BUNNY_UPLOAD_DEST: 'dual',
  BUNNY_ROLLOUT_PERCENTAGE: '50'
};

const testHash = '3200000000000000000000000000000000000000000000000000000000000000';

console.log(`Test Hash: ${testHash.substring(0, 16)}...`);
console.log(`Hash Value: ${parseInt(testHash.substring(0, 8), 16) % 100}\n`);

for (let i = 0; i < 5; i++) {
  const result = selectUploadStrategy(consistencyEnv, testHash, {});
  console.log(`  Attempt ${i + 1}: ${result.provider} (shouldUseBunny: ${result.shouldUseBunny})`);
}

// Demonstrate rollout distribution
console.log('\n\n📊 Rollout Distribution Analysis');
console.log('='.repeat(60));
console.log('Testing distribution with 100 different hashes...\n');

const rolloutTests = [10, 25, 50, 75, 90];

for (const rollout of rolloutTests) {
  const env = {
    BUNNY_STREAM_ENABLED: 'true',
    BUNNY_UPLOAD_DEST: 'dual',
    BUNNY_ROLLOUT_PERCENTAGE: rollout.toString()
  };

  let bunnyCount = 0;
  const totalHashes = 100;

  for (let i = 0; i < totalHashes; i++) {
    const hex = i.toString(16).padStart(8, '0');
    const hash = hex + '0'.repeat(56);
    const result = selectUploadStrategy(env, hash, {});
    if (result.shouldUseBunny) {
      bunnyCount++;
    }
  }

  const r2Count = totalHashes - bunnyCount;
  const bunnyBar = '█'.repeat(Math.round(bunnyCount / 2));
  const r2Bar = '░'.repeat(Math.round(r2Count / 2));

  console.log(`${rollout}% Rollout: 🐰 ${bunnyBar}${r2Bar} 📦 (${bunnyCount} Bunny, ${r2Count} R2)`);
}

// Demonstrate BunnyUploadHandler usage
console.log('\n\n🔧 BunnyUploadHandler Demo');
console.log('='.repeat(60));

const mockEnv = {
  BUNNY_STREAM_ACCESS_KEY: '',
  BUNNY_STREAM_LIBRARY_ID: '',
  MEDIA_KV: {
    async get(key, options) {
      const testData = {
        'blob:test123': JSON.stringify({
          sha256: 'test123',
          size: 1000000,
          type: 'video/mp4',
          bunny: {
            videoId: 'abc-123',
            guid: 'xyz-789',
            status: 'ready',
            hlsUrl: 'https://vz-test.b-cdn.net/xyz-789/playlist.m3u8'
          }
        })
      };
      const value = testData[key];
      if (!value) return null;
      return options?.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      console.log(`  📝 KV PUT: ${key}`);
    }
  }
};

const handler = new BunnyUploadHandler(mockEnv);

console.log('\nTest 1: Get streaming URLs for ready video');
const urls = await handler.getStreamingUrls('test123', mockEnv);
if (urls) {
  console.log(`  ✅ HLS URL: ${urls.hlsUrl}`);
  console.log(`  ✅ Status: ${urls.status}`);
} else {
  console.log('  ❌ No streaming URLs available');
}

console.log('\nTest 2: Initiate upload without credentials (should fail gracefully)');
const upload = await handler.initiateUpload('newvideo123', { type: 'video/mp4', size: 5000000 }, mockEnv);
if (upload) {
  console.log(`  ✅ Upload URL: ${upload.uploadUrl}`);
  console.log(`  ✅ Video ID: ${upload.videoId}`);
} else {
  console.log('  ⚠️  No upload initiated (credentials not configured)');
}

console.log('\n\n✅ Upload Strategy Demo Complete!');
console.log('='.repeat(60));
console.log('\nKey Takeaways:');
console.log('  • Hash-based routing ensures consistency');
console.log('  • Rollout percentage allows gradual migration');
console.log('  • Graceful degradation when Bunny unavailable');
console.log('  • Feature flag provides instant rollback capability');
console.log('');
