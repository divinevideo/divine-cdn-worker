# Changelog

All notable changes to the Blossom SDK Worker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **CRITICAL**: HTTP Range Request support for video seeking/scrubbing
  - Mobile video players (iOS AVPlayer, Android ExoPlayer) require range request support
  - Worker cache was serving full 200 responses to range requests instead of 206 Partial Content
  - Fixed by skipping worker cache for requests with Range header
  - Now correctly returns 206 status with Content-Range headers
  - Video seeking and scrubbing now works correctly in mobile apps
  - Note: Previously cached files required Cloudflare cache purge to work correctly

### Changed
- Removed temporary debug/test/backfill scripts to clean up repository
- Moved test files to organized `tests/` and `scripts/` directories

## [0.2.0] - 2025-10-28

### Security
- **CRITICAL**: Implemented full Nostr signature verification (NIP-01) using @noble/curves
  - Previously accepted ANY kind 24242 event without validating signatures
  - Anyone could impersonate any user by forging unsigned events
  - Now validates event ID and Schnorr signature (BIP-340) in production
  - Enforced via `DEV_AUTH_MODE=false` in production environment
  - Dev/test mode still available with `DEV_AUTH_MODE=true`

### Added
- POST method support for `/upload` endpoint (Postel's Law compliance)
  - Server now accepts both PUT and POST requests
  - Updated CORS headers to include POST
  - Maintains backward compatibility with existing PUT clients
- Dependencies: @noble/curves ^2.0.1 and @noble/hashes ^2.0.1 for cryptographic operations
- Comprehensive client API documentation (`BLOSSOM_CLIENT_SPEC.md`)
- Security fix documentation (`SECURITY_FIX_SUMMARY.md`)

### Fixed
- **CRITICAL**: BunnyUploadHandler instantiation bug causing 500 errors
  - Handler was created without passing `env` parameter
  - Caused crash when accessing `env.BUNNY_STREAM_ACCESS_KEY`
  - Fixed in `src/index.mjs` line 565
- Improved error messages to distinguish between NIP-98 (kind 27235) and Blossom BUD-01 (kind 24242) events

### Changed
- Updated production environment configuration in `wrangler.toml`
  - Set `DEV_AUTH_MODE=false` explicitly for production security
- Updated test suite to include POST method validation

### Removed
- Staging environment configuration (unused)
  - Removed from `wrangler.toml`
  - Removed staging deployment scripts from `package.json`
  - Simplified to dev + production only

### Documentation
- Created `BLOSSOM_CLIENT_SPEC.md` - Complete API specification for client developers
  - Detailed authentication requirements (kind 24242, BUD-01)
  - Request/response formats with examples
  - All endpoint documentation
  - Error handling guide
  - Flutter/Dart example code
- Created `SECURITY_FIX_SUMMARY.md` - Detailed security audit and fix documentation

## [0.1.0] - 2025-10-24

### Added
- Initial Blossom server implementation
- BunnyStream integration for video HLS encoding
- ProofMode support for verified media
- Content moderation integration
- R2 blob storage
- Video upload and retrieval endpoints
- Automatic content moderation via queue
- Webhook handlers for BunnyStream encoding completion

[Unreleased]: https://github.com/yourusername/blossom-sdk-worker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yourusername/blossom-sdk-worker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yourusername/blossom-sdk-worker/releases/tag/v0.1.0
