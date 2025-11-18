#!/bin/bash
# Count all MP4 files in R2 by paginating through the list endpoint

ENDPOINT="https://blossom.divine.video/_list_r2"
TOTAL_OBJECTS=0
TOTAL_MP4=0
TOTAL_JPG=0
CURSOR=""

echo "Scanning R2 bucket..."
echo ""

while true; do
  # Build request
  if [ -z "$CURSOR" ]; then
    URL="${ENDPOINT}?limit=1000"
  else
    URL="${ENDPOINT}?limit=1000&cursor=${CURSOR}"
  fi

  # Call API
  RESPONSE=$(curl -s "$URL")

  # Parse response
  COUNT=$(echo "$RESPONSE" | jq -r '.objects | length')
  MP4_COUNT=$(echo "$RESPONSE" | jq -r '[.objects[] | select(.key | endswith(".mp4"))] | length')
  JPG_COUNT=$(echo "$RESPONSE" | jq -r '[.objects[] | select(.key | endswith(".jpg"))] | length')
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.truncated')
  CURSOR=$(echo "$RESPONSE" | jq -r '.cursor // empty')

  TOTAL_OBJECTS=$((TOTAL_OBJECTS + COUNT))
  TOTAL_MP4=$((TOTAL_MP4 + MP4_COUNT))
  TOTAL_JPG=$((TOTAL_JPG + JPG_COUNT))

  echo "Batch: $COUNT objects ($MP4_COUNT mp4, $JPG_COUNT jpg) | Total: $TOTAL_OBJECTS objects ($TOTAL_MP4 mp4, $TOTAL_JPG jpg)"

  # Check if done
  if [ "$TRUNCATED" != "true" ]; then
    echo ""
    echo "✓ Scan complete!"
    break
  fi

  if [ -z "$CURSOR" ]; then
    echo ""
    echo "✗ Error: No cursor but truncated=true"
    break
  fi

  if [ $COUNT -eq 0 ]; then
    echo ""
    echo "✗ Error: Got 0 objects, stopping"
    break
  fi
done

echo ""
echo "========================================"
echo "FINAL COUNT"
echo "========================================"
echo "Total objects in R2:  $TOTAL_OBJECTS"
echo "Total MP4 files:      $TOTAL_MP4"
echo "Total JPG files:      $TOTAL_JPG"
echo "Other files:          $((TOTAL_OBJECTS - TOTAL_MP4 - TOTAL_JPG))"
