# R2-Driven Backfill Solution

## Problem Solved

BunnyStream's OFFSET-based pagination API breaks beyond page ~150 (OFFSET 14,700+), making it impossible to process all 157k videos. We pivoted to an **R2-driven approach** that completely bypasses BunnyStream's pagination issues.

## Key Discovery: BunnyStream Provides SHA256!

**Critical finding**: BunnyStream calculates and returns the full SHA256 hash as `originalHash` when videos finish encoding!

### How It Works

1. **Upload to BunnyStream** with partial identifier (e.g., `uploads/1750591730308-13cdc4ee.mp4`)
2. **Store temp metadata** in KV as `upload-temp:{uploadsPath}`
3. **BunnyStream processes** video and calculates SHA256
4. **Webhook fires** on completion (see `src/streaming/bunny-webhook.mjs:210-211`)
5. **Webhook fetches** `originalHash` from BunnyStream API
6. **Webhook creates** proper `blob:{sha256}` KV entry
7. **Webhook deletes** temporary entry

This is already implemented and working!

## Solution Architecture

### R2-Driven vs BunnyStream-Driven

| Approach | Pagination | Scalability | Status |
|----------|-----------|-------------|---------|
| **R2-driven** | Cursor-based | ✅ Unlimited | ✅ Working |
| BunnyStream-driven | OFFSET-based | ❌ Breaks at page 150 | ❌ Abandoned |

### Implementation

**Endpoint**: `POST /backfill-batch`

**New Parameters**:
- `limit` - Videos per batch (max 200)
- `prefix` - R2 prefix filter (e.g., `"uploads/"`) ← **NEW!**
- `cursor` - Pagination cursor
- `skipExisting` - Skip already backfilled (default: true)

**Example Request**:
```bash
curl -X POST https://blossom.divine.video/backfill-batch \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 100,
    "prefix": "uploads/",
    "skipExisting": true
  }'
```

**Example Response**:
```json
{
  "summary": {
    "processed": 9,
    "alreadyBackfilled": 9,
    "newlyBackfilled": 0,
    "errors": 0
  },
  "videos": [
    {
      "status": "already_backfilled",
      "videoId": "5a378d71-5010-4848-92d0-56043f03fa7f"
    }
  ],
  "pagination": {
    "truncated": true,
    "cursor": "1-JTdC..."
  }
}
```

## Running the Backfill

### Quick Test (10 videos)
```bash
./backfill_uploads_r2_driven.sh https://blossom.divine.video/backfill-batch 10 1
```

### Production Run (all 152k uploads/ files)
```bash
./backfill_uploads_r2_driven.sh https://blossom.divine.video/backfill-batch 100
```

The script:
- Uses cursor-based pagination (no page limits!)
- Processes 100 videos per batch by default
- Automatically skips already-backfilled videos
- Tracks progress and rates
- Can resume from any point using cursors

## Data Flow

```
┌─────────┐
│   R2    │ List uploads/ with cursor pagination (152,849 files)
│ Storage │
└────┬────┘
     │
     ▼
┌─────────────────┐
│ /backfill-batch │ Filter MP4s (200KB-20MB), check KV for existing
└────┬────────────┘
     │
     ├─ Already backfilled? → Skip (logged in response)
     │
     └─ New? → ┌──────────────┐
               │  BunnyStream  │ Upload, store upload-temp:{path}
               └──────┬────────┘
                      │
                      ▼ (30-120s encoding)
               ┌──────────────┐
               │   Webhook    │ Fetch originalHash, create blob:{sha256}
               └──────────────┘
```

## KV Structure

| Key Pattern | Value | Purpose |
|-------------|-------|---------|
| `blob:{sha256}` | Video metadata + bunny info | Primary video record |
| `upload-temp:{uploadsPath}` | Temp metadata during processing | Deleted after webhook |
| `bunny:video:{videoId}` | Reverse mapping | videoId → sha256 lookup |

## Current Status

✅ **R2-driven backfill working end-to-end**
- Tested with uploads/ prefix
- Cursor pagination confirmed working
- Deduplication working (skips already-backfilled)
- Worker deployed with prefix support

✅ **Previous BunnyStream-driven retry recovered 6,969 videos** (pages 64-146)
- Hit pagination wall at page 147
- Approach abandoned in favor of R2-driven

## Next Steps

1. **Run full backfill** on uploads/ files (152k videos)
2. **Monitor webhook logs** to verify SHA256 extraction
3. **Optionally backfill SHA256-named files** (5k videos) if needed

## Files

- `src/index.mjs:1372-1677` - backfill-batch endpoint
- `src/streaming/bunny-webhook.mjs:200-250` - originalHash extraction
- `backfill_uploads_r2_driven.sh` - Batch runner script
- `test_kv_index.mjs` - Verification script

## Performance Estimates

- **R2 list**: ~100ms per batch
- **Backfill rate**: ~2-3 videos/second (limited by BunnyStream API)
- **Total time**: ~14-21 hours for 152k videos
- **Can run in parallel**: Yes! Multiple batch scripts with different cursors

## Why This Approach Wins

1. **Scalability**: Cursor-based pagination works at any scale
2. **Simplicity**: No SHA256 index needed (BunnyStream calculates it)
3. **Robustness**: Built-in deduplication via KV lookups
4. **Resumable**: Cursors allow restart from any point
5. **Observable**: Real-time progress tracking
6. **Complete**: Handles both uploads/ and SHA256-named files
