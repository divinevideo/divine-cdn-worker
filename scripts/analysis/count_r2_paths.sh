#!/bin/bash
echo "Counting R2 videos by path..."
echo ""

# Count blobs/ (new path)
echo -n "blobs/ folder: "
CURSOR=""
COUNT=0
while true; do
  if [ -z "$CURSOR" ]; then
    RESPONSE=$(curl -s "https://blossom.divine.video/_list_r2?prefix=blobs/&limit=1000")
  else
    RESPONSE=$(curl -s "https://blossom.divine.video/_list_r2?prefix=blobs/&limit=1000&cursor=$CURSOR")
  fi
  
  BATCH=$(echo "$RESPONSE" | jq '.count')
  COUNT=$((COUNT + BATCH))
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.truncated')
  
  [ "$TRUNCATED" != "true" ] && break
  CURSOR=$(echo "$RESPONSE" | jq -r '.cursor // ""')
  [ -z "$CURSOR" ] && break
done
echo "$COUNT videos"

# Count uploads/ folder (old path)
echo -n "uploads/ folder: "
CURSOR=""
COUNT=0
while true; do
  if [ -z "$CURSOR" ]; then
    RESPONSE=$(curl -s "https://blossom.divine.video/_list_r2?prefix=uploads/&limit=1000")
  else
    RESPONSE=$(curl -s "https://blossom.divine.video/_list_r2?prefix=uploads/&limit=1000&cursor=$CURSOR")
  fi
  
  BATCH=$(echo "$RESPONSE" | jq '.count')
  COUNT=$((COUNT + BATCH))
  TRUNCATED=$(echo "$RESPONSE" | jq -r '.truncated')
  
  [ "$TRUNCATED" != "true" ] && break
  CURSOR=$(echo "$RESPONSE" | jq -r '.cursor // ""')
  [ -z "$CURSOR" ] && break
  
  # Progress indicator every 10k
  if [ $((COUNT % 10000)) -eq 0 ]; then
    echo -n "."
  fi
done
echo " $COUNT videos"

# Sample a few root-level .mp4 files
echo -n "Root-level .mp4 files (sample): "
ROOT_SAMPLE=$(curl -s "https://blossom.divine.video/_list_r2?limit=1000" | jq '[.objects[] | select(.key | endswith(".mp4") and (startswith("blobs/") or startswith("uploads/") or startswith("videos/")) | not)] | length')
echo "$ROOT_SAMPLE (in first 1000 files)"

echo ""
echo "Done!"
