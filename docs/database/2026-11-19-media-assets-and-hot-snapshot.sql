-- =====================================================================
-- 迁移：媒体资产变体登记表 + 热榜排序快照 + dramas 上两个列（可选）
-- 目标库：/opt/video-rr/storage/app.db（SQLite，WAL）
-- 兼容性：全部 IF NOT EXISTS / 幂等；不上锁改写主表；可在服务运行时执行。
-- 回滚：见文件末尾 DOWN 段（单独执行）。
-- =====================================================================

-- ---------- UP ----------
BEGIN;

-- 1) 媒体资产变体登记：变体文件是否已生成、多大、哪次构建产出。
--    只做「存在性登记」，不存图片本体；文件系统仍是唯一真相，此表用于：
--    a. 前端/后端判断某个 ![](变体) 是否值得给 srcset（避免每个 404 打一次 Node + nginx）；
--    b. 每日增量构建只扫「没有 w640 记录」的行，而不是遍历 14950 个文件；
--    c. 清理孤儿变体。
CREATE TABLE IF NOT EXISTS media_assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 归一化后的源相对路径，如 cover-jable-mikr-134.jpg / posters/poster-tos-portrait.jpg
  src_path      TEXT    NOT NULL,
  -- 源类型：cover | banner | poster | preview | avatar | other
  kind          TEXT    NOT NULL DEFAULT 'other',
  width         INTEGER NOT NULL,              -- 变体宽度（源图本身则存 0）
  height        INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  -- 变体相对路径（与 src_path 同目录下的 variants/ 内），源图本身存 ''
  variant_path  TEXT    NOT NULL DEFAULT '',
  content_type  TEXT    NOT NULL DEFAULT 'image/webp',
  built_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 源图 mtime（秒），用于「源图比变体新就重建」
  src_mtime     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (src_path, width)
);
CREATE INDEX IF NOT EXISTS idx_media_assets_kind_width ON media_assets(kind, width);
CREATE INDEX IF NOT EXISTS idx_media_assets_variant ON media_assets(variant_path);

-- 2) 热榜/首页的排序快照：把「播放+完播×2+收藏×3（30 天）」这类聚合从请求期挪到定时任务。
--    没有这张表时 /api/category?sort=hot 每次请求都要 MATERIALIZE 四个聚合子查询（实测 75–80ms/页）。
CREATE TABLE IF NOT EXISTS drama_hot_snapshot (
  drama_id     INTEGER PRIMARY KEY REFERENCES dramas(id) ON DELETE CASCADE,
  window_days  INTEGER NOT NULL DEFAULT 30,
  play_count   INTEGER NOT NULL DEFAULT 0,
  danmu_count  INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  fav_count    INTEGER NOT NULL DEFAULT 0,
  hot_score    INTEGER NOT NULL DEFAULT 0,
  computed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drama_hot_snapshot_score ON drama_hot_snapshot(hot_score DESC, drama_id DESC);

COMMIT;

-- 3) dramas 上的两个复合索引（可选，先量再建；见 ANALYSIS 段的风险说明）
--    115k 行规模下建索引耗时实测请用 `time sqlite3 app.db "..."` 先量，生产建议放低峰。
-- CREATE INDEX IF NOT EXISTS idx_dramas_status_category_id ON dramas(status, category, id DESC);
-- CREATE INDEX IF NOT EXISTS idx_dramas_status_adult_pub  ON dramas(status, is_adult, published_at DESC);

-- =====================================================================
-- DOWN（回滚；只删本迁移新增对象，不触碰既有表）
-- =====================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS idx_drama_hot_snapshot_score;
-- DROP TABLE IF EXISTS drama_hot_snapshot;
-- DROP INDEX IF EXISTS idx_media_assets_variant;
-- DROP INDEX IF EXISTS idx_media_assets_kind_width;
-- DROP TABLE IF EXISTS media_assets;
-- COMMIT;
-- 注：一旦回滚，仍会保留 dramas 表上历史已有的 idx_dramas_adult_status 等，不回溯。
