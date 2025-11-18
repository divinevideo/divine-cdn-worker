#!/bin/bash
FAILED_ID="3b28f62c-f35e-46c1-ab1d-0792c617ff09"
curl -s "https://video.bunnycdn.com/library/515420/videos/${FAILED_ID}" \
  -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c" | \
  jq '{status, length, storageSize, encodeProgress, hasErrors, width, height, averageWatchTime}'
