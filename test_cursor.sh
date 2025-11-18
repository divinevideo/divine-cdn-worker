#!/bin/bash

echo "Testing if cursor advances properly..."
echo ""

echo "=== Batch 1 ==="
RESULT1=$(curl -s -X POST 'https://blossom.divine.video/backfill-batch' \
  -H 'Content-Type: application/json' \
  -d '{"limit":50,"skipExisting":true}')

PROCESSED1=$(echo "$RESULT1" | jq -r '.summary.processed')
CURSOR1=$(echo "$RESULT1" | jq -r '.pagination.cursor')

echo "Processed: $PROCESSED1"
echo "Cursor: ${CURSOR1:0:80}..."
echo ""

echo "=== Batch 2 (using Batch 1's cursor) ==="
RESULT2=$(curl -s -X POST 'https://blossom.divine.video/backfill-batch' \
  -H 'Content-Type: application/json' \
  -d "{\"limit\":50,\"skipExisting\":true,\"cursor\":\"$CURSOR1\"}")

PROCESSED2=$(echo "$RESULT2" | jq -r '.summary.processed')
CURSOR2=$(echo "$RESULT2" | jq -r '.pagination.cursor')

echo "Processed: $PROCESSED2"
echo "Cursor: ${CURSOR2:0:80}..."
echo ""

if [ "$CURSOR1" = "$CURSOR2" ]; then
  echo "❌ PROBLEM: Cursors are IDENTICAL - not advancing!"
else
  echo "✅ Cursors are different - advancing correctly"
fi
