CREATE INDEX IF NOT EXISTS idx_bunny_events_sha256 ON bunny_webhook_events(sha256);
CREATE INDEX IF NOT EXISTS idx_bunny_events_status ON bunny_webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_bunny_events_timestamp ON bunny_webhook_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_bunny_events_received ON bunny_webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_video_meta_guid ON video_metadata(video_guid);
CREATE INDEX IF NOT EXISTS idx_video_meta_uploader ON video_metadata(uploaded_by);
