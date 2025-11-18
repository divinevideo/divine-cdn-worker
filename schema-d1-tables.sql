CREATE TABLE IF NOT EXISTS bunny_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_guid TEXT NOT NULL,
  video_id TEXT,
  sha256 TEXT,
  status INTEGER NOT NULL,
  status_name TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  hls_url TEXT,
  thumbnail_url TEXT,
  mp4_url TEXT,
  error_message TEXT,
  webhook_body TEXT,
  UNIQUE(video_guid, timestamp)
);

CREATE TABLE IF NOT EXISTS video_metadata (
  sha256 TEXT PRIMARY KEY,
  video_guid TEXT NOT NULL,
  video_id TEXT,
  bunny_library_id TEXT,
  current_status TEXT NOT NULL,
  current_hls_url TEXT,
  current_thumbnail_url TEXT,
  current_mp4_url TEXT,
  uploaded_by TEXT,
  uploaded_at DATETIME,
  file_size INTEGER,
  mime_type TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_guid)
);
