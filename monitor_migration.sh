#!/bin/bash
# Monitor BunnyStream migration progress and validation

echo "=== BunnyStream Migration Monitor ==="
echo ""

while true; do
  clear
  echo "=== BunnyStream Migration Status ==="
  echo "Updated: $(date)"
  echo ""

  # Get BunnyStream stats
  echo "📊 BunnyStream Library Stats:"
  STATS=$(curl -s "https://video.bunnycdn.com/library/515420/statistics" \
    -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c")

  echo "$STATS" | jq '{
    totalVideos: .videoCount,
    totalStorage: (.storageUsed / 1024 / 1024 / 1024 | tostring + " GB"),
    totalBandwidth: (.bandwidth / 1024 / 1024 / 1024 | tostring + " GB")
  }' 2>/dev/null || echo "Could not fetch library stats"

  echo ""
  echo "🎬 Video Status Breakdown:"

  # Get first page to sample status distribution
  VIDEOS=$(curl -s "https://video.bunnycdn.com/library/515420/videos?page=1&itemsPerPage=100" \
    -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c")

  TOTAL=$(echo "$VIDEOS" | jq -r '.totalItems')
  ENCODED=$(echo "$VIDEOS" | jq '[.items[] | select(.status == 4)] | length')
  ENCODING=$(echo "$VIDEOS" | jq '[.items[] | select(.status == 3)] | length')
  UPLOADED=$(echo "$VIDEOS" | jq '[.items[] | select(.status == 2)] | length')
  UPLOADING=$(echo "$VIDEOS" | jq '[.items[] | select(.status == 1)] | length')
  FAILED=$(echo "$VIDEOS" | jq '[.items[] | select(.status == 5 or .status == 6)] | length')

  echo "  Total videos: $TOTAL"
  echo "  ✅ Encoded (status 4): ~$ENCODED on page 1"
  echo "  🔄 Encoding (status 3): ~$ENCODING on page 1"
  echo "  📤 Uploaded (status 2): ~$UPLOADED on page 1"
  echo "  ⬆️  Uploading (status 1): ~$UPLOADING on page 1"
  echo "  ❌ Failed (status 5/6): ~$FAILED on page 1"

  echo ""
  echo "💾 R2 Storage:"
  echo "  Total Vine archive: ~190,000 files"
  echo "  Estimated valid videos: ~165,000"
  echo "  Estimated avatars/non-videos: ~25,000"

  echo ""
  echo "Press Ctrl+C to exit. Refreshing in 10 seconds..."
  sleep 10
done
