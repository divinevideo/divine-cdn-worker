#!/bin/bash
# ABOUTME: Migrate all events from relay3.openvine.co to relay.divine.video
# ABOUTME: Only copies events if d-tag doesn't already exist in target relay

OLD_RELAY="wss://relay3.openvine.co"
NEW_RELAY="wss://relay.divine.video"

# Event kinds to migrate
KIND=${1:-34236}  # Default to videos (34236), can pass 0 for users

# Time-based pagination (relay3 has 500 event limit)
START_TIME=${2:-1367366400}  # 2013-05-01 (earliest Vine videos)
END_TIME=${3:-$(date +%s)}

# Batch size for time windows (30 days in seconds)
TIME_WINDOW=$((30 * 24 * 60 * 60))

TOTAL_MIGRATED=0
TOTAL_SKIPPED=0
TOTAL_ERRORS=0

echo "=========================================="
echo "Relay Migration Tool (d-tag aware)"
echo "=========================================="
echo "Source: $OLD_RELAY"
echo "Target: $NEW_RELAY"
echo "Event kind: $KIND"
echo "Time range: $(date -r $START_TIME '+%Y-%m-%d') to $(date -r $END_TIME '+%Y-%m-%d')"
echo ""

# Create temp directory for event batches
TEMP_DIR=$(mktemp -d)
echo "Using temp directory: $TEMP_DIR"
echo ""

current_start=$START_TIME

while [ $current_start -lt $END_TIME ]; do
  current_end=$((current_start + TIME_WINDOW))
  if [ $current_end -gt $END_TIME ]; then
    current_end=$END_TIME
  fi

  BATCH_FILE="$TEMP_DIR/batch_${current_start}.jsonl"

  echo "Fetching events from $(date -r $current_start '+%Y-%m-%d') to $(date -r $current_end '+%Y-%m-%d')..."

  # Fetch events from old relay
  nak req -k $KIND --since $current_start --until $current_end $OLD_RELAY 2>/dev/null > "$BATCH_FILE"

  EVENT_COUNT=$(wc -l < "$BATCH_FILE" | tr -d ' ')

  if [ $EVENT_COUNT -eq 0 ]; then
    echo "  No events in this time window"
    rm "$BATCH_FILE"
    current_start=$current_end
    continue
  fi

  echo "  Found $EVENT_COUNT events, checking for duplicates..."

  # Process each event
  published=0
  skipped=0
  errors=0

  while IFS= read -r event; do
    if [ -z "$event" ]; then
      continue
    fi

    # Extract pubkey and d-tag from event
    pubkey=$(echo "$event" | jq -r '.pubkey // empty')
    dtag=$(echo "$event" | jq -r '.tags[] | select(.[0] == "d") | .[1] // empty')

    if [ -z "$pubkey" ] || [ -z "$dtag" ]; then
      errors=$((errors + 1))
      echo "    Error: Missing pubkey or d-tag in event" >> "$TEMP_DIR/errors.log"
      continue
    fi

    # Check if event with this d-tag already exists in new relay
    existing=$(nak req -k $KIND -a $pubkey --tag d=$dtag --limit 1 $NEW_RELAY 2>/dev/null)

    if [ -n "$existing" ] && [ "$existing" != "" ]; then
      # Event already exists, skip
      skipped=$((skipped + 1))
    else
      # Event doesn't exist, publish it
      result=$(echo "$event" | nak event $NEW_RELAY 2>&1)

      if echo "$result" | grep -qi "success\|ok\|accepted"; then
        published=$((published + 1))
      else
        errors=$((errors + 1))
        echo "    Error publishing d-tag '$dtag': $result" >> "$TEMP_DIR/errors.log"
      fi
    fi

    # Progress indicator every 25 events
    total_processed=$((published + skipped + errors))
    if [ $((total_processed % 25)) -eq 0 ]; then
      echo -n "."
    fi
  done < "$BATCH_FILE"

  echo ""
  echo "  Published: $published | Skipped (already exist): $skipped | Errors: $errors"

  TOTAL_MIGRATED=$((TOTAL_MIGRATED + published))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))
  TOTAL_ERRORS=$((TOTAL_ERRORS + errors))

  # Clean up batch file
  rm "$BATCH_FILE"

  # Move to next time window
  current_start=$current_end

  # Small delay to avoid overwhelming relay
  sleep 1

  echo ""
done

echo "=========================================="
echo "MIGRATION COMPLETE"
echo "=========================================="
echo "Total migrated: $TOTAL_MIGRATED"
echo "Already existed (skipped): $TOTAL_SKIPPED"
echo "Errors: $TOTAL_ERRORS"
echo ""

if [ $TOTAL_ERRORS -gt 0 ]; then
  echo "Error log: $TEMP_DIR/errors.log"
  echo "Temp directory preserved: $TEMP_DIR"
else
  echo "Cleaning up temp directory..."
  rm -rf "$TEMP_DIR"
fi

echo ""
echo "To migrate other event kinds, run:"
echo "  ./migrate_relay_events.sh 0  # for user profiles"
echo "  ./migrate_relay_events.sh 1  # for notes"
