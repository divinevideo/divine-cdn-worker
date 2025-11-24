#!/bin/bash
# ABOUTME: Backfill videos to BunnyStream using SHA-256 list from Nostr events
# ABOUTME: Processes videos from all_video_shas.txt in batches

ENDPOINT="https://blossom.divine.video/backfill-video"
SHA_FILE="all_video_shas.txt"
BATCH_SIZE=50
TOTAL_PROCESSED=0
TOTAL_BACKFILLED=0
TOTAL_ALREADY_DONE=0
TOTAL_NOT_FOUND=0
TOTAL_ERRORS=0

echo "=========================================="
echo "Backfilling Videos from Nostr List"
echo "=========================================="
echo ""

if [ ! -f "$SHA_FILE" ]; then
  echo "Error: $SHA_FILE not found!"
  echo "Run ./fetch_all_video_shas.sh first to generate the SHA-256 list"
  exit 1
fi

TOTAL_VIDEOS=$(wc -l < "$SHA_FILE" | tr -d ' ')
echo "Total videos to process: $TOTAL_VIDEOS"
echo "Batch size: $BATCH_SIZE"
echo ""

# Process videos in batches
BATCH_NUM=1
BATCH_COUNT=0
BATCH_START_TIME=$(date +%s)

while IFS= read -r sha256; do
  # Skip empty lines
  if [ -z "$sha256" ]; then
    continue
  fi

  TOTAL_PROCESSED=$((TOTAL_PROCESSED + 1))
  BATCH_COUNT=$((BATCH_COUNT + 1))

  # Call backfill API for this video
  RESPONSE=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"sha256\": \"$sha256\"}")

  # Parse response status
  STATUS=$(echo "$RESPONSE" | jq -r '.status // .error // "unknown"')

  case "$STATUS" in
    "processing")
      TOTAL_BACKFILLED=$((TOTAL_BACKFILLED + 1))
      ;;
    "already_backfilled")
      TOTAL_ALREADY_DONE=$((TOTAL_ALREADY_DONE + 1))
      ;;
    "video_not_found")
      TOTAL_NOT_FOUND=$((TOTAL_NOT_FOUND + 1))
      ;;
    *)
      TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
      echo "  Error processing $sha256: $STATUS"
      ;;
  esac

  # Print batch summary every BATCH_SIZE videos
  if [ $BATCH_COUNT -ge $BATCH_SIZE ]; then
    BATCH_END_TIME=$(date +%s)
    BATCH_DURATION=$((BATCH_END_TIME - BATCH_START_TIME))

    echo "Batch #$BATCH_NUM complete ($BATCH_SIZE videos in ${BATCH_DURATION}s)"
    echo "  Progress: $TOTAL_PROCESSED / $TOTAL_VIDEOS"
    echo "  Newly backfilled: $TOTAL_BACKFILLED"
    echo "  Already done: $TOTAL_ALREADY_DONE"
    echo "  Not in R2: $TOTAL_NOT_FOUND"
    echo "  Errors: $TOTAL_ERRORS"
    echo ""

    BATCH_NUM=$((BATCH_NUM + 1))
    BATCH_COUNT=0
    BATCH_START_TIME=$(date +%s)

    # Brief pause between batches
    sleep 2
  fi

done < "$SHA_FILE"

# Print final batch if it wasn't full
if [ $BATCH_COUNT -gt 0 ]; then
  echo "Final batch complete ($BATCH_COUNT videos)"
  echo ""
fi

echo "=========================================="
echo "FINAL SUMMARY"
echo "=========================================="
echo "Total videos processed:    $TOTAL_PROCESSED"
echo "Newly backfilled:          $TOTAL_BACKFILLED"
echo "Already backfilled:        $TOTAL_ALREADY_DONE"
echo "Not found in R2:           $TOTAL_NOT_FOUND"
echo "Errors:                    $TOTAL_ERRORS"
echo ""
echo "Videos are queued for encoding in BunnyStream!"
echo "Encoding takes 30-120 seconds per video."
echo ""
echo "Check status with:"
echo "  curl https://blossom.divine.video/list-backfilled?status=ready"
