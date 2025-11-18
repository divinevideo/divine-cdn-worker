# Flutter Client Integration Guide for Blossom Video Service

This guide shows Flutter developers exactly what to send to the Blossom server and how to handle the responses.

---

## Overview

**Server Base URL**: `https://blossom.divine.video`

**Flow**:
1. Client uploads video with Nostr authentication → Server returns URLs
2. Client plays R2 fallback MP4 immediately
3. Client polls for HLS encoding completion
4. Client switches to HLS for better streaming quality

---

## Required Flutter Packages

```yaml
dependencies:
  # HTTP client
  http: ^1.1.0

  # Video playback with HLS support
  video_player: ^2.8.0
  # OR for better HLS support:
  better_player: ^0.0.83
  # OR
  chewie: ^1.7.0

  # Nostr authentication (choose one)
  nostr_core_dart: ^0.1.0
  # OR implement custom Nostr signing

  # SHA-256 hashing
  crypto: ^3.0.3

  # File picking
  file_picker: ^6.1.1
```

---

## Step 1: Prepare Video Upload

### Calculate SHA-256 Hash

```dart
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'dart:convert';

Future<String> calculateSHA256(File videoFile) async {
  final bytes = await videoFile.readAsBytes();
  final digest = sha256.convert(bytes);
  return digest.toString();
}
```

### Create Nostr Authentication Event (Kind 24242)

```dart
import 'dart:convert';

Map<String, dynamic> createBlossomAuthEvent({
  required String publicKey,
  required String sha256Hash,
  required int expirationTimestamp,
}) {
  final now = (DateTime.now().millisecondsSinceEpoch / 1000).floor();

  return {
    'kind': 24242,
    'created_at': now,
    'tags': [
      ['t', 'upload'],
      ['x', sha256Hash],
      ['expiration', expirationTimestamp.toString()],
    ],
    'content': '',
    'pubkey': publicKey,
  };
}

// You must sign this event with your Nostr private key
// Use nostr_core_dart or implement Schnorr signature
String signNostrEvent(Map<String, dynamic> event, String privateKey) {
  // Implement Nostr event signing (BIP340 Schnorr)
  // This is complex - recommend using nostr_core_dart package
  // Return base64-encoded signed event
  throw UnimplementedError('Use nostr_core_dart for signing');
}
```

### Upload Video to Server

```dart
import 'package:http/http.dart' as http;
import 'dart:io';

class BlossomUploadResponse {
  final String url;              // HLS URL (primary)
  final String sha256;
  final int size;
  final String type;
  final int uploaded;
  final StreamingInfo? streaming;
  final String fallbackUrl;      // R2 MP4 URL (always works)

  BlossomUploadResponse.fromJson(Map<String, dynamic> json)
      : url = json['url'],
        sha256 = json['sha256'],
        size = json['size'],
        type = json['type'],
        uploaded = json['uploaded'],
        streaming = json['streaming'] != null
            ? StreamingInfo.fromJson(json['streaming'])
            : null,
        fallbackUrl = json['fallbackUrl'];
}

class StreamingInfo {
  final String status;           // "processing" or "ready"
  final String? hlsUrl;          // May be null initially
  final String? mp4Url;          // BunnyStream MP4
  final String? thumbnailUrl;
  final String provider;         // "bunny"
  final String message;

  StreamingInfo.fromJson(Map<String, dynamic> json)
      : status = json['status'],
        hlsUrl = json['hlsUrl'],
        mp4Url = json['mp4Url'],
        thumbnailUrl = json['thumbnailUrl'],
        provider = json['provider'],
        message = json['message'];
}

Future<BlossomUploadResponse> uploadVideoToBlossom({
  required File videoFile,
  required String signedNostrEvent, // Base64-encoded
}) async {
  final url = Uri.parse('https://blossom.divine.video/upload');
  final videoBytes = await videoFile.readAsBytes();

  final response = await http.post(
    url,
    headers: {
      'Authorization': 'Nostr $signedNostrEvent',
      'Content-Type': 'video/mp4',
    },
    body: videoBytes,
  );

  if (response.statusCode != 200) {
    throw Exception('Upload failed: ${response.statusCode} ${response.body}');
  }

  final json = jsonDecode(response.body);
  return BlossomUploadResponse.fromJson(json);
}
```

---

## Step 2: Handle Server Response

### What You Receive

