# Flutter Blossom Client Guide

## BUD-01 Compliant Authentication

This guide covers how to properly authenticate with BUD-01 compliant Blossom servers.

**Server:** https://blossom.divine.video
**Protocol:** Blossom BUD-01 (NOT NIP-98)

---

## Quick Reference

| Requirement | Value |
|------------|-------|
| Event kind | `24242` (NOT 27235) |
| Required tags | `t`, `expiration` |
| Optional tags | `x` (hash), `server` |
| `created_at` | Must be in past (60s clock skew allowed) |
| `expiration` | Must be in future |
| `t` tag | Must match action: `upload`, `get`, `delete`, `list` |

---

## Dependencies

Add to `pubspec.yaml`:

```yaml
dependencies:
  nostr: ^1.5.0          # or your preferred Nostr library
  crypto: ^3.0.3         # for SHA-256
  convert: ^3.1.1        # for base64/hex encoding
  http: ^1.1.0           # for HTTP requests
```

---

## Complete Upload Example

```dart
import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:nostr/nostr.dart';

class BlossomUploader {
  final String serverUrl;
  final Keychain keychain;  // Your Nostr keychain with private key

  BlossomUploader({
    this.serverUrl = 'https://blossom.divine.video',
    required this.keychain,
  });

  /// Upload a file to Blossom server
  Future<BlossomUploadResult> uploadFile({
    required Uint8List fileBytes,
    required String mimeType,
    String? filename,
  }) async {
    // 1. Calculate SHA-256 hash of file
    final fileHash = sha256.convert(fileBytes).toString();

    // 2. Create BUD-01 auth event
    final authEvent = _createAuthEvent(
      action: 'upload',
      fileHash: fileHash,
      filename: filename,
    );

    // 3. Encode event for Authorization header
    final eventJson = jsonEncode(authEvent.toJson());
    final base64Event = base64Encode(utf8.encode(eventJson));

    // 4. Make upload request
    final response = await http.post(
      Uri.parse('$serverUrl/upload'),
      headers: {
        'Authorization': 'Nostr $base64Event',
        'Content-Type': mimeType,
      },
      body: fileBytes,
    );

    // 5. Handle response
    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      return BlossomUploadResult.success(
        url: data['url'],
        sha256: data['sha256'],
        size: data['size'],
        type: data['type'],
        hlsUrl: data['streaming']?['hlsUrl'],
      );
    } else if (response.statusCode == 401) {
      // Check X-Reason header for details
      final reason = response.headers['x-reason'] ?? 'Unknown auth error';
      throw BlossomAuthException(reason);
    } else {
      final body = jsonDecode(response.body);
      throw BlossomException(body['error'], body['message']);
    }
  }

  /// Create a BUD-01 compliant auth event
  Event _createAuthEvent({
    required String action,
    String? fileHash,
    String? filename,
  }) {
    final now = DateTime.now();
    final createdAt = now.millisecondsSinceEpoch ~/ 1000;
    final expiration = now.add(Duration(minutes: 5)).millisecondsSinceEpoch ~/ 1000;

    // Build tags - order matters for some implementations
    final tags = <List<String>>[
      ['t', action],  // REQUIRED: action verb
      ['expiration', expiration.toString()],  // REQUIRED: must be in future
    ];

    // Add file hash for upload (server validates this)
    if (fileHash != null) {
      tags.add(['x', fileHash]);
    }

    // Optional: scope to specific server
    // tags.add(['server', serverUrl]);

    // Create the event
    final event = Event.from(
      kind: 24242,  // MUST be 24242, NOT 27235 (NIP-98)
      tags: tags,
      content: filename != null ? 'Upload $filename' : 'Blossom $action',
      privkey: keychain.private,
      createdAt: createdAt,  // MUST be in past (server allows 60s clock skew)
    );

    return event;
  }

  /// Delete a blob from the server
  Future<void> deleteBlob(String sha256) async {
    final authEvent = _createAuthEvent(
      action: 'delete',
      fileHash: sha256,
    );

    final eventJson = jsonEncode(authEvent.toJson());
    final base64Event = base64Encode(utf8.encode(eventJson));

    final response = await http.delete(
      Uri.parse('$serverUrl/$sha256'),
      headers: {
        'Authorization': 'Nostr $base64Event',
      },
    );

    if (response.statusCode != 204) {
      final reason = response.headers['x-reason'] ?? 'Delete failed';
      throw BlossomException('delete_failed', reason);
    }
  }

  /// List blobs for a pubkey
  Future<List<BlobMetadata>> listBlobs(String pubkey) async {
    final response = await http.get(
      Uri.parse('$serverUrl/list/$pubkey'),
    );

    if (response.statusCode == 200) {
      final List data = jsonDecode(response.body);
      return data.map((e) => BlobMetadata.fromJson(e)).toList();
    }
    throw BlossomException('list_failed', 'Failed to list blobs');
  }
}

// Result classes
class BlossomUploadResult {
  final String url;
  final String sha256;
  final int size;
  final String type;
  final String? hlsUrl;

  BlossomUploadResult.success({
    required this.url,
    required this.sha256,
    required this.size,
    required this.type,
    this.hlsUrl,
  });
}

class BlobMetadata {
  final String sha256;
  final int size;
  final String type;
  final int uploaded;

  BlobMetadata.fromJson(Map<String, dynamic> json)
      : sha256 = json['sha256'],
        size = json['size'],
        type = json['type'],
        uploaded = json['uploaded'];
}

// Exceptions
class BlossomException implements Exception {
  final String error;
  final String? message;
  BlossomException(this.error, [this.message]);

  @override
  String toString() => 'BlossomException: $error - $message';
}

class BlossomAuthException extends BlossomException {
  BlossomAuthException(String reason) : super('unauthorized', reason);
}
```

