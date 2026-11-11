-- 成人内容标记：既有内容默认非成人。
-- SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS；应用启动由 ensureOpsSchema()
-- 先查 PRAGMA table_info 再执行。本文件仅作一次性人工迁移参考，不能重复手工执行。
ALTER TABLE dramas ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dramas ADD COLUMN release_date TEXT;
ALTER TABLE dramas ADD COLUMN updated_at TEXT;
UPDATE dramas SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE tags ADD COLUMN scope TEXT NOT NULL DEFAULT 'general';

CREATE INDEX IF NOT EXISTS idx_dramas_adult_status
  ON dramas(is_adult, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_tags_scope_parent
  ON tags(scope, parent_id, sort);

-- 成人菜单配置独立存放在 settings.adultMenu，不写入 settings.site。
-- value 为 JSON：{"enabled":true,"labelZh":"成人","labelEn":"Adult"}
INSERT INTO settings (key, value)
VALUES ('adultMenu', '{"enabled":true,"labelZh":"成人","labelEn":"Adult"}')
ON CONFLICT(key) DO NOTHING;

-- 8 个成人标签组和 111 个标签由 ensureAdultTagSeed() 仅在首次启动播种，
-- 成功后写入 settings.adult.tagSeedVersion；后台删除或改名后，重启不再回填。
