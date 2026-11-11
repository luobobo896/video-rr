-- 分集音轨/字幕与登录用户偏好
-- 运行时代码在 server/db.mjs 中幂等创建；本文件保留可审查的 Schema 口径。

CREATE TABLE IF NOT EXISTS episode_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'subtitle')),
  language TEXT NOT NULL,
  edition TEXT NOT NULL DEFAULT 'original',
  label TEXT NOT NULL,
  source TEXT,
  uri TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, kind, language, edition)
);

CREATE INDEX IF NOT EXISTS idx_episode_tracks_episode
  ON episode_tracks(episode_id, kind, is_default);

CREATE TABLE IF NOT EXISTS user_track_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'subtitle')),
  language TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  off INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, drama_id, kind)
);
