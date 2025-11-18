#!/bin/bash
# Delete failed video uploads (status 5 and 6) from BunnyStream

echo "Fetching failed videos (status 5 and 6)..."

PAGE=1
TOTAL_DELETED=0

while true; do
  echo "Processing page $PAGE..."

  RESPONSE=$(curl -s "https://video.bunnycdn.com/library/515420/videos?page=$PAGE&itemsPerPage=100" \
    -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c")

  # Get failed video IDs (status 5 or 6)
  FAILED_IDS=$(echo "$RESPONSE" | jq -r '.items[] | select(.status == 5 or .status == 6) | .guid')

  if [ -z "$FAILED_IDS" ]; then
    echo "No more failed videos found."
    break
  fi

  COUNT=0
  for VIDEO_ID in $FAILED_IDS; do
    echo "  Deleting failed video: $VIDEO_ID"
    curl -s -X DELETE "https://video.bunnycdn.com/library/515420/videos/$VIDEO_ID" \
      -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c" > /dev/null
    COUNT=$((COUNT + 1))
    TOTAL_DELETED=$((TOTAL_DELETED + 1))
  done

  echo "  Deleted $COUNT failed videos on page $PAGE"

  # Check if there are more pages
  TOTAL_ITEMS=$(echo "$RESPONSE" | jq -r '.totalItems')
  ITEMS_PER_PAGE=$(echo "$RESPONSE" | jq -r '.itemsPerPage')
  TOTAL_PAGES=$(( (TOTAL_ITEMS + ITEMS_PER_PAGE - 1) / ITEMS_PER_PAGE ))

  if [ $PAGE -ge $TOTAL_PAGES ]; then
    break
  fi

  PAGE=$((PAGE + 1))
  sleep 1
done

echo ""
echo "===================="
echo "Total failed videos deleted: $TOTAL_DELETED"
