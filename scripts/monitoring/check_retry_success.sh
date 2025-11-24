#!/bin/bash
VIDEO_ID="f88a5c2e-6d58-4953-9912-015888b4725d"

echo "Checking if retry succeeded after 60 seconds..."
sleep 60

curl -s "https://video.bunnycdn.com/library/515420/videos/${VIDEO_ID}" \
  -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c" | \
  jq '{status, length, storageSize, availableResolutions}'
