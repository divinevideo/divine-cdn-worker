#!/bin/bash
# ABOUTME: Monitor backfill progress in real-time
# ABOUTME: Shows current stats and estimated completion time

RESULTS_DIR="backfill_results"

while true; do
  clear
  echo "========================================="
  echo "  Backfill Progress Monitor"
  echo "========================================="
  echo ""
  date
  echo ""

  # Count result files
  BATCH_COUNT=$(ls -1 "$RESULTS_DIR"/batch_*.json 2>/dev/null | wc -l | tr -d ' ')

  if [ $BATCH_COUNT -eq 0 ]; then
    echo "No batches processed yet..."
    echo "Waiting for first batch to complete..."
  else
    # Calculate totals
    TOTAL_PROCESSED=0
    TOTAL_BACKFILLED=0
    TOTAL_ALREADY=0
    TOTAL_ERRORS=0

    for result_file in "$RESULTS_DIR"/batch_*.json; do
      if [ -f "$result_file" ] && [ -s "$result_file" ]; then
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

    echo "Batches completed: $BATCH_COUNT"
    echo ""
    echo "Videos processed:   $TOTAL_PROCESSED / 190,632"
    echo "Newly queued:       $TOTAL_BACKFILLED"
    echo "Already done:       $TOTAL_ALREADY"
    echo "Errors:             $TOTAL_ERRORS"
    echo ""

    # Progress bar
    PERCENT=$((TOTAL_PROCESSED * 100 / 190632))
    BARS=$((PERCENT / 2))
    echo -n "Progress: ["
    for i in $(seq 1 $BARS); do echo -n "="; done
    for i in $(seq $BARS 50); do echo -n " "; done
    echo "] ${PERCENT}%"
    echo ""

    # ETA
    if [ -f backfill_parallel.log ]; then
      echo "Recent waves:"
      tail -5 backfill_parallel.log
    fi
  fi

  echo ""
  echo "========================================="
  echo "Press Ctrl+C to stop monitoring"
  echo "Refreshing in 5 seconds..."

  sleep 5
done
