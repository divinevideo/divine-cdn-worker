#!/bin/bash
# Test cleanup endpoint
curl -X POST "https://blossom.divine.video/cleanup-duplicates" \
  -H "Content-Type: application/json" \
  -d "{\"page\": 1, \"dryRun\": true}"
