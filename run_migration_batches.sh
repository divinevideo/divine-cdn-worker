#!/bin/bash
# Run migration in batches with detailed logging

BATCH_SIZE=1000
TOTAL_PROCESSED=0
TOTAL_UPLOADED=0
TOTAL_SKIPPED=0
TOTAL_ERRORS=0
EMPTY_BATCH_COUNT=0
MAX_EMPTY_BATCHES=100  # Allow pushing through large sections of avatars/non-videos

echo "=== Starting Validated Migration ==="
echo "Batch size: $BATCH_SIZE"
echo "Press Ctrl+C to stop"
echo ""

CURSOR=""

while true; do
  echo "========================================"
  echo "Batch starting at $(date)"
  echo ""

  # Build request body
  if [ -z "$CURSOR" ]; then
    REQUEST_BODY="{\"limit\": $BATCH_SIZE, \"skipExisting\": true}"
  else
    REQUEST_BODY="{\"limit\": $BATCH_SIZE, \"skipExisting\": true, \"cursor\": \"$CURSOR\"}"
  fi

  # Run batch
  RESULT=$(curl -s -X POST "https://blossom.divine.video/backfill-batch" \
    -H "Content-Type: application/json" \
    -d "$REQUEST_BODY")

  # DEBUG: Log actual response if parsing fails
  if ! echo "$RESULT" | jq empty 2>/dev/null; then
    echo "❌ API ERROR - Invalid JSON response:"
    echo "$RESULT" | head -20
    echo "Request body was: $REQUEST_BODY"
    break
  fi

  # Parse results
  PROCESSED=$(echo "$RESULT" | jq -r '.summary.processed // 0')
  ALREADY=$(echo "$RESULT" | jq -r '.summary.alreadyBackfilled // 0')
  NEW=$(echo "$RESULT" | jq -r '.summary.newlyBackfilled // 0')
  ERRORS=$(echo "$RESULT" | jq -r '.summary.errors // 0')
  HAS_MORE=$(echo "$RESULT" | jq -r '.pagination.truncated // false')
  NEXT_CURSOR=$(echo "$RESULT" | jq -r '.pagination.cursor // ""')

  # Update totals
  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_UPLOADED=$((TOTAL_UPLOADED + NEW))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + ALREADY))
  TOTAL_ERRORS=$((TOTAL_ERRORS + ERRORS))

  # Track empty batches
  if [ "$PROCESSED" -eq 0 ]; then
    EMPTY_BATCH_COUNT=$((EMPTY_BATCH_COUNT + 1))
    echo "⚠️  Empty batch ($EMPTY_BATCH_COUNT/$MAX_EMPTY_BATCHES) - R2 returned files but all were filtered"
  else
    EMPTY_BATCH_COUNT=0
  fi

  # Display batch results
  echo "Batch Results:"
  echo "  Processed: $PROCESSED"
  echo "  Newly uploaded: $NEW"
  echo "  Already existed: $ALREADY"
  echo "  Errors: $ERRORS"
  echo ""
  echo "Running Totals:"
  echo "  📊 Total processed: $TOTAL_PROCESSED"
  echo "  ✅ Total uploaded: $TOTAL_UPLOADED"
  echo "  ⏭️  Total skipped: $TOTAL_SKIPPED"
  echo "  ❌ Total errors: $TOTAL_ERRORS"
  echo ""

  # Check for too many consecutive empty batches
  if [ "$EMPTY_BATCH_COUNT" -ge "$MAX_EMPTY_BATCHES" ]; then
    echo "⚠️  Stopping: $MAX_EMPTY_BATCHES consecutive empty batches (likely hit end of valid videos)"
    echo "   This is normal - remaining files in R2 are likely avatars/non-videos being filtered out"
    break
  fi

  # Check if there are more
  if [ "$HAS_MORE" != "true" ]; then
    echo "✅ Migration complete! No more videos to process."
    break
  fi

  # Update cursor for next batch
  CURSOR="$NEXT_CURSOR"

  echo "More videos available. Continuing..."
  echo ""
done

echo ""
echo "========================================"
echo "=== Migration Complete ==="
echo "  Total files examined: $TOTAL_PROCESSED"
echo "  Successfully uploaded: $TOTAL_UPLOADED"
echo "  Skipped (already exist): $TOTAL_SKIPPED"
echo "  Errors: $TOTAL_ERRORS"
echo "========================================"