---

## Common Errors and Solutions

### 401 Unauthorized

**Check `X-Reason` header for details:**

| X-Reason | Cause | Fix |
|----------|-------|-----|
| `missing_expiration` | No expiration tag | Add `['expiration', '<timestamp>']` tag |
| `expired` | Expiration is in past | Set expiration to future timestamp |
| `future_created_at` | `created_at` too far in future | Use current time or slightly past |
| `missing_action` | No `t` tag | Add `['t', 'upload']` tag |
| `action_mismatch` | Wrong action for endpoint | Use correct action (`upload`/`delete`/`get`/`list`) |
| `invalid_kind` | Using kind 27235 | Change to kind 24242 |
| `server_mismatch` | Server tag doesn't match | Remove server tag or use correct URL |
| `Invalid signature` | Bad signature | Ensure proper Schnorr signing |

### 400 Bad Request

| Error | Cause | Fix |
|-------|-------|-----|
| `hash_mismatch` | `x` tag doesn't match file | Recalculate SHA-256 of actual bytes |

---

## Event Structure Checklist

```dart
// ✅ CORRECT BUD-01 Event
{
  "kind": 24242,                    // ✅ Blossom kind (NOT 27235)
  "created_at": 1732698900,         // ✅ In the past
  "pubkey": "abc123...",            // ✅ Your public key
  "tags": [
    ["t", "upload"],                // ✅ Required: action verb
    ["expiration", "1732699200"],   // ✅ Required: future timestamp
    ["x", "def456..."]              // ✅ File hash for uploads
  ],
  "content": "Upload video.mp4",    // ✅ Human-readable description
  "id": "computed...",              // ✅ SHA-256 of serialized event
  "sig": "schnorr..."               // ✅ Valid Schnorr signature
}

// ❌ WRONG - Common Mistakes
{
  "kind": 27235,                    // ❌ NIP-98 kind
  "created_at": 1732699500,         // ❌ In the future
  "tags": [
    ["u", "https://..."],           // ❌ NIP-98 style
    ["method", "POST"]              // ❌ NIP-98 style
  ],
  ...
}
```

---

## Testing Your Implementation

### 1. Test Without Auth (Should Fail)

```dart
final response = await http.post(
  Uri.parse('https://blossom.divine.video/upload'),
  headers: {'Content-Type': 'text/plain'},
  body: utf8.encode('test'),
);
assert(response.statusCode == 401);
assert(response.headers['www-authenticate'] == 'Nostr');
print('X-Reason: ${response.headers['x-reason']}');
```

### 2. Test With Expired Event (Should Fail)

```dart
// Create event with past expiration
final expiredEvent = Event.from(
  kind: 24242,
  tags: [
    ['t', 'upload'],
    ['expiration', '${DateTime.now().subtract(Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000}'],
  ],
  ...
);
// Should get 401 with X-Reason: expired
```

### 3. Test With Wrong Action (Should Fail)

```dart
// Create event with 'delete' action for upload endpoint
final wrongAction = Event.from(
  kind: 24242,
  tags: [
    ['t', 'delete'],  // Wrong! Should be 'upload'
    ['expiration', '...'],
  ],
  ...
);
// Should get 401 with X-Reason: action_mismatch
```

---

## Video Upload with HLS Polling

```dart
Future<String> uploadVideoAndWaitForHLS(Uint8List videoBytes) async {
  final uploader = BlossomUploader(keychain: myKeychain);

  // Upload video
  final result = await uploader.uploadFile(
    fileBytes: videoBytes,
    mimeType: 'video/mp4',
  );

  // If HLS not immediately ready, poll for it
  if (result.hlsUrl == null) {
    final hlsUrl = await _pollForHLS(result.sha256);
    return hlsUrl;
  }

  return result.hlsUrl!;
}

Future<String> _pollForHLS(String sha256, {int maxAttempts = 30}) async {
  for (var i = 0; i < maxAttempts; i++) {
    final response = await http.get(
      Uri.parse('https://blossom.divine.video/video-status/$sha256'),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      if (data['ready'] == true && data['hlsUrl'] != null) {
        return data['hlsUrl'];
      }
    }

    await Future.delayed(Duration(seconds: 5));
  }

  throw Exception('HLS not ready after ${maxAttempts * 5} seconds');
}
```

---

## Summary

1. **Use kind 24242** (Blossom), not 27235 (NIP-98)
2. **Always include `t` tag** with correct action
3. **Always include `expiration` tag** with future timestamp
4. **Set `created_at` to current time** (not future)
5. **Include `x` tag** for uploads (server validates hash)
6. **Check `X-Reason` header** on errors for debugging
