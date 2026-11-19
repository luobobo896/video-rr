#!/usr/bin/env bash
# 影巢（video-rr）HK 一键部署：Node 服务 + nginx 子路径（无直播模块）
# 用法：bash /opt/video-rr/deploy/install-hk.sh   （幂等）
set -euo pipefail

APP=/opt/video-rr
cd "$APP"
DOMAIN=hk.hsddns.com
SITE=/etc/nginx/sites-enabled/whatsapp-ai-hk
SNIPPET=/etc/nginx/snippets/video-rr.conf
HTTPCONF=/etc/nginx/conf.d/10-video-rr-http.conf
APP_PORT=8787
BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

command -v node >/dev/null || { echo "缺少 node >=22.5（需要 node:sqlite）"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null || { echo "node 版本过低：$(node -v)"; exit 1; }
if [ -f "$APP/.env" ]; then
  set -a; . "$APP/.env"; set +a
fi
DB_PATH=${MH_DB:-"$APP/storage/app.db"}
log "0/7 备份数据库"
if [ -f "$DB_PATH" ]; then
  BK="$APP/storage/backup/app.db.$(date +%Y%m%d-%H%M%S).sqlite"
  mkdir -p "$APP/storage/backup"
  (
    umask 077
    temp=$(mktemp -d "$APP/storage/backup/.snapshot.XXXXXXXX")
    trap 'rm -rf -- "$temp"' EXIT
    node --input-type=module - "$DB_PATH" "$temp/app.db" <<'JS'
import { DatabaseSync } from 'node:sqlite'

const [source, target] = process.argv.slice(2)
const db = new DatabaseSync(source, { readOnly: true })
try {
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare('VACUUM INTO ?').run(target)
} finally {
  db.close()
}
const snapshot = new DatabaseSync(target, { readOnly: true })
try {
  const rows = snapshot.prepare('PRAGMA integrity_check').all()
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('SQLite 备份完整性校验失败')
} finally {
  snapshot.close()
}
JS
    mv -- "$temp/app.db" "$BK"
  )
  echo "已备份：$BK"
  ls -1t "$APP"/storage/backup/app.db.*.sqlite | tail -n +11 | xargs -r rm -f
fi

log "1/7 依赖检查与前端构建"
mkdir -p "$APP/storage/hls" "$APP/storage/uploads" "$APP/storage/images"
command -v ffmpeg >/dev/null || { echo "缺少 ffmpeg"; exit 1; }
command -v npm >/dev/null || { echo "缺少 npm（构建 Vue + Vite 前端需要）"; exit 1; }

# 每次都从当前源码重建，避免部署包里的旧 dist 或漏构建让线上继续跑旧前端。
if [ -f package-lock.json ]; then
  npm ci --include=dev --no-audit --no-fund
else
  echo "缺少 package-lock.json：旧部署包或源码不完整"
  exit 1
fi
npm run build
[ -s dist/client/index.html ] || { echo "C 端构建产物缺失"; exit 1; }
[ -s dist/admin/index.html ] || { echo "后台构建产物缺失"; exit 1; }

# Redis：限流滑动窗口。未安装则装上并只监听回环；装不上也不阻塞（服务自动降级为进程内内存）
if command -v redis-server >/dev/null; then
  systemctl enable --now redis-server >/dev/null 2>&1 || true
  echo "Redis 已启用：$(redis-cli ping 2>/dev/null || echo '未响应')"
else
  echo "未安装 redis-server，尝试安装……"
  if DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server >/dev/null 2>&1; then
    systemctl enable --now redis-server >/dev/null 2>&1 || true
    echo "Redis 安装完成：$(redis-cli ping 2>/dev/null || echo '未响应')"
  else
    echo "警告：Redis 安装失败，限流将退化为单进程内存（多实例部署不可用）"
  fi
fi

log "2/7 生成 .env（播放签名 / 限流 / 链上监听）"
if [ ! -f "$APP/.env" ]; then
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-40)
  LINK=$(head -c 24 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32)
  cat > "$APP/.env" <<EOF
PORT=$APP_PORT
MH_SECRET=$SECRET
MH_LINK_SECRET=$LINK
NODE_ENV=production
EOF
  chmod 600 "$APP/.env"
fi
if ! grep -q '^MH_LINK_SECRET=' "$APP/.env"; then
  LINK=$(head -c 24 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32)
  printf 'MH_LINK_SECRET=%s\n' "$LINK" >> "$APP/.env"
  chmod 600 "$APP/.env"
fi
if ! grep -q '^MH_CONFIG_KEYS=' "$APP/.env"; then
  CONFIG_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  printf 'MH_CONFIG_KEYS=1:%s\nMH_CONFIG_KEY_VERSION=1\n' "$CONFIG_KEY" >> "$APP/.env"
  chmod 600 "$APP/.env"
