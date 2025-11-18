#!/bin/bash
# Clean up all duplicates in BunnyStream by calling Worker endpoint

PAGE=1
TOTAL_DELETED=0

while true; do
  echo "Processing page $PAGE..."

  RESULT=$(curl -s -X POST "https://blossom.divine.video/cleanup-duplicates" \
    -H "Content-Type: application/json" \
    -d "{\"page\": $PAGE, \"dryRun\": false}")

  echo "$RESULT" | jq '.'

  DELETED=$(echo "$RESULT" | jq -r '.deleted // 0')
  HAS_MORE=$(echo "$RESULT" | jq -r '.hasMore // false')

  TOTAL_DELETED=$((TOTAL_DELETED + DELETED))
  echo "Deleted on this page: $DELETED"
  echo "Total deleted so far: $TOTAL_DELETED"
  echo ""

  if [ "$HAS_MORE" = "false" ]; then
    echo "No more pages. Cleanup complete!"
    echo "Total duplicates deleted: $TOTAL_DELETED"
    break
  fi

  PAGE=$((PAGE + 1))
  sleep 2  # Rate limiting
done