```json
{
  "url": "https://stream.divine.video/12345/playlist.m3u8",
  "sha256": "abc123...",
  "size": 5242880,
  "type": "video/mp4",
  "uploaded": 1698765432,
  "streaming": {
    "status": "processing",
    "hlsUrl": "https://stream.divine.video/12345/playlist.m3u8",
    "mp4Url": "https://stream.divine.video/12345/play_480p.mp4",
    "thumbnailUrl": "https://stream.divine.video/12345/thumbnail.jpg",
    "provider": "bunny",
    "message": "Video is being encoded. All URLs will be ready in 30-120 seconds."
  },
  "fallbackUrl": "https://cdn.divine.video/abc123.mp4"
}
```

### Key Points

| Field | Description | Availability |
|-------|-------------|--------------|
| `fallbackUrl` | R2 MP4 URL - always works immediately | ✅ Immediate |
| `streaming.hlsUrl` | HLS playlist for adaptive streaming | ⏳ 30-120 seconds |
| `streaming.mp4Url` | BunnyStream MP4 | ⏳ 30-120 seconds |
| `streaming.thumbnailUrl` | Auto-generated thumbnail | ⏳ 30-120 seconds |
| `streaming.status` | "processing" → "ready" | ⏳ Poll for changes |

---

## Step 3: Play Video Immediately (R2 Fallback)

Use the `fallbackUrl` for instant playback while HLS encodes.

### Using video_player Package

```dart
import 'package:video_player/video_player.dart';
import 'package:flutter/material.dart';

class VideoPlayerWidget extends StatefulWidget {
  final String videoUrl;

  const VideoPlayerWidget({Key? key, required this.videoUrl}) : super(key: key);

  @override
  State<VideoPlayerWidget> createState() => _VideoPlayerWidgetState();
}

class _VideoPlayerWidgetState extends State<VideoPlayerWidget> {
  late VideoPlayerController _controller;
  bool _isInitialized = false;

  @override
  void initState() {
    super.initState();
    _initializeVideo();
  }

  Future<void> _initializeVideo() async {
    _controller = VideoPlayerController.networkUrl(
      Uri.parse(widget.videoUrl),
    );

    await _controller.initialize();
    setState(() => _isInitialized = true);
    _controller.play();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_isInitialized) {
      return const Center(child: CircularProgressIndicator());
    }

    return AspectRatio(
      aspectRatio: _controller.value.aspectRatio,
      child: VideoPlayer(_controller),
    );
  }
}

// Usage:
VideoPlayerWidget(videoUrl: uploadResponse.fallbackUrl)
```

### Using better_player (Recommended for HLS)

```dart
import 'package:better_player/better_player.dart';
import 'package:flutter/material.dart';

class BetterVideoPlayer extends StatefulWidget {
  final String videoUrl;
  final bool isHLS;

  const BetterVideoPlayer({
    Key? key,
    required this.videoUrl,
    this.isHLS = false,
  }) : super(key: key);

  @override
  State<BetterVideoPlayer> createState() => _BetterVideoPlayerState();
}

class _BetterVideoPlayerState extends State<BetterVideoPlayer> {
  late BetterPlayerController _controller;

  @override
  void initState() {
    super.initState();
    _initializePlayer();
  }

  void _initializePlayer() {
    final dataSource = BetterPlayerDataSource(
      widget.isHLS
          ? BetterPlayerDataSourceType.network
          : BetterPlayerDataSourceType.network,
      widget.videoUrl,
    );

    _controller = BetterPlayerController(
      const BetterPlayerConfiguration(
        autoPlay: true,
        aspectRatio: 16 / 9,
        fit: BoxFit.contain,
      ),
      betterPlayerDataSource: dataSource,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return BetterPlayer(controller: _controller);
  }
}

// Usage:
BetterVideoPlayer(
  videoUrl: uploadResponse.fallbackUrl,
  isHLS: false, // R2 MP4
)
```

---

## Step 4: Poll for HLS Encoding Completion

### Check Video Status Endpoint

```dart
class VideoStatusResponse {
  final String sha256;
  final String status;           // "ready", "processing", "not_backfilled"
  final String? videoId;
  final String? r2Url;           // R2 MP4 URL
  final String? hlsUrl;          // HLS playlist URL
  final String? thumbnailUrl;
  final bool ready;              // True when encoding complete
  final String message;

  VideoStatusResponse.fromJson(Map<String, dynamic> json)
      : sha256 = json['sha256'],
        status = json['status'],
        videoId = json['videoId'],
        r2Url = json['r2Url'],
        hlsUrl = json['hlsUrl'],
        thumbnailUrl = json['thumbnailUrl'],
        ready = json['ready'] ?? false,
        message = json['message'] ?? '';
}

Future<VideoStatusResponse> checkVideoStatus(String sha256) async {
  final url = Uri.parse('https://blossom.divine.video/video-status/$sha256');
  final response = await http.get(url);

  if (response.statusCode != 200) {
    throw Exception('Status check failed: ${response.statusCode}');
  }

  final json = jsonDecode(response.body);
  return VideoStatusResponse.fromJson(json);
}
```

