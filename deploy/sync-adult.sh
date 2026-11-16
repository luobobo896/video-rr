#!/usr/bin/env bash
# 刷新 jable 直链并推送到生产（在没有 Cloudflare 绕过的机器上跑：需要本机 Chromium/Edge）。
#
# 为什么必须在本机跑：生产服务器直连 jable.tv 是 403（Cloudflare managed challenge），
# 也没装浏览器；而本机过掉挑战后每页只要 ~0.7 秒。所以刷新在本地做，结果推上去。
#
# 用法：
#   bash deploy/sync-adult.sh                 # 刷新 + 推送（默认 HOST=hk MODE=free）
#   HOST=hk MODE=subscription TRIAL=60 bash deploy/sync-adult.sh
#   SKIP_REFRESH=1 bash deploy/sync-adult.sh  # 只把本地已有链接推过去
#   DRY=1 bash deploy/sync-adult.sh           # 只刷新 + 导出，不上传不改远程库
#
# 依赖：本机 node、ssh 配置里能直连 $HOST、生产已部署 scripts/adult-migrate.mjs
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${HOST:-hk}
REMOTE_APP=${REMOTE_APP:-/opt/video-rr}
MODE=${MODE:-free}
TRIAL=${TRIAL:-0}
EXPORT=${EXPORT:-storage/adult-export.json}

if [ "${SKIP_REFRESH:-0}" != "1" ]; then
  echo "==> 1/5 刷新快过期的直链（需要本机浏览器过 Cloudflare）"
  node scripts/jable-import.mjs --refresh --max-left "${MAX_LEFT:-40}"
else
  echo "==> 1/5 跳过刷新（SKIP_REFRESH=1）"
fi

echo "==> 2/5 导出成人片"
node scripts/adult-export.mjs "$EXPORT"

echo "==> 3/5 增量推送新图片"
node scripts/push-images.mjs

if [ "${DRY:-0}" = "1" ]; then
  echo "==> DRY=1，到此为止（未上传、未改远程库）"
  exit 0
fi

echo "==> 4/5 上传到 $HOST"
scp -q "$EXPORT" "$HOST:/tmp/adult-export.json"

echo "==> 5/5 写入远程库 $REMOTE_APP/storage/app.db"
ssh "$HOST" "cd $REMOTE_APP && MH_DB=$REMOTE_APP/storage/app.db node scripts/adult-migrate.mjs /tmp/adult-export.json --mode $MODE --trial $TRIAL"

echo
echo "完成。远程验证："
echo "  ADMIN_PASSWORD=*** USER_EMAIL=*** bash deploy/verify-adult.sh"
