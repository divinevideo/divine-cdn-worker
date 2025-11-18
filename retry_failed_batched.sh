#!/bin/bash
# ABOUTME: Orchestrate batched retry of failed BunnyStream videos
# ABOUTME: Calls /retry-failed endpoint repeatedly with pagination to avoid Worker timeout

set -e

ENDPOINT="${1:-https://blossom.divine.video/retry-failed}"
MAX_PAGES="${2:-5}"  # Process 5 pages (500 videos) per batch
START_PAGE="${3:-1}"

echo "Starting batched retry..."
echo "Endpoint: $ENDPOINT"
echo "Max pages per batch: $MAX_PAGES"
echo "Starting from page: $START_PAGE"
echo ""

current_page=$START_PAGE
total_retried=0
total_failed=0
total_not_found=0
total_skipped=0
batch_num=1

while true; do
  echo "Batch $batch_num: Processing pages $current_page-$((current_page + MAX_PAGES - 1))..."

  response=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"startPage\": $current_page, \"maxPages\": $MAX_PAGES}")

  echo "Response: $response"

  # Parse JSON response
  retried=$(echo "$response" | jq -r '.retried // 0')
  failed=$(echo "$response" | jq -r '.failed // 0')
  not_found=$(echo "$response" | jq -r '.notFound // 0')
  skipped=$(echo "$response" | jq -r '.skipped // 0')
  next_page=$(echo "$response" | jq -r '.nextPage // "null"')

  total_retried=$((total_retried + retried))
  total_failed=$((total_failed + failed))
  total_not_found=$((total_not_found + not_found))
  total_skipped=$((total_skipped + skipped))

  echo "  Retried: $retried, Failed: $failed, Not found: $not_found, Skipped: $skipped"
  echo "  Totals so far: Retried: $total_retried, Failed: $total_failed, Not found: $total_not_found, Skipped: $total_skipped"
  echo ""

  # Check if we're done
  if [ "$next_page" == "null" ] || [ -z "$next_page" ]; then
    echo "No more videos to process!"
    break
  fi

  current_page=$next_page
  batch_num=$((batch_num + 1))

  # Small delay between batches
  sleep 2
done

echo ""
echo "============================================================"
echo "Batched Retry Complete"
echo "============================================================"
echo "Total retried: $total_retried"
echo "Total failed: $total_failed"
echo "Total not found: $total_not_found"
echo "Total skipped: $total_skipped"
echo "Batches processed: $batch_num"
