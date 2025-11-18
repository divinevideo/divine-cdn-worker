#!/bin/bash
# Generate a spot-check list of backfilled videos with old and new URLs

echo "Spot Check: Small Videos (1KB-50KB) Backfilled to BunnyStream"
echo "=============================================================="
echo ""

# Get a sample of small videos
curl -s "https://blossom.divine.video/_list_r2?prefix=uploads/&limit=200" | \
  jq -r '.objects[] | select(.size >= 1000 and .size < 50000) | "\(.key)\t\(.size)"' | \
  head -15 | \
  while IFS=$'\t' read -r key size; do
    echo "File: $key"
    echo "Size: $size bytes ($((size / 1024)) KB)"
    echo "R2 Direct URL:"
    echo "  https://cdn.divine.video/$key"
    echo ""

    # Try to get video status via our endpoint
    # Extract potential SHA256 or use tempIdentifier approach
    # For uploads/ files, we need to query by the file path
    shortid=$(echo "$key" | sed 's/.*-//' | sed 's/\.mp4//')

    # The uploads/ files don't have SHA256 in the filename, so we can't easily query them
    # But we can check if they've been backfilled by attempting to backfill them
    echo "BunnyStream Status:"
    STATUS=$(curl -s -X POST "https://blossom.divine.video/backfill-video" \
      -H "Content-Type: application/json" \
      -d "{\"tempIdentifier\": \"$key\"}" 2>/dev/null || echo '{"error":"check_failed"}')

    if echo "$STATUS" | jq -e '.videoId' > /dev/null 2>&1; then
      VIDEO_ID=$(echo "$STATUS" | jq -r '.videoId')
      echo "  Status: Backfilled ✓"
      echo "  Video ID: $VIDEO_ID"
      echo "  HLS Playlist:"
      echo "    https://stream.divine.video/$VIDEO_ID/playlist.m3u8"
      echo "  Thumbnail:"
      echo "    https://stream.divine.video/$VIDEO_ID/thumbnail.jpg"
    elif echo "$STATUS" | jq -e '.error' | grep -q "already_exists" 2>/dev/null; then
      echo "  Status: Already backfilled (in queue or completed)"
    else
      ERROR=$(echo "$STATUS" | jq -r '.error // "unknown"')
      echo "  Status: Not yet backfilled ($ERROR)"
    fi

    echo ""
    echo "---"
    echo ""
  done

echo ""
echo "To test a video, copy the HLS playlist URL into a video player like VLC or"
echo "use: ffplay '<HLS URL>'"