fi
if ! grep -q '^MH_OTP_SECRET=' "$APP/.env"; then
  OTP=$(head -c 24 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32)
  printf 'MH_OTP_SECRET=%s\n' "$OTP" >> "$APP/.env"
fi
if ! grep -q '^MH_REDIS_URL=' "$APP/.env"; then
  printf 'MH_REDIS_URL=redis://127.0.0.1:6379/0\n' >> "$APP/.env"
fi
if ! grep -q '^MH_LINK_TTL=' "$APP/.env"; then
  printf '# 播放地址签名有效期（秒）；绑定 UA 指纹，换 UA 即失效\nMH_LINK_TTL=300\n' >> "$APP/.env"
fi
if ! grep -q '^MH_TRON_API_KEY=' "$APP/.env"; then
  cat >> "$APP/.env" <<'EOF'
# ---- USDT 链上监听（TronGrid）----
# 免费额度够用；限流时申请 API Key 填这里
MH_TRON_API_KEY=
MH_TRON_API_BASE=https://api.trongrid.io
MH_USDT_WATCH=1
EOF
fi
if ! grep -q '^MH_BASE_PATH=' "$APP/.env"; then
  printf '# nginx 已剥掉子路径前缀（proxy_pass 带尾斜杠），Node 侧回跳地址需要它\nMH_BASE_PATH=/video\n' >> "$APP/.env"
fi
if ! grep -q '^MH_PLAY_TTL_MAX=' "$APP/.env"; then
  printf '# 播放签名最长有效期（秒），需覆盖单集时长；nginx HLS 缓存必须短于它\nMH_PLAY_TTL_MAX=7200\n' >> "$APP/.env"
fi
if ! grep -q '^MH_UPLOAD_MAX_BYTES=' "$APP/.env"; then
  printf '# 上传单文件上限（字节），流式写盘不再整块驻内存\nMH_UPLOAD_MAX_BYTES=2147483648\n' >> "$APP/.env"
fi
# 旧版本曾写入 MH_EMAIL_DEV=1（验证码回显），本版本一律移除
if grep -q '^MH_EMAIL_DEV=' "$APP/.env"; then
  sed -i '/^MH_EMAIL_DEV=/d' "$APP/.env"
  echo "已移除 MH_EMAIL_DEV（验证码不再回显，需在后台配置邮件通道）"
fi
chmod 600 "$APP/.env"
set -a; . "$APP/.env"; set +a
[ -n "${MH_LINK_SECRET:-}" ] || { echo "MH_LINK_SECRET 缺失"; exit 1; }

log "3/7 关闭旧直播组件（本版本无直播）"
systemctl disable --now mediamtx.service 2>/dev/null || true
rm -f /etc/systemd/system/mediamtx.service
systemctl daemon-reload

log "4/7 systemd 服务"
# 服务不再以 root 跑：默认用户 videorr（MH_USER 可覆盖），不存在就建一个系统用户，
# 并把 data/日志目录交给它，否则 SQLite 与 HLS 写入会 EACCES。
MH_USER=${MH_USER:-videorr}
if ! id -u "$MH_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP" --shell /usr/sbin/nologin "$MH_USER" 2>/dev/null \
    || { echo "创建用户 $MH_USER 失败（可用 MH_USER=已有用户 重跑）"; exit 1; }
  echo "已创建系统用户：$MH_USER"
fi
chown -R "$MH_USER":"$MH_USER" "$APP/storage" 2>/dev/null || true
touch /var/log/video-rr.log /var/log/video-rr.err.log
chown "$MH_USER":"$MH_USER" /var/log/video-rr.log /var/log/video-rr.err.log
install -m 644 "$APP/deploy/video-rr.service" /etc/systemd/system/video-rr.service
sed -i "s/^User=.*/User=$MH_USER/; s/^Group=.*/Group=$MH_USER/" /etc/systemd/system/video-rr.service
systemctl daemon-reload
systemctl enable video-rr.service >/dev/null 2>&1
systemctl restart video-rr.service
sleep 2
curl -fsS -A "$BROWSER_UA" "http://127.0.0.1:$APP_PORT/api/constants" >/dev/null && echo "API 正常" || { echo "API 启动失败，看 /var/log/video-rr.err.log"; exit 1; }
node scripts/rewrite-cover-urls.mjs || true
node scripts/build-poster-wall.mjs || echo "警告：海报墙变体生成失败（不阻断主站）"

log "5/7 nginx 片段"
# 播放签名由 Node 校验（auth_request → /media-auth），片段里不再有密钥占位符
install -m 644 "$APP/deploy/nginx-video.snippet.conf" "$SNIPPET"
install -m 644 "$APP/deploy/nginx-video-http.conf" "$HTTPCONF"

