#!/bin/bash
# ABOUTME: Continuous backfill that fires batches as fast as possible
# ABOUTME: Uses xargs for simple parallelization

ENDPOINT="https://blossom.divine.video/backfill-batch"
BATCH_SIZE=75  # Larger batches = fewer requests
MAX_PARALLEL=20
RESULTS_DIR="backfill_continuous_results"

mkdir -p "$RESULTS_DIR"

echo "========================================"
echo "Continuous Backfill to BunnyStream"
echo "========================================"
echo "Batch size: $BATCH_SIZE"
echo "Parallel jobs: $MAX_PARALLEL"
echo ""

# First, get initial cursor
echo "Getting initial batch..."
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "{\"limit\": $BATCH_SIZE, \"skipExisting\": false}" \
  > "$RESULTS_DIR/batch_0.json"

CURSOR=$(jq -r '.pagination.cursor // empty' "$RESULTS_DIR/batch_0.json")
PROCESSED=$(jq -r '.summary.newlyBackfilled // 0' "$RESULTS_DIR/batch_0.json")

echo "Batch 0: $PROCESSED videos queued"
echo ""

if [ -z "$CURSOR" ]; then
  echo "No more videos to process!"
  exit 0
fi

# Create a function to process one batch
process_one() {
  local batch_num=$1
  local cursor=$2
  local result_file="$RESULTS_DIR/batch_${batch_num}.json"

  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"limit\": $BATCH_SIZE, \"cursor\": \"$cursor\", \"skipExisting\": false}" \
    > "$result_file"

  local queued=$(jq -r '.summary.newlyBackfilled // 0' "$result_file")
  local next_cursor=$(jq -r '.pagination.cursor // empty' "$result_file")

  echo "Batch $batch_num: $queued videos queued"

  # Return next cursor
  echo "$next_cursor"
}

export -f process_one
export ENDPOINT BATCH_SIZE RESULTS_DIR

# Now loop, firing batches continuously
BATCH_NUM=1

while [ -n "$CURSOR" ]; do
  # Fire a wave of parallel batches
  BATCH_START=$BATCH_NUM
  BATCH_END=$((BATCH_START + MAX_PARALLEL - 1))

  echo ""
  echo "Launching batches $BATCH_START to $BATCH_END..."

  # Process batches in parallel using xargs
  for i in $(seq $BATCH_START $BATCH_END); do
    echo "$i $CURSOR"
  done | xargs -n 2 -P $MAX_PARALLEL bash -c 'process_one "$@"' bash

  BATCH_NUM=$((BATCH_END + 1))

  # Get cursor from last batch
  if [ -f "$RESULTS_DIR/batch_$BATCH_END.json" ]; then
    CURSOR=$(jq -r '.pagination.cursor // empty' "$RESULTS_DIR/batch_$BATCH_END.json")
  else
    CURSOR=""
  fi

  # Stats
  TOTAL=$(find "$RESULTS_DIR" -name "batch_*.json" -exec jq -r '.summary.newlyBackfilled // 0' {} \; | awk '{s+=$1} END {print s}')
  echo ""
  echo "Total queued so far: $TOTAL / 190,632"
  echo ""
done

echo ""
echo "========================================"
echo "ALL BATCHES COMPLETE!"
echo "========================================"
TOTAL=$(find "$RESULTS_DIR" -name "batch_*.json" -exec jq -r '.summary.newlyBackfilled // 0' {} \; | awk '{s+=$1} END {print s}')
echo "Total videos queued: $TOTAL"
echo ""
echo "BunnyStream will continue encoding over the next several hours."
