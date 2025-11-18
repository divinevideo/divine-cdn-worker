# Cloudflare Cache API Implementation Design

**Date:** 2025-01-16
**Status:** Approved
**Author:** Claude + Rabble

## Problem Statement

The Blossom CDN Worker currently executes full logic on every GET request, performing:
- 4 KV lookups (duration-rejected, permanent-ban, age-restricted, blob metadata)
- 1 R2 blob read
- ~50-200ms total latency per request

Despite setting `Cache-Control: public, max-age=31536000, immutable` headers, we're **not using Cloudflare's Cache API**, so every request hits the Worker and performs expensive storage operations. This is inefficient since all content is immutable (content-addressed by SHA-256).

**Target Performance:** 1-5ms cache hits with zero Worker execution for cached content.

## Design Decision

**Approach:** Simple Early-Exit Cache (Approach 1)

We will implement Cloudflare's Cache API (`caches.default`) as the first operation in the fetch handler. Cache hits return immediately without any business logic, KV lookups, or R2 reads. Cache misses fall through to existing validation logic, then cache the result.

**Why this approach:**
- Maximum performance (cache hits skip Worker entirely)
- Simplest implementation (wrap existing logic)
- No race conditions (first response wins)
- Perfect for immutable content

**Rejected alternatives:**
- Approach 2 (Tiered cache with auth bypass) - Too complex, doesn't match architecture
- Approach 3 (Lazy invalidation with KV hints) - Unnecessary complexity, YAGNI

## Architecture

### Cache Flow

**Cold Cache (First Request):**
```
Request → Cache Check (MISS) → Existing Logic → Generate Response → Cache Write → Return
Time: ~50-200ms (Worker + 4 KV + R2)
```

**Warm Cache (Subsequent Requests):**
```
Request → Cache Check (HIT) → Return Cached Response
Time: ~1-5ms (edge cache only, no Worker execution)
```

### Components

**1. Cache Check Wrapper**
- Location: Top of `fetch()` handler in `src/index.mjs`
- Creates normalized cache key from request URL
- Checks `caches.default` for existing response
- Returns cached response immediately if found
- Falls through to existing logic if miss

**2. Cache Decision Logic (`shouldCache()` function)**
- Evaluates response status code
- Checks request method (GET/HEAD only)
- Detects Range requests (don't cache 206 responses)
- Detects auth-required responses (don't cache 401/403)
- Returns boolean decision

**3. Cache Write**
- After existing handler returns response
- Calls `shouldCache()` to validate
- Writes to `caches.default` via `cache.put()`
- Uses `response.clone()` (Response bodies are single-use)

**4. Cache Key Normalization**
- Uses full request URL as cache key
- Strips Range headers (to avoid fragmentation)
- Forces method to GET (HEAD responses match GET cache)

### Caching Policy

**DO cache these responses:**
- ✅ 200 OK - Successful blob delivery
- ✅ 404 Not Found - Blob doesn't exist
- ✅ 400 Bad Request - Duration exceeded errors
- ✅ 451 Unavailable - Permanently banned content
- ✅ 302 Redirect - HLS playlist redirects

**DO NOT cache these responses:**
- ❌ 206 Partial Content - Range requests (each range is different)
- ❌ 401/403 Auth errors - Age-restricted content requiring per-user validation
- ❌ POST/PUT/DELETE - Only cache GET requests
- ❌ 500 Server errors - Transient failures shouldn't be cached

**Rationale:** All content is immutable and content-addressed. Moderation/duration flags are set during webhook processing before first serve, so the first GET request makes the authoritative decision. Caching errors prevents repeated expensive lookups for blocked content and protects against abuse.

## Error Handling

**Cache Failures:**
Wrap cache operations in try-catch. If `cache.match()` or `cache.put()` fails, log error and fall through to normal logic. Caching is best-effort; failures degrade to current performance without breaking functionality.

**Cache Poisoning Prevention:**
- Only cache responses after successful validation
- Never cache 500 errors (transient failures)
- Cache keys based on URL only (no manipulable header variance)

**Stale Content:**
No risk since content is immutable and moderation happens before first serve. Once cached, the decision is permanent and correct.

## Observability

### Built-in Cloudflare Signals

**1. `cf-cache-status` Response Header** (automatic)
- `HIT` - Served from edge cache
- `MISS` - Not in cache, executed Worker
- `BYPASS` - Deliberately not cached

**2. Cloudflare Workers Analytics Dashboard**
- **Subrequest count** - Should drop by 90-95%
- **Duration P50/P95/P99** - Should drop to ~5-10ms average
- **CPU Time** - Should drop significantly

**3. Cache Hit Rate Formula:**
```
(total_requests - subrequests) / total_requests
```
Target: >90% cache hit rate after warm-up period

### Custom Logging

**Console logs** (minimal, zero overhead):
```javascript
// On cache miss
console.log(`[Cache MISS] ${sha256.substring(0,12)} - executing full logic`);

// On cache write
console.log(`[Cache PUT] ${sha256.substring(0,12)} - status:${response.status}`);

// On cache errors
console.error(`[Cache ERROR] Failed to read/write cache:`, error);
```

### Success Criteria

Within 5-10 minutes of deployment:
- Subrequest count drops by 90-95%
- Average duration drops to ~5-10ms
- `cf-cache-status: HIT` header on second+ requests
- P99 latency significantly reduced

### Manual Testing

```bash
# First request (cold)
curl -I https://cdn.divine.video/abc123.mp4
# Expected: cf-cache-status: MISS, ~100-200ms

# Second request (warm)
curl -I https://cdn.divine.video/abc123.mp4
# Expected: cf-cache-status: HIT, ~5-20ms
```

## Implementation Notes

**Files Modified:**
- `src/index.mjs` - Add cache check at top of `fetch()`, add `shouldCache()` helper, add cache write before return

**No Breaking Changes:**
- All existing logic remains unchanged
- Cache is additive wrapper around existing code
- Cache failures gracefully degrade to current behavior

**Testing Strategy:**
1. Deploy to production (safe - failures degrade gracefully)
2. Monitor Cloudflare Analytics for 5-10 minutes
3. Verify cache hit rate >90%
4. Spot-check with curl for `cf-cache-status: HIT`

## Future Enhancements

**Cache Invalidation API** (if needed later):
- Add admin endpoint to delete specific cache entries
- Use `cache.delete(cacheKey)` for manual invalidation
- Useful if moderation decisions need correction post-cache

**Cache Analytics Dashboard** (if needed):
- Custom dashboard showing cache hit rates by content type
- Breakdown of cached vs uncached responses
- Popular content identification

## References

- [Cloudflare Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Response.clone() MDN](https://developer.mozilla.org/en-US/docs/Web/API/Response/clone)
- [HTTP Caching Best Practices](https://web.dev/http-cache/)
