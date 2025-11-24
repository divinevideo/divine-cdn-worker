#!/bin/bash
# Find full SHA256s from partial hashes by listing R2

PREFIX="$1"
echo "Searching R2 for files starting with: $PREFIX"

# Use wrangler to list R2 objects matching prefix
npx wrangler r2 object get nostrvine-media "${PREFIX}" --env production --file "/tmp/test_${PREFIX}.mp4" 2>&1 | head -5

# If that doesn't work, try listing
# npx wrangler r2 object list nostrvine-media --prefix="${PREFIX}" --env production
