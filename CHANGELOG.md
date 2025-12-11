# Changelog

All notable changes to the Blossom SDK Worker project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2025-11-29]

### Added
- BUD-04 blob mirroring support (`PUT /mirror` endpoint)
- In-memory MP4 duration checking to reject videos longer than 6 seconds at upload time
- NIP-96 compatible query parameters for Media Transformations (`?w=`, `?thumb`, `?audio`)

### Changed
- Migrated from BunnyStream to Cloudflare Media Transformations for video processing
- Cloudflare Stream manifest requests now redirect instead of proxying (reduced latency)

### Performance
- Parallelized KV and R2 fallback lookups (~900ms → ~200ms for legacy content)
- Enabled Smart Placement for optimal D1/KV routing
- Added lazy migration from legacy storage paths to optimal `blobs/` path

## [2025-11-28]

### Added
- First-frame thumbnail extraction via Cloudflare Media Transformations (`cdn-cgi/media`)

## [2025-11-27]

### Added
- Flutter integration guide and live integration tests
- BUD-01 Blossom authentication compliance (action validation, expiration, server tags)

### Security
- Set `DEV_AUTH_MODE=false` for production to enforce signature verification

## [2025-11-24]

### Fixed
- Response body reuse bug causing 500 errors on cached responses

## [2025-11-23]

### Added
- Range request caching to improve video seeking performance

### Fixed
- HTTP Range Request support for proper video streaming
- Range request caching to prevent incorrect byte ranges being served

### Changed
- Repository reorganization

## [2025-11-17]

### Added
- Initial commit as an independent repository
- Cloudflare Worker implementing Blossom protocol endpoints
- R2 blob storage backend
- KV metadata store
- Nostr authentication (kind 24242)
- ProofMode support for verified media uploads
- Content moderation integration
- BunnyStream video encoding integration
- Legacy Cloudflare Stream support
- Archive Team Vine video support (`/uploads/*`)
