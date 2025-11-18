#!/bin/bash
# Test if failed videos are corrupt in R2 or only fail during BunnyStream transfer

# Full SHA from earlier test
SHA="0072e95f2e6f05ce82669c7430467305357afd40939041dbc253bbe3e00de0b9"

echo "Downloading video directly from R2..."
curl -s "https://blossom.divine.video/${SHA}" -o "r2_source_${SHA:0:16}.mp4"

echo ""
echo "File info:"
file "r2_source_${SHA:0:16}.mp4"

echo ""
echo "File size:"
ls -lh "r2_source_${SHA:0:16}.mp4"

echo ""
echo "Testing with ffprobe:"
ffprobe "r2_source_${SHA:0:16}.mp4" 2>&1 | head -20

echo ""
echo "If ffprobe shows 'moov atom not found', the R2 source is corrupt."
echo "If ffprobe shows valid video info, the issue is in the BunnyStream transfer."
