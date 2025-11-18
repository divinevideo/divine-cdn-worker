#!/bin/bash
# Test Bunny webhook with D1 logging

WEBHOOK_URL="https://cdn.divine.video/webhooks/bunny"

# Sample webhook payload from Bunny (status=3 means finished encoding)
PAYLOAD='
{
  "VideoGuid": "test-FINAL-after-d1-fix",
  "VideoLibraryId": 515420,
  "Status": 3,
  "Timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")'",
  "VideoTitle": "Test Video for D1",
  "AvailableResolutions": "720p,1080p",
  "ThumbnailFileName": "thumbnail.jpg"
}
'

echo "Testing Bunny webhook with D1 logging..."
echo "Payload:"
echo "$PAYLOAD" | jq .

echo ""
echo "Sending webhook to $WEBHOOK_URL..."

curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -v

echo ""
echo "Check D1 database for this event:"
echo "SELECT * FROM bunny_webhook_events WHERE video_guid = 'test-12345-67890-abcdef';"
