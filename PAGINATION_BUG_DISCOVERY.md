# Critical Pagination Bug Discovery

**Date:** October 20, 2025
**Severity:** CRITICAL - Data Loss Appearance
**Impact:** 190k videos and 161k thumbnails hidden from API

---

## Summary

A critical bug in the `/_list_r2` endpoint's pagination implementation caused **99.8% of R2 storage contents to be invisible** to the application. This made 190,632 videos and 161,270 thumbnails appear lost, when they were actually present in R2 all along.

---

## The Problem

### Symptoms

1. **Flutter app showing 404 errors** for old Vine archive video thumbnails
2. **Only 417 videos visible** through R2 listing endpoint
3. **User reported** there should be 60k-100k videos
4. **Thumbnails appeared completely lost** - we thought they had been deleted

### Root Cause

**File:** `src/index.mjs:90`

**Buggy Code:**
```javascript
// TEMP: GET /_list_r2 - List R2 contents for debugging
if (method === 'GET' && url.pathname === '/_list_r2') {
  const prefix = url.searchParams.get('prefix') || '';
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const listed = await env.R2_BLOBS.list({ prefix, limit });
  const objects = listed.objects.map(obj => ({ key: obj.key, size: obj.size }));
  return jsonResponse(200, {
    prefix,
    count: objects.length,
    truncated: listed.truncated,
    // ❌ BUG: Missing cursor field!
    objects
  });
}
```

**The Bug:**
- Endpoint accepted `cursor` query parameter but **never returned it in response**
- R2 API correctly returned `listed.cursor` value
- Response JSON included `truncated: true` but **cursor was always null**
- Scripts got stuck in infinite loops or stopped after first batch

**API Response (Broken):**
```json
{
  "truncated": true,
  "count": 596,
  "cursor": null   // ← Should have been a Base64 encoded cursor!
}
```

---

## The Discovery Process

### Initial Investigation

1. **Attempted R2 listing:** Only found 417 videos in first batch
2. **Checked Nostr relay:** Only 19 videos with imeta tags
3. **User said:** "there are between 60k and 100k videos" and "you'll need pagination with until/since from nostr to get them all"
4. **Something felt very wrong** - massive discrepancy

### The Breakthrough

Running `count_r2_videos.sh` exposed the bug:

```bash
curl -s "https://blossom.divine.video/_list_r2?limit=1000" | jq '{truncated, count, cursor}'
```

**Response:**
```json
{
  "truncated": true,
  "count": 596,
  "cursor": null  // ← RED FLAG!
}
```

The script kept getting `truncated: true` but no cursor to continue pagination, causing it to loop infinitely or fail.

---

## The Fix

**File:** `src/index.mjs:84-92`

```javascript
// TEMP: GET /_list_r2 - List R2 contents for debugging
if (method === 'GET' && url.pathname === '/_list_r2') {
  const prefix = url.searchParams.get('prefix') || '';
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const cursor = url.searchParams.get('cursor') || undefined;  // ✅ Added
  const listed = await env.R2_BLOBS.list({ prefix, limit, cursor });  // ✅ Pass cursor
  const objects = listed.objects.map(obj => ({ key: obj.key, size: obj.size }));
  return jsonResponse(200, {
    prefix,
    count: objects.length,
    truncated: listed.truncated,
    cursor: listed.cursor,  // ✅ Return cursor!
    objects
  });
}
```

**Changes:**
1. Accept `cursor` from query parameters
2. Pass `cursor` to `env.R2_BLOBS.list()`
3. Return `cursor` in JSON response

**Deployed:** October 20, 2025 @ ~19:55 UTC
**Deployment:** `wrangler deploy --env production`

---

## The Results

### Before Fix
```
Total objects visible: 596 (first page only)
Total MP4 files: 401
Total JPG files: 123
```

### After Fix
```
Total objects in R2:  353,308  (+59,178% increase!)
Total MP4 files:      190,632  (+47,558% increase!)
Total JPG files:      161,270  (+131,332% increase!)
Other files:          1,406
```

---

## Impact Assessment

### What Was Broken

1. **`/_list_r2` endpoint** - Completely broken pagination
2. **`count_r2_videos.sh`** - Could only count first 596 objects
3. **`backfill_all.sh`** - Could only process first 417 videos
4. **All R2-based scripts** - Stopped after first page

