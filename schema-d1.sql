-- Blossom D1 Database Schema
-- Records Bunny webhook events for queryable video processing history

CREATE TABLE IF NOT EXISTS bunny_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Video identifiers
  video_guid TEXT NOT NULL,           -- Bunny video GUID
  video_id TEXT,                      -- Bunny video ID (numeric)
  sha256 TEXT,                        -- SHA-256 hash from our system

  -- Event metadata
  status INTEGER NOT NULL,            -- Bunny status code (0=queued, 1=processing, 2=encoding, 3=finished, 4=resolution_finished, 5=error)
  status_name TEXT NOT NULL,          -- Human-readable status
  timestamp DATETIME NOT NULL,        -- When event occurred (from Bunny)
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- When we received it

  -- URLs
  hls_url TEXT,                       -- HLS playlist URL
  thumbnail_url TEXT,                 -- Thumbnail URL
  mp4_url TEXT,                       -- Direct MP4 URL

  -- Error handling
  error_message TEXT,                 -- Error message if status=5

  -- Webhook metadata
  webhook_body TEXT,                  -- Full webhook JSON for debugging

  -- Indexing
  UNIQUE(video_guid, timestamp)       -- Prevent duplicate events
);

-- Index for querying by SHA-256
CREATE INDEX IF NOT EXISTS idx_bunny_events_sha256
ON bunny_webhook_events(sha256);

-- Index for querying by status
CREATE INDEX IF NOT EXISTS idx_bunny_events_status
ON bunny_webhook_events(status);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_bunny_events_timestamp
ON bunny_webhook_events(timestamp);

-- Index for recent events
CREATE INDEX IF NOT EXISTS idx_bunny_events_received
ON bunny_webhook_events(received_at);

-- Video metadata table (links Bunny videos to our system)
CREATE TABLE IF NOT EXISTS video_metadata (
  sha256 TEXT PRIMARY KEY,
  video_guid TEXT NOT NULL,
  video_id TEXT,
  bunny_library_id TEXT,

  -- Current status
  current_status TEXT NOT NULL,       -- latest status
  current_hls_url TEXT,
  current_thumbnail_url TEXT,
  current_mp4_url TEXT,

  -- Upload metadata
  uploaded_by TEXT,                   -- Nostr pubkey
  uploaded_at DATETIME,
  file_size INTEGER,
  mime_type TEXT,

  -- Last update
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(video_guid)
);

-- Index for querying by video_guid
CREATE INDEX IF NOT EXISTS idx_video_meta_guid
ON video_metadata(video_guid);

-- Index for querying by uploader
CREATE INDEX IF NOT EXISTS idx_video_meta_uploader
ON video_metadata(uploaded_by);
