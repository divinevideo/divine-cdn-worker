#!/bin/bash
# Test that successful videos in BunnyStream actually have valid source files

echo "Getting a successful video from BunnyStream..."
SUCCESSFUL=$(curl -s "https://video.bunnycdn.com/library/515420/videos?page=1&itemsPerPage=100" \
  -H "AccessKey: 5dfeb33c-7925-43b2-af0aac23bf02-e7f6-4a9c" | \
  jq -r '[.items[] | select(.length > 0 and .status == 4)] | first | .title')

echo "Found successful video: ${SUCCESSFUL}"
echo ""

echo "Downloading from R2..."
curl -s "https://blossom.divine.video/${SUCCESSFUL}" -o "successful_${SUCCESSFUL:0:16}.mp4"

echo "File info:"
file "successful_${SUCCESSFUL:0:16}.mp4"

echo ""
echo "File size:"
ls -lh "successful_${SUCCESSFUL:0:16}.mp4"

echo ""
echo "Testing with ffprobe:"
ffprobe "successful_${SUCCESSFUL:0:16}.mp4" 2>&1 | grep -E "(Duration|Video:|moov atom)"

echo ""
echo "If this shows valid duration and video info, the 87% success rate is accurate."
