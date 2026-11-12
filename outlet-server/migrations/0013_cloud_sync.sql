-- 0013_cloud_sync.sql — P4-05. The outbox sent up to the hub (pos-backend/hub, POST /v1/pos/sync/batches).

-- 1. This database's sync stream: the hub keeps each outlet database's records apart, so a reinstalled or restored
--    outlet (whose outbox numbers start again) never overwrites what it sent before. A new stream is started only by
--    ResetSyncStream (admin), after the hub reports a conflict.
CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stream_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);
INSERT INTO sync_state (id, stream_id, started_at) VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 2. The rows still to send (the outbox is kept for good; this keeps finding them quick).
CREATE INDEX idx_outbox_unsent ON outbox (seq) WHERE sent_at IS NULL;