### Poll Until Ready

```dart
import 'dart:async';

Stream<VideoStatusResponse> pollVideoStatus(
  String sha256, {
  Duration interval = const Duration(seconds: 5),
  Duration maxDuration = const Duration(seconds: 120),
}) async* {
  final startTime = DateTime.now();

  while (DateTime.now().difference(startTime) < maxDuration) {
    final status = await checkVideoStatus(sha256);
    yield status;

    // Stop polling if ready
    if (status.ready || status.status == 'ready') {
      break;
    }

    // Wait before next poll
    await Future.delayed(interval);
  }
}

// Usage:
await for (final status in pollVideoStatus(uploadResponse.sha256)) {
  print('Status: ${status.status}, Ready: ${status.ready}');

  if (status.ready && status.hlsUrl != null) {
    // Switch to HLS playback
    switchToHLS(status.hlsUrl!);
    break;
  }
}
```

---

## Step 5: Switch to HLS When Ready

### Update Video Source

```dart
class AdaptiveVideoPlayer extends StatefulWidget {
  final String sha256;
  final String initialUrl; // R2 fallback

  const AdaptiveVideoPlayer({
    Key? key,
    required this.sha256,
    required this.initialUrl,
  }) : super(key: key);

  @override
  State<AdaptiveVideoPlayer> createState() => _AdaptiveVideoPlayerState();
}

class _AdaptiveVideoPlayerState extends State<AdaptiveVideoPlayer> {
  late BetterPlayerController _controller;
  String _currentUrl;
  bool _isHLS = false;

  _AdaptiveVideoPlayerState() : _currentUrl = '';

  @override
  void initState() {
    super.initState();
    _currentUrl = widget.initialUrl;
    _initializePlayer(_currentUrl, isHLS: false);
    _pollForHLS();
  }

  void _initializePlayer(String url, {required bool isHLS}) {
    final dataSource = BetterPlayerDataSource(
      BetterPlayerDataSourceType.network,
      url,
    );

    _controller = BetterPlayerController(
      const BetterPlayerConfiguration(
        autoPlay: true,
        aspectRatio: 16 / 9,
      ),
      betterPlayerDataSource: dataSource,
    );

    setState(() {
      _currentUrl = url;
      _isHLS = isHLS;
    });
  }

  Future<void> _pollForHLS() async {
    await for (final status in pollVideoStatus(widget.sha256)) {
      if (status.ready && status.hlsUrl != null && status.hlsUrl != _currentUrl) {
        // Switch to HLS
        final currentPosition = await _controller.videoPlayerController?.position;
        _controller.dispose();

        _initializePlayer(status.hlsUrl!, isHLS: true);

        // Resume from same position
        if (currentPosition != null) {
          _controller.seekTo(currentPosition);
        }

        break;
      }
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        BetterPlayer(controller: _controller),
        if (!_isHLS)
          const Padding(
            padding: EdgeInsets.all(8.0),
            child: Text('Loading HLS...', style: TextStyle(fontSize: 12)),
          ),
      ],
    );
  }
}

// Usage after upload:
AdaptiveVideoPlayer(
  sha256: uploadResponse.sha256,
  initialUrl: uploadResponse.fallbackUrl,
)
```

---

## Complete Upload Flow Example

```dart
import 'dart:io';
import 'package:file_picker/file_picker.dart';

class BlossomVideoUploader {
  Future<void> uploadAndPlayVideo() async {
    // 1. Pick video file
    final result = await FilePicker.platform.pickFiles(
      type: FileType.video,
    );

    if (result == null) return;

    final videoFile = File(result.files.single.path!);

    // 2. Calculate SHA-256
    final sha256Hash = await calculateSHA256(videoFile);

    // 3. Create Nostr auth event
    final authEvent = createBlossomAuthEvent(
      publicKey: 'your_nostr_pubkey',
      sha256Hash: sha256Hash,
      expirationTimestamp: DateTime.now()
          .add(const Duration(hours: 1))
          .millisecondsSinceEpoch ~/ 1000,
    );

    // 4. Sign event (use nostr_core_dart)
    final signedEvent = signNostrEvent(authEvent, 'your_private_key');

    // 5. Upload to Blossom
    final uploadResponse = await uploadVideoToBlossom(
      videoFile: videoFile,
      signedNostrEvent: signedEvent,
    );

    print('Upload complete!');
    print('Fallback URL (ready now): ${uploadResponse.fallbackUrl}');
    print('HLS URL (processing): ${uploadResponse.streaming?.hlsUrl}');
    print('Status: ${uploadResponse.streaming?.status}');

    // 6. Play video with adaptive quality
    // Navigate to video player screen with:
    // - sha256: uploadResponse.sha256
    // - initialUrl: uploadResponse.fallbackUrl
  }
}
```