# HTTP/2 兼容：nginx ≥1.25.1 支持独立的 `http2 on;`，但站点块里若已有 `listen 443 ssl http2;`，
# 两种写法同时启用会让 nginx -t 报 "duplicate listen options" 而整体 reload 失败。
# 检测到旧写法就删掉片段里那行，只保留站点块里的参数。
if grep -qE '^[^#]*listen[^;]*http2' "$SITE" 2>/dev/null; then
  sed -i '/^http2 on;$/d' "$SNIPPET"
  echo "站点已用 listen ... http2，片段里已去掉独立的 http2 on;（避免重复启用）"
else
  echo "站点未启用 http2 参数，片段里的 http2 on; 生效（nginx ≥1.25.1）"
fi

log "6/7 注入 site 配置 + 并发参数"
if ! grep -q 'video-rr.conf' "$SITE"; then
  cp -a "$SITE" "$SITE.bak-video-$(date +%Y%m%d%H%M%S)"
  # 注入必须真的插进去了才算成功：既没有 pomodoro marker 也没有 `listen 443 ssl;` 时
  # 原实现会照样写回文件并打印 injected include，配置其实没变，线上 404 还得人工翻备份找原因。
  if ! python3 - "$SITE" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
marker = 'include /etc/nginx/snippets/pomodoro-focus.conf; # pomodoro-focus'
inject = '\n    include /etc/nginx/snippets/video-rr.conf; # video-rr'
if 'video-rr.conf' in text:
    print('include already present')
    sys.exit(0)
if marker in text:
    text = text.replace(marker, marker + inject, 1)
    anchor = 'pomodoro-focus include'
elif 'listen 443 ssl;' in text:
    text = text.replace('listen 443 ssl;', inject.strip() + '\n    listen 443 ssl;', 1)
    anchor = 'listen 443 ssl;'
else:
    sys.stderr.write('找不到注入锚点：既没有 pomodoro-focus include，也没有 “listen 443 ssl;”\n')
    sys.exit(3)
open(path, 'w', encoding='utf-8').write(text)
print('injected include at %s' % anchor)
PY
  then
    echo "nginx include 注入失败：$SITE 结构不匹配，未修改该文件（备份见 $SITE.bak-video-*）" >&2
    echo "请手工把下面这行加进 server 块，然后重新执行本脚本：" >&2
    echo "    include /etc/nginx/snippets/video-rr.conf; # video-rr" >&2
    exit 1
  fi
  grep -q 'video-rr.conf' "$SITE" || { echo "注入后仍未在 $SITE 找到 video-rr.conf" >&2; exit 1; }
fi

NGX=/etc/nginx/nginx.conf
sed -i 's/worker_connections 768;/worker_connections 65535;/' "$NGX"
grep -q 'worker_rlimit_nofile' "$NGX" || sed -i '0,/worker_processes auto;/s//worker_processes auto;\nworker_rlimit_nofile 100000;/' "$NGX"
nginx -t
systemctl reload nginx

log "7/7 健康检查"
# 只 printf 状态码的“检查”等于没检查：部署脚本必须以退出码表态，否则 CI / 人工都看不出子路径挂错。
health_failed=0
want_code() { # path expected-codes-csv
  local p=$1 want=$2 code
  code=$(curl -sk -A "$BROWSER_UA" -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$p")
  if [[ ",$want," == *",$code,"* ]]; then
    printf '  %-24s %s\n' "$p" "$code"
  else
    printf '  %-24s %s（期望 %s）\n' "$p" "$code" "$want"
    health_failed=1
  fi
}
want_code /video/ 200
want_code /video-admin/ 200
want_code /video/api/constants 200
# 未签名直出必须被拦住（401 或 403 都算拦住了）
want_code /video/media/hls/1/index.m3u8 401,403
curl -fsS -A "$BROWSER_UA" "http://127.0.0.1:$APP_PORT/" | grep -q 'id="app"' || { echo "C 端未加载 Vue 构建产物"; exit 1; }
curl -fsS -A "$BROWSER_UA" "http://127.0.0.1:$APP_PORT/admin/" | grep -q 'id="vue-root"' || { echo "后台未加载 Vue 构建产物"; exit 1; }
[ "$health_failed" = 0 ] || { echo "健康检查未通过：nginx 子路径或 Node 服务异常，见上面状态码" >&2; exit 1; }
echo
echo "完成：C 端 https://$DOMAIN/video/   后台 https://$DOMAIN/video-admin/"
CRED="$APP/storage/admin-initial-passwords.txt"
if [ -f "$CRED" ]; then
  echo "后台初始口令：$CRED（0600，首次登录强制改密；改完请删除该文件）"
  echo "  账号：$(cut -f1 "$CRED" | grep -v '^#' | tr '\n' ' ')"
else
  echo "后台口令未重新生成（已有账号保持不变）。忘记口令用：node scripts/reset-admin-password.mjs <用户名>"
fi
echo "自检：bash $APP/deploy/verify-hk.sh"
