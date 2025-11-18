#!/bin/bash
# Backfill all videos in R2 to BunnyStream

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=75  # Optimized for Worker CPU limits (tested: 100+ times out)
TOTAL_PROCESSED=0
TOTAL_BACKFILLED=0
TOTAL_ALREADY_DONE=0
TOTAL_ERRORS=0
CURSOR=""
START_TIME=$(date +%s)

echo "========================================"
echo "Backfilling All Videos to BunnyStream"
echo "========================================"
echo "Batch size: $BATCH_SIZE (optimized)"
echo ""

BATCH_NUM=1

while true; do
  BATCH_START=$(date +%s)

  echo "Batch #$BATCH_NUM (processing up to $BATCH_SIZE videos)..."

  # Build request
  if [ -z "$CURSOR" ]; then
    REQUEST="{\"limit\": $BATCH_SIZE}"
  else
    REQUEST="{\"limit\": $BATCH_SIZE, \"cursor\": \"$CURSOR\"}"
  fi

  # Call API
  RESPONSE=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$REQUEST")

  # Parse response
  PROCESSED=$(echo "$RESPONSE" | jq -r '.summary.processed')
  BACKFILLED=$(echo "$RESPONSE" | jq -r '.summary.newlyBackfilled')
  ALREADY=$(echo "$RESPONSE" | jq -r '.summary.alreadyBackfilled')
  ERRORS=$(echo "$RESPONSE" | jq -r '.summary.errors')
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.pagination.truncated')
  CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.cursor // empty')

  # Update totals
  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_BACKFILLED=$((TOTAL_BACKFILLED + BACKFILLED))
  TOTAL_ALREADY_DONE=$((TOTAL_ALREADY_DONE + ALREADY))
  TOTAL_ERRORS=$((TOTAL_ERRORS + ERRORS))

  BATCH_END=$(date +%s)
  BATCH_DURATION=$((BATCH_END - BATCH_START))
  ELAPSED=$((BATCH_END - START_TIME))

  # Calculate rate and ETA
  if [ $ELAPSED -gt 0 ] && [ $TOTAL_PROCESSED -gt 0 ]; then
    RATE=$((TOTAL_PROCESSED / ELAPSED))
    REMAINING=$((190632 - TOTAL_PROCESSED))
    ETA_SECONDS=$((REMAINING / RATE))
    ETA_MINUTES=$((ETA_SECONDS / 60))
  else
    RATE=0
    ETA_MINUTES=0
  fi

  echo "  Batch: $BACKFILLED queued, $ALREADY skipped, $ERRORS errors (${BATCH_DURATION}s)"
  echo "  Total: $TOTAL_PROCESSED / 190632 videos | ${RATE}/sec | ETA: ${ETA_MINUTES} min"
  echo ""

  # Check if done
  if [ "$TRUNCATED" != "true" ]; then
    echo "✓ All videos processed!"
    break
  fi

  if [ -z "$CURSOR" ]; then
    echo "✗ Error: No cursor returned but truncated=true"
    break
  fi

  BATCH_NUM=$((BATCH_NUM + 1))
  # No sleep delay - process as fast as possible
done

echo ""
echo "========================================"
echo "FINAL SUMMARY"
echo "========================================"
echo "Total videos processed:    $TOTAL_PROCESSED"
echo "Newly backfilled:          $TOTAL_BACKFILLED"
echo "Already backfilled:        $TOTAL_ALREADY_DONE"
echo "Errors:                    $TOTAL_ERRORS"
echo ""
echo "All videos are now queued for encoding in BunnyStream!"
echo "Encoding takes 30-120 seconds per video."
echo ""
echo "Check status with:"
echo "  curl https://blossom.divine.video/list-backfilled?status=ready"