---

## Error Handling

### Common HTTP Status Codes

```dart
Future<BlossomUploadResponse> uploadVideoWithErrorHandling({
  required File videoFile,
  required String signedNostrEvent,
}) async {
  try {
    final url = Uri.parse('https://blossom.divine.video/upload');
    final videoBytes = await videoFile.readAsBytes();

    final response = await http.post(
      url,
      headers: {
        'Authorization': 'Nostr $signedNostrEvent',
        'Content-Type': 'video/mp4',
      },
      body: videoBytes,
    );

    switch (response.statusCode) {
      case 200:
        // Success - either new upload or duplicate
        final json = jsonDecode(response.body);
        return BlossomUploadResponse.fromJson(json);

      case 400:
        // Bad request - check error message
        final error = jsonDecode(response.body);
        if (error['message']?.contains('hash_mismatch') == true) {
          throw Exception('SHA-256 hash mismatch. Verify file integrity.');
        }
        throw Exception('Bad request: ${error['message']}');

      case 401:
        // Unauthorized - Nostr signature invalid
        throw Exception('Invalid Nostr signature. Check your auth event.');

      case 413:
        // Payload too large
        throw Exception('Video file too large. Maximum size exceeded.');

      case 415:
        // Unsupported media type
        throw Exception('Invalid video format. Only MP4 supported.');

      default:
        throw Exception('Upload failed: ${response.statusCode} ${response.body}');
    }
  } catch (e) {
    print('Upload error: $e');
    rethrow;
  }
}
```

---

## Best Practices

### ✅ DO:

1. **Always use `fallbackUrl` for immediate playback**
   - R2 MP4 is available instantly
   - Don't wait for HLS encoding to start showing video

2. **Poll for HLS with 5-second intervals**
   - Don't poll too frequently (server rate limiting)
   - Max wait time: 120 seconds

3. **Switch to HLS when ready**
   - Better adaptive streaming
   - Lower bandwidth for mobile users

4. **Cache video status responses**
   - Avoid redundant API calls
   - Store `sha256` → URL mapping locally

5. **Handle network errors gracefully**
   - Retry uploads with exponential backoff
   - Show user-friendly error messages

### ❌ DON'T:

1. **Don't try to parse m3u8 files yourself**
   - Use HLS-capable video players
   - Let the player handle playlist logic

2. **Don't assume HLS is immediately available**
   - Always check `streaming.status`
   - Have R2 fallback ready

3. **Don't skip Nostr authentication**
   - Server requires valid kind 24242 events
   - Invalid signatures → 401 errors

4. **Don't forget SHA-256 verification**
   - Server validates hash matches content
   - Hash mismatch → 400 error

---

## Summary Table

| Step | What Client Sends | What Server Returns | Client Action |
|------|-------------------|---------------------|---------------|
| **Upload** | Video bytes + Nostr auth | All 3 URLs + status | Play R2 fallback immediately |
| **Poll** | GET `/video-status/{sha256}` | Status + ready flag | Wait for `ready: true` |
| **Playback** | - | HLS URL when ready | Switch to HLS player |

---

## Example App Structure

```
lib/
├── models/
│   ├── blossom_upload_response.dart
│   └── video_status_response.dart
├── services/
│   ├── blossom_api_service.dart
│   ├── nostr_auth_service.dart
│   └── video_status_poller.dart
├── widgets/
│   ├── adaptive_video_player.dart
│   └── upload_progress_indicator.dart
└── screens/
    ├── video_upload_screen.dart
    └── video_playback_screen.dart
```

---

## Questions or Issues?

- **API Documentation**: Check `BLOSSOM_CLIENT_SPEC.md` in this repo
- **Server Issues**: Report at https://github.com/anthropics/claude-code/issues
- **Nostr Auth Help**: See [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)

---

**Last Updated**: Based on blossom-sdk-worker commit `7d9e58b`
