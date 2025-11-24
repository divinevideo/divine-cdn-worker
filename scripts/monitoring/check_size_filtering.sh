#!/bin/bash
echo "Checking size distribution of uploads/ files..."
echo ""

# Sample files and check their sizes
RESPONSE=$(curl -s "https://blossom.divine.video/_list_r2?prefix=uploads/&limit=1000")

echo "Size distribution:"
echo "$RESPONSE" | jq -r '.objects[] | 
  if .size < 50000 then "< 50KB (too small)"
  elif .size > 20000000 then "> 20MB (too large)"
  else "50KB - 20MB (valid)"
  end' | sort | uniq -c

echo ""
echo "Total in sample: $(echo "$RESPONSE" | jq '.objects | length')"
