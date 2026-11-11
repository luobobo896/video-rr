-- 游客试看额度：同一 visitor + 内容 24 小时内一次，单次 15 秒。
-- 运行时代码在 server/db.mjs 中幂等创建。

CREATE TABLE IF NOT EXISTS guest_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  episode_no INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  ua TEXT
);

CREATE INDEX IF NOT EXISTS idx_guest_trials_lookup
  ON guest_trials(visitor_id, drama_id, started_at DESC);
