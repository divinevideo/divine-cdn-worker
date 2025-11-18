#!/bin/bash
# Check success vs failure rate in BunnyStream

BUNNY_API_KEY="5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c"
LIBRARY_ID="515420"

echo "Checking BunnyStream upload success rate..."
curl -s "https://video.bunnycdn.com/library/${LIBRARY_ID}/videos?page=1&itemsPerPage=100&orderBy=date" \
  -H "AccessKey: ${BUNNY_API_KEY}" | \
  jq '{
    total: (.items | length),
    successful: ([.items[] | select(.length > 0)] | length),
    failed: ([.items[] | select(.length == 0)] | length),
    status_breakdown: ([.items[] | .status] | group_by(.) | map({status: .[0], count: length}))
  }'
