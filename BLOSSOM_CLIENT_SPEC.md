# Blossom Server API Specification for Client Developers

**Server:** https://blossom.divine.video
**Last Updated:** 2025-10-28
**Status:** ✅ Production Ready - Signature Verification Enabled

## Recent Fixes (2025-10-28)

### 1. POST Support Added
**What changed:** Server now accepts BOTH `PUT` and `POST` for `/upload` endpoint (Postel's Law).
- **Before:** Only PUT accepted, POST returned 404
- **After:** Both PUT and POST work identically
- **Recommendation:** Use POST per BUD-01 spec

### 2. 🔒 CRITICAL SECURITY FIX: Signature Verification
**What changed:** Server now properly validates Nostr event signatures per NIP-01.
- **Before:** ⚠️ Accepted ANY kind 24242 event without validating signatures (MAJOR SECURITY FLAW)
- **After:** ✅ Validates event ID and Schnorr signature using @noble/curves
- **Impact:** Production now requires properly signed events. Anyone can impersonate users was previously possible.

---

## Upload Endpoint: `/upload`

### Methods Accepted
- `PUT /upload` - Legacy, still supported
- `POST /upload` - **Recommended**, BUD-01 compliant

### Request Format

**Headers (Required):**
```
Authorization: Nostr <base64-encoded-event>
Content-Type: <mime-type>
```

**Headers (Optional - ProofMode):**
```
X-ProofMode-Manifest: <base64-encoded-manifest>
X-ProofMode-Signature: <base64-signature>
X-ProofMode-Attestation: <guardian-attestation>
```

**Body:**
- Raw binary data (NOT multipart/form-data)
- The actual file bytes

### Authentication: Nostr Kind 24242 (BUD-01)

**⚠️ IMPORTANT: Use Blossom BUD-01, NOT NIP-98!**

- ✅ **Correct**: kind 24242 (Blossom BUD-01)
- ❌ **Wrong**: kind 27235 (NIP-98 HTTP auth)

Blossom has its own authentication spec (BUD-01), which is different from NIP-98.

The `Authorization` header format per BUD-01:

```
Authorization: Nostr <base64-encoded-event>
```

The event must be a kind 24242 Nostr event, base64-encoded:

```json
{
  "kind": 24242,
  "created_at": <unix-timestamp-in-past>,
  "tags": [
    ["t", "upload"],
    ["expiration", "<unix-timestamp-in-future>"],
    ["x", "<sha256-hash-of-file>"]
  ],
  "content": "Upload <filename>",
  "pubkey": "<user-pubkey>",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

**Required by BUD-01 spec:**
- `t` tag - Action verb: `upload`, `get`, `list`, or `delete`
- `expiration` tag - Unix timestamp when event expires (NIP-40)
- `content` - Human-readable description
- `created_at` - Must be in the past
- Valid `id` - Event ID computed as SHA-256 of serialized event `[0, pubkey, created_at, kind, tags, content]`
- Valid `sig` - 64-byte Schnorr signature (BIP-340) of the event ID

**Required for this server:**
- `x` tag - SHA-256 hash of the file (server validates uploaded data matches)

**Optional:**
- `server` tag - Full server URL (for auth scoped to specific servers)

**Production Security:**
- ✅ All events MUST have valid signatures
- ✅ Event ID is verified against re-computed hash
- ✅ Signature is verified using Schnorr (secp256k1)

### Response: Success (200 OK)

```json
{
  "url": "https://cdn.divine.video/<sha256>.mp4",
  "sha256": "<64-char-hex-hash>",
  "size": 12345,
  "type": "video/mp4",
  "uploaded": 1698765432,
  "proofmode": {
    "verified": true,
    "level": "verified_mobile",
    "deviceFingerprint": "...",
    "timestamp": 1698765430
  },
  "streaming": {
    "status": "processing",
    "hlsUrl": null,
    "provider": "bunny"
  }
}
```

**Notes:**
- `streaming.hlsUrl` will be populated after video encoding completes (30-120 seconds)
- Check `/video-status/<sha256>` to poll for HLS URL

### Response: File Already Exists (200 OK)

If SHA-256 already exists in storage:

```json
{
  "url": "https://cdn.divine.video/<sha256>.mp4",
  "sha256": "<hash>",
  "size": 12345,
  "type": "video/mp4",
  "uploaded": 1698765432
}
```

### Error Responses

#### 401 Unauthorized
```json
{ "error": "unauthorized" }
```
- Missing or invalid Authorization header
- Invalid Nostr event signature

#### 400 Hash Mismatch
```json
{
  "error": "hash_mismatch",
  "message": "SHA-256 in auth does not match uploaded data"
}
```
- The `x` tag in auth event doesn't match actual file hash

#### 400 ProofMode Required (Videos Only)
```json
{
  "error": "proofmode_required",
  "message": "Video uploads require ProofMode verification...",
  "proofmode_level": "unverified",
  "required_level": "verified_web or verified_mobile"
}
```
- Only if `REQUIRE_PROOFMODE_FOR_VIDEOS=true` (currently disabled)
- Videos need ProofMode headers for verification

---

## Other Endpoints

### GET `/<sha256>` - Download Blob
**Response:** Binary data with appropriate Content-Type
**Headers:** Supports Range requests for streaming
**Errors:**
- 404 - Blob not found
- 451 - Content banned (moderation)
- 401 - Age-restricted content, requires auth

### HEAD `/<sha256>` - Check Existence
**Response:** Headers only (no body)
**Use case:** Check if file exists before uploading

### GET `/list/<pubkey>` - List User's Blobs
**Response:** JSON array of blob metadata owned by pubkey

### DELETE `/<sha256>` - Delete Blob
**Requires:** Authorization header with owner's pubkey
**Response:** 204 No Content on success

### GET `/video-status/<sha256>` - Check Video Processing
**Response:**
```json
{
  "sha256": "...",
  "status": "ready",
  "videoId": "12345",
  "r2Url": "https://cdn.divine.video/<sha256>.mp4",
  "hlsUrl": "https://stream.divine.video/12345/playlist.m3u8",
  "thumbnailUrl": "https://stream.divine.video/12345/thumbnail.jpg",
  "ready": true,
  "message": "Video encoding complete. All URLs are ready."
}
```

**Statuses:**
- `processing` - Still encoding
- `ready` - HLS/thumbnail URLs available
- `not_backfilled` - Exists in R2, not yet in streaming service

---

## CORS Configuration

**Allowed Origins:** `*` (all origins)
**Allowed Methods:** `GET, HEAD, PUT, POST, DELETE`
**Allowed Headers:** `Authorization, Content-Type, X-ProofMode-*`

---

## Content Moderation

All uploads are automatically analyzed:

- **SAFE:** Serves without restrictions
- **REVIEW:** Flagged for review, serves normally
- **AGE_RESTRICTED:** Requires Nostr auth + NIP-78 preferences
- **PERMANENT_BAN:** Returns HTTP 451, never served

---

## Example Upload Flow (Flutter/Dart)

```dart
// 1. Calculate SHA-256 of file
final fileBytes = await file.readAsBytes();
final sha256 = sha256.convert(fileBytes).toString();

// 2. Create Nostr auth event (kind 24242)
final authEvent = NostrEvent(
  kind: 24242,
  pubkey: userPubkey,
  createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
  tags: [
    ['t', 'upload'],
    ['x', sha256],
    ['expiration', '${DateTime.now().add(Duration(minutes: 10)).millisecondsSinceEpoch ~/ 1000}']
  ],
  content: 'Upload ${file.path.split('/').last}',
);
// Sign event...

// 3. Upload file
final response = await http.post(
  Uri.parse('https://blossom.divine.video/upload'),
  headers: {
    'Authorization': 'Nostr ${base64Encode(utf8.encode(jsonEncode(authEvent.toJson())))}',
    'Content-Type': mimeType,
  },
  body: fileBytes,
);

// 4. Parse response
if (response.statusCode == 200) {
  final data = jsonDecode(response.body);
  final cdnUrl = data['url'];
  final hlsUrl = data['streaming']?['hlsUrl']; // May be null initially

  // If video and HLS not ready, poll /video-status/<sha256>
}
```

---

## Key Differences from BUD-01 Spec

1. **Request Body:** Send raw bytes, NOT multipart/form-data
2. **Content-Type:** Set to actual file mime type, not multipart
3. **Both Methods:** Server accepts PUT and POST (use POST)
4. **ProofMode:** Optional unless REQUIRE_PROOFMODE_FOR_VIDEOS is enabled

---

## Testing

**Test Upload (No Auth - Should Fail):**
```bash
curl -X POST https://blossom.divine.video/upload \
  -H "Content-Type: text/plain" \
  -d "test"
# Expected: {"error":"unauthorized"}
```

**Test Homepage:**
```bash
curl https://blossom.divine.video/
# Expected: HTML page with API docs
```

---

## Questions?

Contact Rabble or check the source code:
- Repository: `/Users/rabble/code/vine_fun/cf_streaming_service/blossom-sdk-worker/`
- Entry point: `src/index.mjs`
- Upload handler: `handleUploadBlob()` function (line 477)
