#!/usr/bin/env bash
# 刷新 jable 直链并推送到生产（在没有 Cloudflare 绕过的机器上跑：需要本机 Chromium/Edge）。
#
# 为什么必须在本机跑：生产服务器直连 jable.tv 是 403（Cloudflare managed challenge），
# 也没装浏览器；而本机过掉挑战后每页只要 ~0.7 秒。所以刷新在本地做，结果推上去。
#
# 用法：
#   bash deploy/sync-adult.sh                 # 刷新 + 推送（默认 HOST=hk；模式见下）
#   HOST=hk MODE=paid TRIAL=60 bash deploy/sync-adult.sh
#   SKIP_REFRESH=1 bash deploy/sync-adult.sh  # 只把本地已有链接推过去
#   DRY=1 bash deploy/sync-adult.sh           # 只刷新 + 导出，不上传不改远程库
#
# 成人频道默认模式只有一处定义：scripts/lib/adult-mode.mjs（MH_ADULT_MODE 可覆盖），
# 这里不再写死 free/subscription 字面量，改一处三边同时生效。
#
# 依赖：本机 node、ssh 配置里能直连 $HOST、生产已部署 scripts/adult-migrate.mjs
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${HOST:-hk}
REMOTE_APP=${REMOTE_APP:-/opt/video-rr}
MODE=${MODE:-$(node scripts/adult-mode.mjs --print-default)}
TRIAL=${TRIAL:-0}
EXPORT=${EXPORT:-storage/adult-export.json}

# 下面这些值会被拼进远端 shell 命令，先白名单校验再单引号包裹，避免空格/分号注入
die() { echo "$1" >&2; exit 2; }
want_host() { case "$1" in ''|*[!A-Za-z0-9._@-]*) die "非法 HOST：$1";; esac; }
want_abs_path() { case "$1" in /*) ;; *) die "REMOTE_APP 必须是绝对路径：$1";; esac; case "$1" in *[!A-Za-z0-9._/-]*) die "非法 REMOTE_APP：$1";; esac; }
want_uint() { case "$1" in ''|*[!0-9]*) die "非法数值：$1";; esac; }
q() { printf "'%s'" "$1"; }

want_host "$HOST"
want_abs_path "$REMOTE_APP"
want_uint "$TRIAL"
node scripts/adult-mode.mjs --validate "$MODE" || die "非法 MODE：$MODE"

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

echo "==> 5/5 写入远程库 $REMOTE_APP/storage/app.db（模式 $MODE，试看 ${TRIAL}s）"
ssh "$HOST" "cd $(q "$REMOTE_APP") && MH_DB=$(q "$REMOTE_APP/storage/app.db") node scripts/adult-migrate.mjs /tmp/adult-export.json --mode $(q "$MODE") --trial $(q "$TRIAL")"

echo
echo "完成。远程验证："
echo "  ADMIN_PASSWORD=*** USER_EMAIL=*** bash deploy/verify-adult.sh"
