#!/bin/bash
# ABOUTME: Count video and user events in Nostr relays
# ABOUTME: Compares relay3.openvine.co vs relay.divine.video

echo "Counting events in relays..."
echo ""

echo "=== OLD RELAY (relay3.openvine.co) ==="
echo -n "Videos (kind 34236): "
nak req -k 34236 --limit 5000 wss://relay3.openvine.co 2>/dev/null | wc -l | tr -d ' '

echo -n "Users (kind 0): "
nak req -k 0 --limit 5000 wss://relay3.openvine.co 2>/dev/null | wc -l | tr -d ' '

echo ""
echo "=== NEW RELAY (relay.divine.video) ==="
echo -n "Videos (kind 34236): "
nak req -k 34236 --limit 5000 wss://relay.divine.video 2>/dev/null | wc -l | tr -d ' '

echo -n "Users (kind 0): "
nak req -k 0 --limit 5000 wss://relay.divine.video 2>/dev/null | wc -l | tr -d ' '

echo ""
echo "Note: These are sampled counts (max 5000 per query)"
echo "Real totals may be higher"
