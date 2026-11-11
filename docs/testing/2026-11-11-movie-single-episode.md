# 电影单集正片迁移验证

日期：2026-11-11

## 自动化测试

```text
node --test test/movie-episodes.test.mjs
```

覆盖：

- 3 集电影合并为 1 个正片。
- 合并后的总时长和 `hls_path` 正确。
- 第 2..3 集标记 `status='merged'` 且清空 `hls_path`。
- 观看进度按前序分集时长偏移到第 1 集。
- 弹幕按同样偏移合并到第 1 集。
- `free_episodes` 归零。
- 合并播放列表包含 6 个分片和 2 个 `#EXT-X-DISCONTINUITY`。
- 数据库备份文件生成。

完整回归：

```text
npm test
# 134 passed, 0 failed
```

## 本地 dry-run

```text
node scripts/migrate-movie-episodes.mjs
# 没有需要迁移的多集电影
```

本地 `storage/app.db` 当前只有 1 部占位电影，不能代表线上片库。上线前必须在真实片库环境先执行 dry-run，确认电影清单和 HLS 完整性后再加 `--apply`。

## 边界

- 迁移默认 dry-run，不写库。
- `--apply` 会先生成 SQLite 备份，再写库。
- HLS 分片优先硬链接，跨文件系统时回退复制。
- 原始分集 HLS 目录保留，回滚不需要重新转码。
