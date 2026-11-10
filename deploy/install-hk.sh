#!/usr/bin/env bash
# 影巢（video-rr）HK 一键部署：Node 服务 + nginx 子路径（无直播模块）
# 用法：bash /opt/video-rr/deploy/install-hk.sh   （幂等）
set -euo pipefail

APP=/opt/video-rr
DOMAIN=hk.hsddns.com
SITE=/etc/nginx/sites-enabled/whatsapp-ai-hk
SNIPPET=/etc/nginx/snippets/video-rr.conf
HTTPCONF=/etc/nginx/conf.d/10-video-rr-http.conf
APP_PORT=8787

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "1/7 依赖检查"
mkdir -p "$APP/storage/hls" "$APP/storage/uploads" "$APP/storage/images"
command -v ffmpeg >/dev/null || { echo "缺少 ffmpeg"; exit 1; }
command -v node >/dev/null || { echo "缺少 node >=22.5（需要 node:sqlite）"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null || { echo "node 版本过低：$(node -v)"; exit 1; }

log "2/7 生成 .env（含播放签名密钥）"
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
# 邮箱验证码：配置 SMTP 后删掉 MH_EMAIL_DEV=1，验证码就只发邮件、不再回显
if ! grep -q '^MH_EMAIL_DEV=' "$APP/.env"; then
  cat >> "$APP/.env" <<'EOF'
# ---- 邮件（填入后删除下面一行 MH_EMAIL_DEV，验证码将只发邮件）----
MH_EMAIL_DEV=1
#MH_SMTP_HOST=smtp.example.com
#MH_SMTP_PORT=465
#MH_SMTP_SECURE=1
#MH_SMTP_USER=no-reply@example.com
#MH_SMTP_PASS=
#MH_SMTP_FROM=no-reply@example.com
#MH_SMTP_FROM_NAME=影巢
EOF
  chmod 600 "$APP/.env"
fi
set -a; . "$APP/.env"; set +a
[ -n "${MH_LINK_SECRET:-}" ] || { echo "MH_LINK_SECRET 缺失"; exit 1; }

log "3/7 关闭旧直播组件（本版本无直播）"
systemctl disable --now mediamtx.service 2>/dev/null || true
rm -f /etc/systemd/system/mediamtx.service
systemctl daemon-reload

log "4/7 systemd 服务"
install -m 644 "$APP/deploy/video-rr.service" /etc/systemd/system/video-rr.service
systemctl daemon-reload
systemctl enable video-rr.service >/dev/null 2>&1
systemctl restart video-rr.service
sleep 2
curl -fsS "http://127.0.0.1:$APP_PORT/api/constants" >/dev/null && echo "API 正常" || { echo "API 启动失败，看 /var/log/video-rr.err.log"; exit 1; }
node scripts/rewrite-cover-urls.mjs || true

log "5/7 nginx 片段（注入播放签名密钥）"
sed "s/__MH_LINK_SECRET__/$MH_LINK_SECRET/g" "$APP/deploy/nginx-video.snippet.conf" > "$SNIPPET"
install -m 644 "$APP/deploy/nginx-video-http.conf" "$HTTPCONF"

log "6/7 注入 site 配置 + 并发参数"
if ! grep -q 'video-rr.conf' "$SITE"; then
  cp -a "$SITE" "$SITE.bak-video-$(date +%Y%m%d%H%M%S)"
  python3 - "$SITE" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
marker = 'include /etc/nginx/snippets/pomodoro-focus.conf; # pomodoro-focus'
inject = '\n    include /etc/nginx/snippets/video-rr.conf; # video-rr'
if 'video-rr.conf' not in text:
    if marker in text:
        text = text.replace(marker, marker + inject, 1)
    else:
        text = text.replace('listen 443 ssl;', inject.strip() + '\n    listen 443 ssl;', 1)
    open(path, 'w', encoding='utf-8').write(text)
    print('injected include')
else:
    print('include already present')
PY
fi

NGX=/etc/nginx/nginx.conf
sed -i 's/worker_connections 768;/worker_connections 65535;/' "$NGX"
grep -q 'worker_rlimit_nofile' "$NGX" || sed -i '0,/worker_processes auto;/s//worker_processes auto;\nworker_rlimit_nofile 100000;/' "$NGX"
nginx -t
systemctl reload nginx

log "7/7 健康检查"
for path in /video/ /video-admin/ /video/api/constants; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$path")
  printf '  %-24s %s\n' "$path" "$code"
done
unsigned=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/video/media/hls/1/index.m3u8")
printf '  %-24s %s（应为 403）\n' 'unsigned hls' "$unsigned"
echo
echo "完成：C 端 https://$DOMAIN/video/   后台 https://$DOMAIN/video-admin/"
echo "后台：admin / admin123（另含 ops01 / fin01 / cs01，密码同为 admin123，务必改掉）"
