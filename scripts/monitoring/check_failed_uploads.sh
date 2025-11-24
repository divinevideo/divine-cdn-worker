#!/bin/bash
# ABOUTME: Check BunnyStream for failed uploads and get error details
# ABOUTME: Helps diagnose why uploads are failing

BUNNY_API_KEY="5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c"
LIBRARY_ID="515420"

echo "Fetching failed uploads from BunnyStream..."
curl -s "https://video.bunnycdn.com/library/${LIBRARY_ID}/videos?page=1&itemsPerPage=10&orderBy=date" \
  -H "AccessKey: ${BUNNY_API_KEY}" | \
  jq '.items[] | select(.length == 0 or .status == 5) | {guid, title, status, length, hasErrors}'
