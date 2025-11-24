#!/bin/bash
# Backfill videos from blobs/ folder (new path that was failing)

ENDPOINT="${1:-https://blossom.divine.video/backfill-batch}"
BATCH_SIZE="${2:-50}"

echo "============================================="
echo "Blobs/ Folder Backfill"
echo "============================================="
echo "Endpoint: $ENDPOINT"
echo "Batch size: $BATCH_SIZE"
echo ""

CURSOR=""
BATCH_NUM=0
TOTAL_PROCESSED=0
TOTAL_BACKFILLED=0

while [ $BATCH_NUM -lt 10 ]; do
  BATCH_NUM=$((BATCH_NUM + 1))

  if [ -z "$CURSOR" ]; then
    BODY="{\"limit\": $BATCH_SIZE, \"prefix\": \"blobs/\", \"skipExisting\": true}"
  else
    BODY="{\"limit\": $BATCH_SIZE, \"prefix\": \"blobs/\", \"cursor\": \"$CURSOR\", \"skipExisting\": true}"
  fi

  echo "Batch $BATCH_NUM: Fetching..."
  
  RESPONSE=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$BODY")

  PROCESSED=$(echo "$RESPONSE" | jq -r '.summary.processed // 0')
  NEWLY_BACKFILLED=$(echo "$RESPONSE" | jq -r '.summary.newlyBackfilled // 0')
  ALREADY_BACKFILLED=$(echo "$RESPONSE" | jq -r '.summary.alreadyBackfilled // 0')
  ERRORS=$(echo "$RESPONSE" | jq -r '.summary.errors // 0')
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.pagination.truncated // false')
  NEW_CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.cursor // ""')

  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_BACKFILLED=$((TOTAL_BACKFILLED + NEWLY_BACKFILLED))

  echo "Batch $BATCH_NUM: processed=$PROCESSED, new=$NEWLY_BACKFILLED, existing=$ALREADY_BACKFILLED, errors=$ERRORS"

  [ "$TRUNCATED" != "true" ] && break
  CURSOR="$NEW_CURSOR"
  
  sleep 0.5
done

echo ""
echo "============================================="
echo "Blobs/ Backfill Complete!"
echo "============================================="
echo "Total processed: $TOTAL_PROCESSED"
echo "Total newly backfilled: $TOTAL_BACKFILLED"
echo "============================================="
