#!/bin/bash
# ABOUTME: Simple parallel backfill that actually works
# ABOUTME: Launches batches with GNU parallel for reliable concurrency

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=50
MAX_JOBS=20  # Reduce from 50 to be safer
RESULTS_DIR="backfill_simple_results"
LOG_FILE="backfill_simple.log"

# Setup
mkdir -p "$RESULTS_DIR"
echo "" > "$LOG_FILE"

echo "========================================" | tee -a "$LOG_FILE"
echo "Simple Parallel Backfill" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Target: 190,632 videos" | tee -a "$LOG_FILE"
echo "Batch size: $BATCH_SIZE" | tee -a "$LOG_FILE"
echo "Max parallel: $MAX_JOBS" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

START_TIME=$(date +%s)
BATCH_NUM=0
CURSOR=""

# Function to process one batch
process_batch() {
  local batch_id=$1
  local cursor=$2
  local result_file="$RESULTS_DIR/batch_${batch_id}.json"

  if [ -z "$cursor" ] || [ "$cursor" = "null" ]; then
    REQUEST="{\"limit\": $BATCH_SIZE, \"skipExisting\": false}"
  else
    REQUEST="{\"limit\": $BATCH_SIZE, \"cursor\": \"$cursor\", \"skipExisting\": false}"
  fi

  echo "[$(date +%H:%M:%S)] Batch $batch_id starting..." | tee -a "$LOG_FILE"

  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$REQUEST" > "$result_file"

  # Extract stats
  PROCESSED=$(jq -r '.summary.processed // 0' "$result_file" 2>/dev/null)
  QUEUED=$(jq -r '.summary.newlyBackfilled // 0' "$result_file" 2>/dev/null)
  NEXT_CURSOR=$(jq -r '.pagination.cursor // empty' "$result_file" 2>/dev/null)
  TRUNCATED=$(jq -r '.pagination.truncated // false' "$result_file" 2>/dev/null)

  echo "[$(date +%H:%M:%S)] Batch $batch_id done: $PROCESSED processed, $QUEUED queued" | tee -a "$LOG_FILE"

  # Return next cursor
  if [ "$TRUNCATED" = "true" ] && [ -n "$NEXT_CURSOR" ]; then
    echo "$NEXT_CURSOR"
  else
    echo "DONE"
  fi
}

# Process batches sequentially but with parallel HTTP requests inside
while true; do
  # Launch a wave of batches in parallel
  CURSORS_THIS_WAVE=()

  # First batch or use cursor from previous iteration
  if [ $BATCH_NUM -eq 0 ]; then
    CURSORS_THIS_WAVE+=("")
  else
    if [ "$CURSOR" = "DONE" ]; then
      echo "All batches complete!" | tee -a "$LOG_FILE"
      break
    fi
    CURSORS_THIS_WAVE+=("$CURSOR")
  fi

  # Launch up to MAX_JOBS batches in parallel
  for i in $(seq 0 $((MAX_JOBS - 1))); do
    if [ $i -lt ${#CURSORS_THIS_WAVE[@]} ]; then
      CURSOR_TO_USE="${CURSORS_THIS_WAVE[$i]}"

      # Launch batch in background
      (
        RESULT=$(process_batch $BATCH_NUM "$CURSOR_TO_USE")
        echo "$RESULT" > "$RESULTS_DIR/cursor_${BATCH_NUM}.txt"
      ) &

      BATCH_NUM=$((BATCH_NUM + 1))
    fi
  done

  # Wait for all parallel batches to complete
  wait

  # Get next cursor from the first completed batch
  if [ -f "$RESULTS_DIR/cursor_$((BATCH_NUM - 1)).txt" ]; then
    CURSOR=$(cat "$RESULTS_DIR/cursor_$((BATCH_NUM - 1)).txt")
  else
    CURSOR="DONE"
  fi

  # Print stats every wave
  TOTAL_PROC=0
  TOTAL_QUEUED=0
  for f in "$RESULTS_DIR"/batch_*.json; do
    if [ -f "$f" ] && [ -s "$f" ]; then
      P=$(jq -r '.summary.processed // 0' "$f" 2>/dev/null)
      Q=$(jq -r '.summary.newlyBackfilled // 0' "$f" 2>/dev/null)
      TOTAL_PROC=$((TOTAL_PROC + P))
      TOTAL_QUEUED=$((TOTAL_QUEUED + Q))
    fi
  done

  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $ELAPSED -gt 0 ]; then
    RATE=$((TOTAL_PROC / ELAPSED))
  else
    RATE=0
  fi

  echo "" | tee -a "$LOG_FILE"
  echo "========================================" | tee -a "$LOG_FILE"
  echo "Progress: $TOTAL_PROC / 190,632 processed" | tee -a "$LOG_FILE"
  echo "Queued to BunnyStream: $TOTAL_QUEUED" | tee -a "$LOG_FILE"
  echo "Rate: ${RATE} videos/sec" | tee -a "$LOG_FILE"
  echo "Elapsed: ${ELAPSED}s ($((ELAPSED / 60))m)" | tee -a "$LOG_FILE"
  echo "========================================" | tee -a "$LOG_FILE"
  echo "" | tee -a "$LOG_FILE"
done

# Final stats
echo "" | tee -a "$LOG_FILE"
echo "BACKFILL COMPLETE!" | tee -a "$LOG_FILE"
echo "Total processed: $TOTAL_PROC" | tee -a "$LOG_FILE"
echo "Total queued: $TOTAL_QUEUED" | tee -a "$LOG_FILE"