### What Appeared Lost (But Wasn't)

- **161,270 thumbnail JPGs** - Present in R2, just invisible
- **190,215 videos** (190,632 - 417 visible) - Present in R2, just invisible
- **Years of uploaded content** - All still safely stored

### User Impact

- **Flutter app 404s** - Thumbnails existed but couldn't be found via listing
- **Backfill incomplete** - Only backfilled 417 videos instead of 190k+
- **False data loss panic** - We thought thumbnails were deleted

---

## Lessons Learned

### Why This Bug Was So Insidious

1. **Partial functionality** - First page worked perfectly, hiding the bug
2. **Silent failure** - No errors thrown, just `cursor: null`
3. **Logical contradiction** - `truncated: true` + `cursor: null` = impossible state
4. **Assumption validation** - We assumed the endpoint worked because first page did

### Red Flags We Should Have Caught Earlier

1. **"Something is VERY VERY wrong"** - User intuition was correct
2. **Massive count discrepancy** - 417 vs 60k-100k should have triggered immediate investigation
3. **Infinite loop in script** - `truncated: true` with no way to continue
4. **Missing thumbnails** - Should have checked R2 directly, not just via API

### What Saved Us

1. **User persistence** - "you'll need to pagination with until/since from nostr to get them all"
2. **Skepticism of results** - "something is VERY VERY wrong"
3. **Direct API testing** - Actually looked at the JSON response
4. **Root cause analysis** - Didn't accept "lost data" explanation

---

## Prevention Measures

### Immediate Actions

1. ✅ **Fixed pagination bug** - Added cursor parameter handling
2. ✅ **Deployed fix to production** - All 353k objects now visible
3. ✅ **Verified fix works** - Full scan completed successfully
4. 📝 **Documented discovery** - This file

### Recommended Follow-Up

1. **Add endpoint testing** - Unit tests for pagination edge cases
2. **Add monitoring** - Alert if `truncated: true` but `cursor: null`
3. **Code review** - Check all other pagination implementations
4. **Delete debug endpoints** - `/_list_r2` should not be in production
5. **Resume backfill** - Process all 190k videos to BunnyStream

---

## Technical Details

### R2 Pagination Flow (Correct)

```javascript
let cursor = undefined;
let allObjects = [];

while (true) {
  const response = await fetch(`/_list_r2?limit=1000&cursor=${cursor || ''}`);
  const data = await response.json();

  allObjects.push(...data.objects);

  if (!data.truncated || !data.cursor) {
    break;  // Done
  }

  cursor = data.cursor;  // Continue with next page
}
```

### R2 Cursor Format

Cursors are Base64-encoded JSON containing:
```json
{
  "v": 1,
  "startAfter": "f5ed36cc5968e5a6f05746afe8303872a2b890f6fa66646eaf04baa5aca66dae.mp4",
  "uuid": "7e664d735db1ab0a652d14eefe3b0407"
}
```

**Example cursor:**
```
1-JTdCJTIydiUyMiUzQTElMkMlMjJzdGFydEFmdGVyJTIyJTNBJTIyZjVlZDM2Y2M1OTY4ZTVhNmYwNTc0NmFmZTgzMDM4NzJhMmI4OTBmNmZhNjY2NDZlYWYwNGJhYTVhY2E2NmRhZS5tcDQlMjIlMkMlMjJ1dWlkJTIyJTNBJTIyN2U2NjRkNzM1ZGIxYWIwYTY1MmQxNGVlZmUzYjA0MDclMjIlN0Q=
```

---

## Conclusion

**This bug made 99.8% of our R2 storage invisible to the application.**

The thumbnails were never lost - they were there all along, safely stored in R2. A single missing line of code (`cursor: listed.cursor`) caused what appeared to be catastrophic data loss, but was actually just an API pagination bug.

**Key Takeaway:** When reality doesn't match expectations this drastically (417 vs 190k videos), always question your tools and assumptions before accepting data loss.

---

## References

- **Bug Fix Commit:** Added cursor pagination to `/_list_r2` endpoint
- **Deployment:** October 20, 2025 @ ~19:55 UTC
- **Count Script:** `count_r2_videos.sh`
- **API Endpoint:** `GET /_list_r2?limit=1000&cursor=...`
- **Total Objects Found:** 353,308 (190,632 videos + 161,270 thumbnails)
