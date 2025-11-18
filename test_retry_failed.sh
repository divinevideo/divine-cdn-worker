#!/bin/bash
SHA="0072e95f2e6f05ce82669c7430467305357afd40939041dbc253bbe3e00de0b9"

echo "Testing backfill of previously failed video..."
curl -X POST "https://blossom.divine.video/backfill-video" \
  -H "Content-Type: application/json" \
  -d "{\"sha256\": \"${SHA}\"}"
