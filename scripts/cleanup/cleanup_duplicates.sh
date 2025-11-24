#!/bin/bash
# ABOUTME: Cleanup duplicate videos in BunnyStream
# ABOUTME: Finds videos with same title prefix and keeps only the most recent one

set -e

BUNNY_API_KEY="${BUNNY_STREAM_ACCESS_KEY}"
LIBRARY_ID="${BUNNY_STREAM_LIBRARY_ID}"

if [ -z "$BUNNY_API_KEY" ] || [ -z "$LIBRARY_ID" ]; then
  echo "Error: BUNNY_STREAM_ACCESS_KEY and BUNNY_STREAM_LIBRARY_ID must be set"
  exit 1
fi

API_URL="https://video.bunnycdn.com/library/${LIBRARY_ID}/videos"
LOG_FILE="cleanup_duplicates.log"
DRY_RUN="${1:-true}"  # Default to dry run, pass "false" to actually delete

echo "==========================================" | tee "$LOG_FILE"
echo "BUNNYSTREAM DUPLICATE CLEANUP" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"
echo "Library ID: $LIBRARY_ID" | tee -a "$LOG_FILE"
echo "Dry run: $DRY_RUN" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Fetch all videos (paginated)
echo "Fetching all videos from BunnyStream..." | tee -a "$LOG_FILE"

PAGE=1
PER_PAGE=100
ALL_VIDEOS="all_videos.json"
echo "[]" > "$ALL_VIDEOS"

while true; do
  echo "  Fetching page $PAGE..." | tee -a "$LOG_FILE"

  RESPONSE=$(curl -s -X GET "${API_URL}?page=${PAGE}&itemsPerPage=${PER_PAGE}" \
    -H "AccessKey: ${BUNNY_API_KEY}")

  # Extract videos from response
  VIDEOS=$(echo "$RESPONSE" | jq -r '.items // []')
  VIDEO_COUNT=$(echo "$VIDEOS" | jq 'length')

  if [ "$VIDEO_COUNT" -eq 0 ]; then
    echo "  No more videos. Done fetching." | tee -a "$LOG_FILE"
    break
  fi

  echo "  Found $VIDEO_COUNT videos on page $PAGE" | tee -a "$LOG_FILE"

  # Append to all videos
  jq -s '.[0] + .[1]' "$ALL_VIDEOS" <(echo "$VIDEOS") > "${ALL_VIDEOS}.tmp"
  mv "${ALL_VIDEOS}.tmp" "$ALL_VIDEOS"

  PAGE=$((PAGE + 1))

  # Safety limit
  if [ $PAGE -gt 100 ]; then
    echo "  Reached page limit (100). Stopping." | tee -a "$LOG_FILE"
    break
  fi
done

TOTAL_VIDEOS=$(jq 'length' "$ALL_VIDEOS")
echo "" | tee -a "$LOG_FILE"
echo "Total videos fetched: $TOTAL_VIDEOS" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Find duplicates by grouping by title
echo "Analyzing duplicates..." | tee -a "$LOG_FILE"

# Group videos by title (first 16 chars = "Video {sha256 prefix}")
jq -r '
  group_by(.title) |
  map(select(length > 1)) |
  .[]
' "$ALL_VIDEOS" > duplicates_grouped.json

DUPLICATE_GROUPS=$(jq -s 'length' duplicates_grouped.json)
echo "Found $DUPLICATE_GROUPS groups with duplicates" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

if [ "$DUPLICATE_GROUPS" -eq 0 ]; then
  echo "No duplicates found! Exiting." | tee -a "$LOG_FILE"
  exit 0
fi

# For each duplicate group, keep the most recent and delete the rest
TOTAL_TO_DELETE=0
DELETED_COUNT=0

jq -c '.[]' duplicates_grouped.json | while read -r group; do
  TITLE=$(echo "$group" | jq -r '.[0].title')
  COUNT=$(echo "$group" | jq 'length')

  echo "Group: $TITLE ($COUNT duplicates)" | tee -a "$LOG_FILE"

  # Sort by dateUploaded descending, keep first (newest), delete rest
  TO_DELETE=$(echo "$group" | jq -r '
    sort_by(.dateUploaded) |
    reverse |
    .[1:] |
    .[] |
    .guid
  ')

  DELETE_COUNT=$(echo "$TO_DELETE" | wc -l | tr -d ' ')
  TOTAL_TO_DELETE=$((TOTAL_TO_DELETE + DELETE_COUNT))

  if [ "$DRY_RUN" = "true" ]; then
    echo "  [DRY RUN] Would delete $DELETE_COUNT duplicates" | tee -a "$LOG_FILE"
  else
    echo "  Deleting $DELETE_COUNT duplicates..." | tee -a "$LOG_FILE"

    while IFS= read -r video_id; do
      if [ -n "$video_id" ]; then
        echo "    Deleting video: $video_id" >> "$LOG_FILE"

        DELETE_RESPONSE=$(curl -s -X DELETE \
          "${API_URL}/${video_id}" \
          -H "AccessKey: ${BUNNY_API_KEY}")

        if [ $? -eq 0 ]; then
          DELETED_COUNT=$((DELETED_COUNT + 1))
          echo "    ✓ Deleted $video_id" >> "$LOG_FILE"
        else
          echo "    ✗ Failed to delete $video_id" | tee -a "$LOG_FILE"
        fi

        # Rate limit: small delay between deletes
        sleep 0.1
      fi
    done <<< "$TO_DELETE"
  fi
done

echo "" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"
echo "CLEANUP SUMMARY" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"
echo "Total videos: $TOTAL_VIDEOS" | tee -a "$LOG_FILE"
echo "Duplicate groups: $DUPLICATE_GROUPS" | tee -a "$LOG_FILE"
echo "Videos to delete: $TOTAL_TO_DELETE" | tee -a "$LOG_FILE"

if [ "$DRY_RUN" = "true" ]; then
  echo "" | tee -a "$LOG_FILE"
  echo "DRY RUN COMPLETE - No videos were deleted" | tee -a "$LOG_FILE"
  echo "To actually delete duplicates, run: ./cleanup_duplicates.sh false" | tee -a "$LOG_FILE"
else
  echo "Videos deleted: $DELETED_COUNT" | tee -a "$LOG_FILE"
fi

echo "" | tee -a "$LOG_FILE"
