#!/bin/bash
# Debug exactly what's happening with the stuck batch

echo "Making the exact same call the stuck script is making..."
echo ""

RESULT=$(curl -s -X POST 'https://blossom.divine.video/backfill-batch' \
  -H 'Content-Type: application/json' \
  -d '{"limit": 50, "skipExisting": true}')

echo "Full API Response:"
echo "$RESULT" | jq '.'
echo ""

echo "Summary:"
echo "$RESULT" | jq '{
  processed: .summary.processed,
  alreadyBackfilled: .summary.alreadyBackfilled,
  newlyBackfilled: .summary.newlyBackfilled,
  hasMore: .pagination.truncated,
  videoCount: (.videos | length)
}'
