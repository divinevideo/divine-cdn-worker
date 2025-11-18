#!/bin/bash
echo "Analyzing uploads/ folder contents..."
echo ""

# Sample 1000 files and check their extensions
RESPONSE=$(curl -s "https://blossom.divine.video/_list_r2?prefix=uploads/&limit=1000")

# Count by extension
echo "Sample of 1000 files from uploads/ folder:"
echo "$RESPONSE" | jq -r '.objects[].key' | sed 's/.*\.//' | sort | uniq -c | sort -rn

# Count mp4 files specifically
MP4_COUNT=$(echo "$RESPONSE" | jq -r '.objects[] | select(.key | endswith(".mp4")) | .key' | wc -l)
TOTAL=$(echo "$RESPONSE" | jq '.count')

echo ""
echo "In first 1000 files:"
echo "  .mp4 files: $MP4_COUNT"
echo "  Total files: $TOTAL"
echo "  .mp4 percentage: $(echo "scale=1; $MP4_COUNT * 100 / $TOTAL" | bc)%"
