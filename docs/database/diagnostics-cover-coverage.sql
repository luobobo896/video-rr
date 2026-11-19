-- =====================================================================
-- 诊断用只读脚本：封面变体覆盖率 / 孤儿变体 / 排序谓词索引命中
-- 全部只读，不改库（只 CREATE TEMP VIEW）。生产执行：
--   sqlite3 -readonly /opt/video-rr/storage/app.db < docs/database/diagnostics-cover-coverage.sql
-- =====================================================================
.timer on
.headers on

-- 1) 线上库对 cover_url 的引用分布（前 12 个前缀）
SELECT substr(cover_url, 1, 22) AS prefix, COUNT(*) AS n
FROM dramas WHERE cover_url IS NOT NULL AND cover_url <> ''
GROUP BY prefix ORDER BY n DESC LIMIT 12;

-- 2) 是否还有指向「原图 / 变体」的 query-string 引用（变体会拼上 ?v=... 保留）
SELECT COUNT(*) AS cover_url_with_query
FROM dramas WHERE cover_url LIKE '%?%';

-- 3) 封面变体候选：哪些 drama 的封面引用了本地 /media/images/ 但 w640 文件可能不存在
--    （存在性必须在 shell 里判，SQL 不碰文件系统；这里只导出清单）
SELECT id, cover_url FROM dramas
WHERE status = 'published' AND cover_url LIKE '/media/images/%'
LIMIT 50;

-- 4) 变体覆盖率按来源前缀统计
SELECT
  CASE
    WHEN cover_url LIKE '/media/images/cover-ja%' THEN 'jable'
    WHEN cover_url LIKE '/media/images/cover-hg%' THEN 'huangguo'
    WHEN cover_url LIKE '/media/images/cover-ar%' THEN 'archive'
    WHEN cover_url LIKE 'https://%' THEN 'remote-cdn'
    ELSE 'seed-or-other'
  END AS source,
  COUNT(*) AS n,
  SUM(CASE WHEN cover_url LIKE '%?%' THEN 1 ELSE 0 END) AS with_query
FROM dramas
GROUP BY source ORDER BY n DESC;

-- 5) 排序谓词能否命中索引：把 /api/category 的四种排序各跑一次 EXPLAIN
EXPLAIN QUERY PLAN
SELECT d.id FROM dramas d WHERE d.status='published' AND COALESCE(d.is_adult,0)=0
ORDER BY d.id DESC LIMIT 24;

EXPLAIN QUERY PLAN
SELECT d.id FROM dramas d WHERE d.status='published' AND d.is_adult=1
ORDER BY d.id DESC LIMIT 24;

EXPLAIN QUERY PLAN
SELECT d.id FROM dramas d WHERE d.status='published' AND d.is_adult=1
ORDER BY d.score DESC, d.id DESC LIMIT 24;

-- 6) 热榜聚合的耗时（无 drama_hot_snapshot 时每次请求都跑）
SELECT d.id FROM dramas d
 LEFT JOIN (SELECT drama_id, COUNT(*) AS play_count FROM play_events
   WHERE created_at >= datetime('now','-30 days') GROUP BY drama_id) pe ON pe.drama_id = d.id
 LEFT JOIN (SELECT e.drama_id, COUNT(*) AS c FROM danmus m JOIN episodes e ON e.id = m.episode_id
   WHERE m.status='approved' GROUP BY e.drama_id) dm ON dm.drama_id = d.id
 LEFT JOIN (SELECT drama_id, COUNT(*) AS c FROM comments WHERE status='approved' GROUP BY drama_id) cm ON cm.drama_id = d.id
 LEFT JOIN (SELECT drama_id, COUNT(*) AS c FROM favorites GROUP BY drama_id) fv ON fv.drama_id = d.id
 WHERE d.status='published' AND d.is_adult=1
 ORDER BY (COALESCE(pe.play_count,0) + COALESCE(dm.c,0)*2 + COALESCE(fv.c,0)*3) DESC,
          COALESCE(dm.c,0) + COALESCE(cm.c,0) DESC
 LIMIT 24;

-- 7) 标签面量聚合（/api/category 的 facets.genres / facets.tags）
SELECT COUNT(DISTINCT dt.drama_id) AS tagged_dramas, COUNT(*) AS rows_total
FROM drama_tags dt JOIN dramas d ON d.id = dt.drama_id WHERE d.status='published';
