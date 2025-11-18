#!/bin/bash
# ABOUTME: Parallel backfill - runs multiple batch requests simultaneously
# ABOUTME: Much faster than sequential processing by utilizing concurrency

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=50  # Smaller batches for parallel processing
PARALLEL_JOBS=10  # Number of simultaneous requests
CURSOR_FILE="backfill_cursors.txt"
RESULTS_DIR="backfill_results"
LOG_FILE="backfill_parallel.log"

# Create results directory
mkdir -p "$RESULTS_DIR"
rm -f "$CURSOR_FILE"
rm -f "$RESULTS_DIR"/*

echo "========================================" | tee "$LOG_FILE"
echo "Parallel Backfill to BunnyStream" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Batch size: $BATCH_SIZE" | tee -a "$LOG_FILE"
echo "Parallel jobs: $PARALLEL_JOBS" | tee -a "$LOG_FILE"
echo "Target: 190,632 videos" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

START_TIME=$(date +%s)
TOTAL_PROCESSED=0
TOTAL_BACKFILLED=0
TOTAL_ALREADY=0
TOTAL_ERRORS=0

# Function to process a single batch
process_batch() {
  local batch_id=$1
  local cursor=$2
  local result_file="$RESULTS_DIR/batch_${batch_id}.json"

  if [ -z "$cursor" ]; then
    REQUEST="{\"limit\": $BATCH_SIZE}"
  else
    REQUEST="{\"limit\": $BATCH_SIZE, \"cursor\": \"$cursor\"}"
  fi

  # Make request
  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$REQUEST" > "$result_file" 2>&1

  # Extract cursor for next batch if available
  NEXT_CURSOR=$(jq -r '.pagination.cursor // empty' "$result_file" 2>/dev/null)
  if [ -n "$NEXT_CURSOR" ]; then
    echo "$NEXT_CURSOR" >> "$CURSOR_FILE"
  fi
}

# Start with initial batches
echo "Launching initial $PARALLEL_JOBS batches..." | tee -a "$LOG_FILE"

# First batch to get initial cursor
process_batch 0 ""
sleep 1

BATCH_NUM=1
WAVE_NUM=1

# Main processing loop
while true; do
  # Count pending cursors
  if [ -f "$CURSOR_FILE" ]; then
    CURSOR_COUNT=$(wc -l < "$CURSOR_FILE" | tr -d ' ')
  else
    CURSOR_COUNT=0
  fi

  # If no more cursors and no jobs running, we're done
  RUNNING_JOBS=$(jobs -r | wc -l | tr -d ' ')

  if [ $CURSOR_COUNT -eq 0 ] && [ $RUNNING_JOBS -eq 0 ]; then
    echo "No more batches to process!" | tee -a "$LOG_FILE"
    break
  fi

  # Launch parallel jobs
  JOBS_LAUNCHED=0
  while [ $JOBS_LAUNCHED -lt $PARALLEL_JOBS ] && [ $CURSOR_COUNT -gt 0 ]; do
    # Get next cursor
    CURSOR=$(head -1 "$CURSOR_FILE" 2>/dev/null)

    if [ -z "$CURSOR" ]; then
      break
    fi

    # Remove this cursor from file
    tail -n +2 "$CURSOR_FILE" > "$CURSOR_FILE.tmp" 2>/dev/null
    mv "$CURSOR_FILE.tmp" "$CURSOR_FILE" 2>/dev/null

    # Launch batch in background
    process_batch $BATCH_NUM "$CURSOR" &

    BATCH_NUM=$((BATCH_NUM + 1))
    JOBS_LAUNCHED=$((JOBS_LAUNCHED + 1))
    CURSOR_COUNT=$((CURSOR_COUNT - 1))
  done

  # Wait for current wave to complete
  wait

  # Calculate totals from result files
  TOTAL_PROCESSED=0
  TOTAL_BACKFILLED=0
  TOTAL_ALREADY=0
  TOTAL_ERRORS=0

  for result_file in "$RESULTS_DIR"/batch_*.json; do
    if [ -f "$result_file" ]; then
      PROC=$(jq -r '.summary.processed // 0' "$result_file" 2>/dev/null)
      BACK=$(jq -r '.summary.newlyBackfilled // 0' "$result_file" 2>/dev/null)
      ALRE=$(jq -r '.summary.alreadyBackfilled // 0' "$result_file" 2>/dev/null)
      ERRO=$(jq -r '.summary.errors // 0' "$result_file" 2>/dev/null)

      TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROC))
      TOTAL_BACKFILLED=$((TOTAL_BACKFILLED + BACK))
      TOTAL_ALREADY=$((TOTAL_ALREADY + ALRE))
      TOTAL_ERRORS=$((TOTAL_ERRORS + ERRO))
    fi
  done

  # Calculate rate and ETA
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $ELAPSED -gt 0 ] && [ $TOTAL_PROCESSED -gt 0 ]; then
    RATE=$((TOTAL_PROCESSED / ELAPSED))
    REMAINING=$((190632 - TOTAL_PROCESSED))
    if [ $RATE -gt 0 ]; then
      ETA_SECONDS=$((REMAINING / RATE))
      ETA_MINUTES=$((ETA_SECONDS / 60))
    else
      ETA_MINUTES=999
    fi
  else
    RATE=0
    ETA_MINUTES=999
  fi

  echo "Wave $WAVE_NUM complete: Processed $TOTAL_PROCESSED / 190632 | ${RATE}/sec | ETA: ${ETA_MINUTES} min" | tee -a "$LOG_FILE"

  WAVE_NUM=$((WAVE_NUM + 1))

  # Brief pause before next wave
  sleep 1
done

echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "FINAL SUMMARY" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Total videos processed:    $TOTAL_PROCESSED" | tee -a "$LOG_FILE"
echo "Newly backfilled:          $TOTAL_BACKFILLED" | tee -a "$LOG_FILE"
echo "Already backfilled:        $TOTAL_ALREADY" | tee -a "$LOG_FILE"
echo "Errors:                    $TOTAL_ERRORS" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "Time elapsed: $((ELAPSED / 60)) minutes" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "All videos are queued for encoding in BunnyStream!" | tee -a "$LOG_FILE"
