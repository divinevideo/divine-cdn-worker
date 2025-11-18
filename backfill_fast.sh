#!/bin/bash
# ABOUTME: Fast sequential backfill - fires batches as quickly as possible
# ABOUTME: No complex parallelization, just maximum speed through pagination

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=10
RESULTS_DIR="backfill_fast_results"
LOG_FILE="backfill_fast.log"

mkdir -p "$RESULTS_DIR"
echo "" > "$LOG_FILE"

START_TIME=$(date +%s)

echo "========================================" | tee -a "$LOG_FILE"
echo "Fast Sequential Backfill" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Target: 190,632 videos" | tee -a "$LOG_FILE"
echo "Batch size: $BATCH_SIZE" | tee -a "$LOG_FILE"
echo "Strategy: Fire batches as fast as possible" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

BATCH_NUM=0
CURSOR=""
TOTAL_PROCESSED=0
TOTAL_QUEUED=0

while true; do
  RESULT_FILE="$RESULTS_DIR/batch_${BATCH_NUM}.json"

  # Build request
  if [ -z "$CURSOR" ]; then
    REQUEST="{\"limit\": $BATCH_SIZE, \"skipExisting\": false}"
  else
    REQUEST="{\"limit\": $BATCH_SIZE, \"cursor\": \"$CURSOR\", \"skipExisting\": false}"
  fi

  # Fire batch
  echo -n "Batch $BATCH_NUM: " | tee -a "$LOG_FILE"
  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$REQUEST" > "$RESULT_FILE"

  # Parse response
  PROCESSED=$(jq -r '.summary.processed // 0' "$RESULT_FILE" 2>/dev/null)
  QUEUED=$(jq -r '.summary.newlyBackfilled // 0' "$RESULT_FILE" 2>/dev/null)
  NEXT_CURSOR=$(jq -r '.pagination.cursor // empty' "$RESULT_FILE" 2>/dev/null)
  TRUNCATED=$(jq -r '.pagination.truncated // false' "$RESULT_FILE" 2>/dev/null)

  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_QUEUED=$((TOTAL_QUEUED + QUEUED))

  echo "$QUEUED videos queued (total: $TOTAL_QUEUED / 190,632)" | tee -a "$LOG_FILE"

  # Check if done
  if [ "$TRUNCATED" = "false" ] || [ -z "$NEXT_CURSOR" ]; then
    echo "" | tee -a "$LOG_FILE"
    echo "Pagination complete!" | tee -a "$LOG_FILE"
    break
  fi

  # Update cursor for next iteration
  CURSOR="$NEXT_CURSOR"
  BATCH_NUM=$((BATCH_NUM + 1))

  # Progress update every 10 batches
  if [ $((BATCH_NUM % 10)) -eq 0 ]; then
    ELAPSED=$(($(date +%s) - START_TIME))
    if [ $ELAPSED -gt 0 ]; then
      RATE=$((TOTAL_PROCESSED / ELAPSED))
    else
      RATE=0
    fi

    echo "" | tee -a "$LOG_FILE"
    echo "--- Progress ---" | tee -a "$LOG_FILE"
    echo "Batches: $BATCH_NUM" | tee -a "$LOG_FILE"
    echo "Processed: $TOTAL_PROCESSED" | tee -a "$LOG_FILE"
    echo "Queued: $TOTAL_QUEUED" | tee -a "$LOG_FILE"
    echo "Rate: ${RATE} videos/sec" | tee -a "$LOG_FILE"
    echo "Elapsed: ${ELAPSED}s ($((ELAPSED / 60))m)" | tee -a "$LOG_FILE"
    echo "" | tee -a "$LOG_FILE"
  fi
done

# Final stats
ELAPSED=$(($(date +%s) - START_TIME))

echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "BACKFILL COMPLETE!" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Batches processed: $BATCH_NUM" | tee -a "$LOG_FILE"
echo "Videos processed: $TOTAL_PROCESSED" | tee -a "$LOG_FILE"
echo "Videos queued to BunnyStream: $TOTAL_QUEUED" | tee -a "$LOG_FILE"
echo "Time elapsed: ${ELAPSED}s ($((ELAPSED / 60))m)" | tee -a "$LOG_FILE"

if [ $ELAPSED -gt 0 ]; then
  RATE=$((TOTAL_PROCESSED / ELAPSED))
  echo "Average rate: ${RATE} videos/sec" | tee -a "$LOG_FILE"
fi

echo "" | tee -a "$LOG_FILE"
echo "All videos queued to BunnyStream!" | tee -a "$LOG_FILE"
echo "Encoding will continue over the next several hours." | tee -a "$LOG_FILE"
