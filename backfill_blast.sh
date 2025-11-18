#!/bin/bash
# ABOUTME: BLAST MODE - Fire requests at BunnyStream as fast as possible
# ABOUTME: Keeps 50 concurrent requests running continuously until all 190k videos are queued

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=50
MAX_PARALLEL=50  # Keep 50 requests running at all times
CURSOR_QUEUE="cursor_queue.txt"
RESULTS_DIR="backfill_blast_results"
LOG_FILE="backfill_blast.log"

# Setup
mkdir -p "$RESULTS_DIR"
rm -rf "$RESULTS_DIR"/*
echo "" > "$CURSOR_QUEUE"
echo "" > "$LOG_FILE"

echo "========================================" | tee -a "$LOG_FILE"
echo "BLAST MODE: Maximum Throughput Backfill" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Target: 190,632 videos" | tee -a "$LOG_FILE"
echo "Batch size: $BATCH_SIZE" | tee -a "$LOG_FILE"
echo "Max parallel: $MAX_PARALLEL" | tee -a "$LOG_FILE"
echo "Strategy: Fire and forget, let BunnyStream handle the queue" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

START_TIME=$(date +%s)
BATCH_NUM=0

# Function to fire a batch request
fire_batch() {
  local batch_id=$1
  local cursor=$2
  local result_file="$RESULTS_DIR/batch_${batch_id}.json"

  if [ -z "$cursor" ] || [ "$cursor" = "null" ]; then
    REQUEST="{\"limit\": $BATCH_SIZE, \"skipExisting\": false}"
  else
    REQUEST="{\"limit\": $BATCH_SIZE, \"cursor\": \"$cursor\", \"skipExisting\": false}"
  fi

  # Fire request and capture result
  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$REQUEST" > "$result_file" 2>&1

  # If there's a cursor, add it to queue
  NEXT_CURSOR=$(jq -r '.pagination.cursor // empty' "$result_file" 2>/dev/null)
  if [ -n "$NEXT_CURSOR" ]; then
    echo "$NEXT_CURSOR" >> "$CURSOR_QUEUE"
  fi

  # Check if done
  TRUNCATED=$(jq -r '.pagination.truncated // false' "$result_file" 2>/dev/null)
  if [ "$TRUNCATED" = "false" ]; then
    echo "DONE" >> "$CURSOR_QUEUE"
  fi
}

# Start first batch
echo "Launching initial batch..." | tee -a "$LOG_FILE"
fire_batch 0 "" &
BATCH_NUM=1

# Main loop: keep MAX_PARALLEL requests running continuously
DONE_FLAG=false

while [ "$DONE_FLAG" = "false" ]; do
  # Count currently running jobs
  RUNNING=$(jobs -r | wc -l | tr -d ' ')

  # If we have capacity, launch more batches
  while [ $RUNNING -lt $MAX_PARALLEL ] && [ "$DONE_FLAG" = "false" ]; do
    # Get next cursor from queue
    if [ -f "$CURSOR_QUEUE" ]; then
      CURSOR=$(head -1 "$CURSOR_QUEUE" 2>/dev/null)

      # Check if we're done
      if [ "$CURSOR" = "DONE" ]; then
        DONE_FLAG=true
        break
      fi

      if [ -n "$CURSOR" ]; then
        # Remove this cursor from queue
        tail -n +2 "$CURSOR_QUEUE" > "${CURSOR_QUEUE}.tmp" 2>/dev/null
        mv "${CURSOR_QUEUE}.tmp" "$CURSOR_QUEUE" 2>/dev/null

        # Fire next batch
        fire_batch $BATCH_NUM "$CURSOR" &
        BATCH_NUM=$((BATCH_NUM + 1))
      fi
    fi

    # Update running count
    RUNNING=$(jobs -r | wc -l | tr -d ' ')

    # Brief pause to avoid spinning
    sleep 0.1
  done

  # Print status every 100 batches
  if [ $((BATCH_NUM % 100)) -eq 0 ]; then
    COMPLETED=$(ls -1 "$RESULTS_DIR"/batch_*.json 2>/dev/null | wc -l | tr -d ' ')

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

    echo "[${ELAPSED}s] Batches: $COMPLETED | Processed: $TOTAL_PROC | Queued: $TOTAL_QUEUED | ${RATE}/sec | Running: $RUNNING" | tee -a "$LOG_FILE"
  fi

  # Small sleep to avoid busy loop
  sleep 0.5
done

# Wait for remaining jobs to finish
echo "Waiting for final batches to complete..." | tee -a "$LOG_FILE"
wait

# Final stats
TOTAL_PROC=0
TOTAL_QUEUED=0
TOTAL_ALREADY=0
TOTAL_ERRORS=0

for f in "$RESULTS_DIR"/batch_*.json; do
  if [ -f "$f" ] && [ -s "$f" ]; then
    P=$(jq -r '.summary.processed // 0' "$f" 2>/dev/null)
    Q=$(jq -r '.summary.newlyBackfilled // 0' "$f" 2>/dev/null)
    A=$(jq -r '.summary.alreadyBackfilled // 0' "$f" 2>/dev/null)
    E=$(jq -r '.summary.errors // 0' "$f" 2>/dev/null)

    TOTAL_PROC=$((TOTAL_PROC + P))
    TOTAL_QUEUED=$((TOTAL_QUEUED + Q))
    TOTAL_ALREADY=$((TOTAL_ALREADY + A))
    TOTAL_ERRORS=$((TOTAL_ERRORS + E))
  fi
done

ELAPSED=$(($(date +%s) - START_TIME))

echo "" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "BLAST COMPLETE!" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "Total processed:   $TOTAL_PROC / 190,632" | tee -a "$LOG_FILE"
echo "Newly queued:      $TOTAL_QUEUED" | tee -a "$LOG_FILE"
echo "Already done:      $TOTAL_ALREADY" | tee -a "$LOG_FILE"
echo "Errors:            $TOTAL_ERRORS" | tee -a "$LOG_FILE"
echo "Time elapsed:      ${ELAPSED} seconds ($((ELAPSED / 60)) minutes)" | tee -a "$LOG_FILE"
echo "Average rate:      $((TOTAL_PROC / ELAPSED)) videos/sec" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "All videos queued to BunnyStream!" | tee -a "$LOG_FILE"
echo "Encoding will continue over next several hours." | tee -a "$LOG_FILE"
