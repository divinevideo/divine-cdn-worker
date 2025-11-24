#!/bin/bash
# ABOUTME: Incremental duplicate cleanup - processes BunnyStream videos page by page
# ABOUTME: Deletes duplicates without fetching all videos at once

set -e

BUNNY_API_KEY="${BUNNY_STREAM_ACCESS_KEY}"
LIBRARY_ID="${BUNNY_STREAM_LIBRARY_ID}"

if [ -z "$BUNNY_API_KEY" ] || [ -z "$LIBRARY_ID" ]; then
  echo "Error: BUNNY_STREAM_ACCESS_KEY and BUNNY_STREAM_LIBRARY_ID must be set"
  exit 1
fi

API_URL="https://video.bunnycdn.com/library/${LIBRARY_ID}/videos"
DRY_RUN="${1:-true}"  # Default to dry run

echo "=========================================="
echo "INCREMENTAL DUPLICATE CLEANUP"
echo "=========================================="
echo "Dry run: $DRY_RUN"
echo "Strategy: Process page by page, delete duplicates immediately"
echo ""

TOTAL_DELETED=0
PAGE=1
PER_PAGE=100

# Track videos we've seen by title
SEEN_FILE="seen_videos.txt"
> "$SEEN_FILE"  # Clear file

while true; do
  echo "Processing page $PAGE..."

  # Fetch one page
  RESPONSE=$(curl -s -X GET "${API_URL}?page=${PAGE}&itemsPerPage=${PER_PAGE}" \
    -H "AccessKey: ${BUNNY_API_KEY}")

  # Extract videos
  VIDEOS=$(echo "$RESPONSE" | jq -r '.items // []')
  VIDEO_COUNT=$(echo "$VIDEOS" | jq 'length')

  if [ "$VIDEO_COUNT" -eq 0 ]; then
    echo "No more videos. Done."
    break
  fi

  echo "  Found $VIDEO_COUNT videos on page $PAGE"

  # Process each video
  echo "$VIDEOS" | jq -c '.[]' | while read -r video; do
    TITLE=$(echo "$video" | jq -r '.title')
    VIDEO_ID=$(echo "$video" | jq -r '.guid')
    DATE=$(echo "$video" | jq -r '.dateUploaded')

    # Check if we've seen this title before
    if grep -q "^${TITLE}$" "$SEEN_FILE" 2>/dev/null; then
      # DUPLICATE! Delete it
      echo "  ⚠️  DUPLICATE: $TITLE ($VIDEO_ID)"

      if [ "$DRY_RUN" = "false" ]; then
        echo "    Deleting..."
        curl -s -X DELETE "${API_URL}/${VIDEO_ID}" \
          -H "AccessKey: ${BUNNY_API_KEY}" > /dev/null

        if [ $? -eq 0 ]; then
          echo "    ✅ Deleted"
          TOTAL_DELETED=$((TOTAL_DELETED + 1))
        else
          echo "    ❌ Delete failed"
        fi

        sleep 0.1  # Rate limit
      else
        echo "    [DRY RUN] Would delete"
        TOTAL_DELETED=$((TOTAL_DELETED + 1))
      fi
    else
      # First time seeing this title - keep it
      echo "$TITLE" >> "$SEEN_FILE"
      echo "  ✓ Keeping: $TITLE ($VIDEO_ID)"
    fi
  done

  PAGE=$((PAGE + 1))

  # Progress update every 5 pages
  if [ $((PAGE % 5)) -eq 0 ]; then
    echo ""
    echo "--- Progress: Processed $((PAGE * PER_PAGE)) videos, deleted $TOTAL_DELETED duplicates ---"
    echo ""
  fi

  # Safety limit
  if [ $PAGE -gt 50 ]; then
    echo "Reached page limit (50). Stopping for safety."
    break
  fi
done

echo ""
echo "=========================================="
echo "CLEANUP SUMMARY"
echo "=========================================="
echo "Pages processed: $PAGE"
echo "Duplicates found: $TOTAL_DELETED"

if [ "$DRY_RUN" = "true" ]; then
  echo ""
  echo "DRY RUN COMPLETE - No videos were deleted"
  echo "To actually delete, run: ./cleanup_duplicates_incremental.sh false"
else
  echo "Duplicates deleted: $TOTAL_DELETED"
fi

rm -f "$SEEN_FILE"
