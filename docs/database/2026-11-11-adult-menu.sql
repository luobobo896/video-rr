-- 成人内容标记：既有内容默认非成人。
-- SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS；应用启动由 ensureOpsSchema()
-- 先查 PRAGMA table_info 再执行。本文件仅作一次性人工迁移参考，不能重复手工执行。
ALTER TABLE dramas ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_dramas_adult_status
  ON dramas(is_adult, status, id DESC);

-- 成人菜单配置独立存放在 settings.adultMenu，不写入 settings.site。
-- value 为 JSON：{"enabled":true,"labelZh":"成人","labelEn":"Adult"}
INSERT INTO settings (key, value)
VALUES ('adultMenu', '{"enabled":true,"labelZh":"成人","labelEn":"Adult"}')
ON CONFLICT(key) DO NOTHING;
