#!/bin/bash
# ABOUTME: Fetch all video SHA-256 hashes from Nostr relay using pagination
# ABOUTME: Queries kind 34236 events from relay3.openvine.co with until/since pagination

RELAY="wss://relay3.openvine.co"
OUTPUT_FILE="all_video_shas.txt"
TEMP_FILE="batch_events.json"
BATCH_SIZE=1000

# Start from now and go backwards in time
UNTIL=$(date +%s)
SINCE=0  # Unix epoch (1970-01-01)

TOTAL_EVENTS=0
TOTAL_SHAS=0

echo "=========================================="
echo "Fetching All Video Events from Nostr"
echo "=========================================="
echo "Relay: $RELAY"
echo "Output: $OUTPUT_FILE"
echo ""

# Clear output file
> "$OUTPUT_FILE"

BATCH_NUM=1

while true; do
  echo "Batch #$BATCH_NUM (fetching up to $BATCH_SIZE events until timestamp $UNTIL)..."

  # Fetch events from relay with time window
  nak req -k 34236 --until "$UNTIL" --limit "$BATCH_SIZE" "$RELAY" > "$TEMP_FILE" 2>/dev/null

  # Count events in this batch
  EVENT_COUNT=$(jq -s 'length' "$TEMP_FILE")

  if [ "$EVENT_COUNT" -eq 0 ]; then
    echo "  No more events found. Pagination complete!"
    break
  fi

  echo "  Fetched $EVENT_COUNT events"

  # Extract SHA-256 from imeta tags and append to output file
  # imeta format: ["imeta", "url https://...", "m video/mp4", "image https://...", "size 123", "x {sha256}"]
  # We want the value from index 5 after removing "x " prefix
  jq -s -r 'map(select(.tags[]? | (type == "array" and .[0] == "imeta"))) | .[] | .tags[] | select(.[0] == "imeta") | .[5] | sub("x "; "")' "$TEMP_FILE" | grep -E '^[a-f0-9]{64}$' >> "$OUTPUT_FILE"

  SHAS_IN_BATCH=$(jq -s -r 'map(select(.tags[]? | (type == "array" and .[0] == "imeta"))) | .[] | .tags[] | select(.[0] == "imeta") | .[5] | sub("x "; "")' "$TEMP_FILE" | grep -E '^[a-f0-9]{64}$' | wc -l | tr -d ' ')

  TOTAL_EVENTS=$((TOTAL_EVENTS + EVENT_COUNT))
  TOTAL_SHAS=$((TOTAL_SHAS + SHAS_IN_BATCH))

  echo "  Extracted $SHAS_IN_BATCH SHA-256 hashes"
  echo "  Running totals: $TOTAL_EVENTS events, $TOTAL_SHAS SHA-256s"
  echo ""

  # Get oldest timestamp from this batch for next iteration
  OLDEST_TIMESTAMP=$(jq -s 'map(.created_at) | min' "$TEMP_FILE")

  if [ "$OLDEST_TIMESTAMP" = "null" ] || [ -z "$OLDEST_TIMESTAMP" ]; then
    echo "  Could not determine oldest timestamp. Stopping."
    break
  fi

  # If we got fewer events than the limit, we've reached the end
  if [ "$EVENT_COUNT" -lt "$BATCH_SIZE" ]; then
    echo "  Fetched fewer events than batch size. Reached end of relay data!"
    break
  fi

  # Set until to oldest timestamp - 1 for next batch (to avoid duplicates)
  UNTIL=$((OLDEST_TIMESTAMP - 1))

  BATCH_NUM=$((BATCH_NUM + 1))

  # Brief pause to be nice to the relay
  sleep 1
done

# Clean up temp file
rm -f "$TEMP_FILE"

# Remove duplicates and sort
echo ""
echo "Removing duplicates and sorting..."
sort -u "$OUTPUT_FILE" -o "$OUTPUT_FILE"

UNIQUE_COUNT=$(wc -l < "$OUTPUT_FILE" | tr -d ' ')

echo ""
echo "=========================================="
echo "FINAL SUMMARY"
echo "=========================================="
echo "Total events fetched:     $TOTAL_EVENTS"
echo "Total SHA-256s extracted: $TOTAL_SHAS"
echo "Unique SHA-256s:          $UNIQUE_COUNT"
echo ""
echo "SHA-256 hashes saved to: $OUTPUT_FILE"
echo ""
echo "Next step: Run backfill using this list"
echo "  ./backfill_from_nostr.sh"
