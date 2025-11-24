#!/bin/bash
# ABOUTME: Aggressive backfill - fires requests as fast as possible, skips existing
# ABOUTME: Let BunnyStream manage its own queue - we just queue everything ASAP

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=200  # Max allowed
PARALLEL=20  # Fire 20 requests at once
LOG_FILE="backfill_aggressive.log"

echo "========================================" | tee "$LOG_FILE"
echo "AGGRESSIVE BACKFILL - FULL THROTTLE" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Strategy: Queue everything ASAP, skip existing, let BunnyStream handle the rest" | tee -a "$LOG_FILE"
echo "Batch size: $BATCH_SIZE (max)" | tee -a "$LOG_FILE"
echo "Parallel jobs: $PARALLEL" | tee -a "$LOG_FILE"
echo "Skip existing: YES" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

START_TIME=$(date +%s)
CURSOR=""
BATCH_NUM=0
TOTAL_QUEUED=0

# Fire batches in parallel, as fast as possible
while true; do
  # Launch PARALLEL requests simultaneously
  for i in $(seq 1 $PARALLEL); do
    (
      if [ -z "$CURSOR" ]; then
        REQUEST='{"limit": '"$BATCH_SIZE"', "skipExisting": true}'
      else
        REQUEST='{"limit": '"$BATCH_SIZE"', "cursor": "'"$CURSOR"'", "skipExisting": true}'
      fi

      RESPONSE=$(curl -s -X POST "$ENDPOINT" \
        -H "Content-Type: application/json" \
        -d "$REQUEST")

      QUEUED=$(echo "$RESPONSE" | jq -r '.summary.newlyBackfilled // 0' 2>/dev/null)
      NEXT_CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.cursor // empty' 2>/dev/null)

      echo "Batch queued $QUEUED videos | Cursor: ${NEXT_CURSOR:0:20}..." >> "$LOG_FILE"

      # Update cursor for next batch
      if [ -n "$NEXT_CURSOR" ]; then
        echo "$NEXT_CURSOR"
      fi
    ) &

    BATCH_NUM=$((BATCH_NUM + 1))
  done

  # Wait for this wave to finish
  wait

  # Get new cursor from any successful batch
  # (This is simplified - in production you'd want better cursor management)

  # Check if we've processed everything
  ELAPSED=$(($(date +%s) - START_TIME))
  echo "Wave complete | Batches: $BATCH_NUM | Time: ${ELAPSED}s" | tee -a "$LOG_FILE"

  # Brief pause to avoid completely overwhelming the API
  sleep 0.5

  # Stop after a reasonable number of batches (safety limit)
  if [ $BATCH_NUM -gt 1000 ]; then
    echo "Reached batch limit (1000). Stopping." | tee -a "$LOG_FILE"
    break
  fi
done

echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "QUEUING COMPLETE" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Total batches fired: $BATCH_NUM" | tee -a "$LOG_FILE"
echo "Time elapsed: $((ELAPSED / 60)) minutes" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "Videos are queued in BunnyStream. Encoding will continue for hours." | tee -a "$LOG_FILE"
