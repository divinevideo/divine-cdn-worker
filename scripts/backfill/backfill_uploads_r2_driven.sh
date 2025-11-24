#!/bin/bash
# ABOUTME: R2-driven backfill for uploads/ files - bypasses BunnyStream pagination issues
# ABOUTME: Uses cursor-based pagination to process all 152k videos without OFFSET limits

set -euo pipefail

ENDPOINT="${1:-https://blossom.divine.video/backfill-batch}"
BATCH_SIZE="${2:-100}"
MAX_BATCHES="${3:-99999}"
CURSOR_FILE="backfill_cursor.txt"

echo "============================================="
echo "R2-Driven Uploads Backfill"
echo "============================================="
echo "Endpoint: $ENDPOINT"
echo "Batch size: $BATCH_SIZE videos per request"
echo "Max batches: $MAX_BATCHES"
echo ""

# Load saved cursor if it exists (resume from last position)
if [ -f "$CURSOR_FILE" ]; then
  CURSOR=$(cat "$CURSOR_FILE")
  echo "Resuming from saved cursor ($(echo "$CURSOR" | head -c 50)...)"
else
  CURSOR=""
  echo "Starting from beginning (no saved cursor)"
fi
echo ""

BATCH_NUM=0
TOTAL_PROCESSED=0
TOTAL_BACKFILLED=0
TOTAL_ERRORS=0

START_TIME=$(date +%s)

while [ $BATCH_NUM -lt $MAX_BATCHES ]; do
  BATCH_NUM=$((BATCH_NUM + 1))

  # Build request body
  if [ -z "$CURSOR" ]; then
    BODY="{\"limit\": $BATCH_SIZE, \"prefix\": \"uploads/\", \"skipExisting\": true}"
  else
    BODY="{\"limit\": $BATCH_SIZE, \"prefix\": \"uploads/\", \"cursor\": \"$CURSOR\", \"skipExisting\": true}"
  fi

  echo "Batch $BATCH_NUM: Fetching..."

  # Make request
  RESPONSE=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$BODY")

  # Parse response
  PROCESSED=$(echo "$RESPONSE" | jq -r '.summary.processed // 0')
  NEWLY_BACKFILLED=$(echo "$RESPONSE" | jq -r '.summary.newlyBackfilled // 0')
  ALREADY_BACKFILLED=$(echo "$RESPONSE" | jq -r '.summary.alreadyBackfilled // 0')
  ERRORS=$(echo "$RESPONSE" | jq -r '.summary.errors // 0')
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.pagination.truncated // false')
  NEW_CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.cursor // ""')

  # Update totals
  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_BACKFILLED=$((TOTAL_BACKFILLED + NEWLY_BACKFILLED))
  TOTAL_ERRORS=$((TOTAL_ERRORS + ERRORS))

  # Calculate rate
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $ELAPSED -gt 0 ]; then
    RATE=$(echo "scale=2; $TOTAL_PROCESSED / $ELAPSED" | bc)
  else
    RATE="0"
  fi

  # Log batch results
  echo "Batch $BATCH_NUM: processed=$PROCESSED, new=$NEWLY_BACKFILLED, existing=$ALREADY_BACKFILLED, errors=$ERRORS"

  # Print details for each newly backfilled video
  if [ "$NEWLY_BACKFILLED" -gt 0 ]; then
    echo "$RESPONSE" | jq -r '.results[] | select(.type == "success") |
      "  ✓ \(.key)
    Old: https://cdn.divine.video/\(.key)
    New: https://stream.divine.video/\(.videoId)/playlist.m3u8
    Size: \(.size) bytes
    VideoID: \(.videoId)"'
  fi

  echo "  Totals: processed=$TOTAL_PROCESSED, backfilled=$TOTAL_BACKFILLED, errors=$TOTAL_ERRORS, rate=${RATE}/s"

  # Check if we're done
  if [ "$TRUNCATED" != "true" ]; then
    echo ""
    echo "Reached end of uploads/ files!"
    # Clean up cursor file - we're done!
    rm -f "$CURSOR_FILE"
    break
  fi

  # Update cursor for next batch
  CURSOR="$NEW_CURSOR"

  # Save cursor to file so we can resume from this point
  echo "$CURSOR" > "$CURSOR_FILE"

  # Brief pause to avoid hammering API
  sleep 0.5
done

TOTAL_TIME=$(($(date +%s) - START_TIME))

echo ""
echo "============================================="
echo "Backfill Complete!"
echo "============================================="
echo "Total batches: $BATCH_NUM"
echo "Total processed: $TOTAL_PROCESSED videos"
echo "Total backfilled: $TOTAL_BACKFILLED videos"
echo "Total errors: $TOTAL_ERRORS"
echo "Total time: ${TOTAL_TIME}s"
echo "Average rate: $(echo "scale=2; $TOTAL_PROCESSED / $TOTAL_TIME" | bc) videos/second"
echo "============================================="
