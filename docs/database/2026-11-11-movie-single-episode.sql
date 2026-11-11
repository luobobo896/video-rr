-- 多集电影 -> 单集正片
-- HLS 合并、历史进度偏移和弹幕偏移由 scripts/migrate-movie-episodes.mjs 计算；
-- 本文件记录预检 SQL 与数据库变更口径。

-- 1) 预检：列出仍有多集的电影
SELECT d.id, d.title, COUNT(e.id) AS episodes
FROM dramas d
JOIN episodes e ON e.drama_id = d.id
WHERE d.category = 'MOVIE'
GROUP BY d.id, d.title
HAVING COUNT(e.id) > 1
ORDER BY d.id;

-- 2) 迁移事务模板
-- 变量由迁移脚本按实际电影计算：
--   <drama_id>        电影 ID
--   <first_episode_id> 第 1 集 ID
--   <merged_hls_path> /media/hls/<first_episode_id>/merged/index.m3u8
--   <merged_duration> 合并后总时长（秒）
BEGIN;

UPDATE episodes
SET hls_path = '<merged_hls_path>',
    duration = <merged_duration>,
    title = '正片',
    status = 'ready',
    progress = 100,
    error = NULL
WHERE id = <first_episode_id>;

UPDATE episodes
SET status = 'merged',
    hls_path = NULL
WHERE drama_id = <drama_id>
  AND no > 1;

-- 电影只有一个正片；避免原先按集配置的免费集数把整部电影放成免费。
UPDATE content_policies
SET free_episodes = 0
WHERE drama_id = <drama_id>
  AND free_episodes > 0;

-- history / danmus 的偏移更新必须按每集实际时长计算，见迁移脚本。
COMMIT;

-- 3) 回滚
-- 恢复迁移前 SQLite 备份；删除 <first_episode_id>/merged/。
-- 原始分集 HLS 目录不删除，恢复数据库后仍可继续播放。
