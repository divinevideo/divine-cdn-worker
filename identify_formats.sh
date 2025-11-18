#!/bin/bash
# Identify actual file formats of failed videos

mkdir -p failed_samples
cd failed_samples

cat ../failed_video_shas.txt | head -5 | while read sha; do
  echo "=== Testing SHA: $sha ==="
  curl -s "https://blossom.divine.video/${sha}" -o "${sha}.dat"

  SIZE=$(ls -l "${sha}.dat" | awk '{print $5}')
  echo "Size: $SIZE bytes"

  # Check if it's HTML error
  if head -1 "${sha}.dat" | grep -q "<!DOCTYPE"; then
    echo "Result: Not found in R2"
  else
    echo "File type: $(file -b ${sha}.dat)"
    echo "Magic bytes:"
    xxd -l 32 "${sha}.dat" | head -2

    # Try to detect video codec
    ffprobe "${sha}.dat" 2>&1 | grep -E "(Duration|Video:|Audio:|codec)" | head -3 || echo "  ffprobe: Cannot decode"
  fi
  echo ""
done
