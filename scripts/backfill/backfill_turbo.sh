#!/bin/bash
# ABOUTME: Turbo backfill - sequential pagination, max speed, no delays
# ABOUTME: Fires batches as fast as possible with proper cursor handling

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=5  # Small batches to avoid Worker CPU limits
LOG_FILE="backfill_turbo.log"

echo "========================================" | tee "$LOG_FILE"
echo "TURBO BACKFILL - MAXIMUM SPEED" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Strategy: Sequential pagination, fire as fast as possible" | tee -a "$LOG_FILE"
echo "Batch size: $BATCH_SIZE (small to avoid CPU limits)" | tee -a "$LOG_FILE"
echo "Skip existing: YES" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

START_TIME=$(date +%s)
CURSOR=""
BATCH_NUM=0
TOTAL_QUEUED=0
TOTAL_SKIPPED=0

while true; do
  # Build request
  if [ -z "$CURSOR" ]; then
    REQUEST='{"limit": '"$BATCH_SIZE"', "skipExisting": true}'
  else
    REQUEST='{"limit": '"$BATCH_SIZE"', "cursor": "'"$CURSOR"'", "skipExisting": true}'
  fi

  # Fire request (no delay, as fast as possible)
  RESPONSE=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$REQUEST")

  # Parse response
  PROCESSED=$(echo "$RESPONSE" | jq -r '.summary.processed // 0' 2>/dev/null)
  QUEUED=$(echo "$RESPONSE" | jq -r '.summary.newlyBackfilled // 0' 2>/dev/null)
  SKIPPED=$(echo "$RESPONSE" | jq -r '.summary.alreadyBackfilled // 0' 2>/dev/null)
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.pagination.truncated // false' 2>/dev/null)
  NEXT_CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.cursor // empty' 2>/dev/null)

  # Update totals
  BATCH_NUM=$((BATCH_NUM + 1))
  TOTAL_QUEUED=$((TOTAL_QUEUED + QUEUED))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + SKIPPED))

  # Log every batch
  echo "Batch $BATCH_NUM: +$QUEUED queued, $SKIPPED skipped (Total: $TOTAL_QUEUED queued)" >> "$LOG_FILE"

  # Progress report every 10 batches
  if [ $((BATCH_NUM % 10)) -eq 0 ]; then
    ELAPSED=$(($(date +%s) - START_TIME))
    RATE=$((TOTAL_QUEUED / (ELAPSED + 1)))
    echo "--- PROGRESS: $BATCH_NUM batches | $TOTAL_QUEUED videos queued | ${ELAPSED}s elapsed | ${RATE}/sec ---" | tee -a "$LOG_FILE"
  fi

  # Check if we're done
  if [ "$TRUNCATED" != "true" ] || [ -z "$NEXT_CURSOR" ]; then
    echo "" | tee -a "$LOG_FILE"
    echo "Pagination complete! No more videos to process." | tee -a "$LOG_FILE"
    break
  fi

  # Update cursor for next batch
  CURSOR="$NEXT_CURSOR"

  # Safety limit
  if [ $BATCH_NUM -ge 1000 ]; then
    echo "" | tee -a "$LOG_FILE"
    echo "Reached safety limit (1000 batches). Stopping." | tee -a "$LOG_FILE"
    break
  fi
done

ELAPSED=$(($(date +%s) - START_TIME))
RATE=$((TOTAL_QUEUED / (ELAPSED + 1)))

echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "BACKFILL COMPLETE" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Total batches: $BATCH_NUM" | tee -a "$LOG_FILE"
echo "Videos queued: $TOTAL_QUEUED" | tee -a "$LOG_FILE"
echo "Videos skipped (already backfilled): $TOTAL_SKIPPED" | tee -a "$LOG_FILE"
echo "Time elapsed: $((ELAPSED / 60))m ${ELAPSED % 60}s" | tee -a "$LOG_FILE"
echo "Average rate: ${RATE} videos/sec" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "All videos queued to BunnyStream!" | tee -a "$LOG_FILE"
echo "Encoding will continue over the next several hours." | tee -a "$LOG_FILE"
