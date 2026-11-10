#!/usr/bin/env bash
# 影巢（video-rr）HK 服务器一键部署：Node 服务 + MediaMTX + nginx 子路径
# 用法（在服务器上以 root 执行）：
#   bash /opt/video-rr/deploy/install-hk.sh
# 幂等：重复执行只会更新配置并重启服务。
set -euo pipefail

APP=/opt/video-rr
DOMAIN=hk.hsddns.com
SITE=/etc/nginx/sites-enabled/whatsapp-ai-hk
SNIPPET=/etc/nginx/snippets/video-rr.conf
HTTPCONF=/etc/nginx/conf.d/10-video-rr-http.conf
RTMP_PORT=1935
HLS_PORT=8890
APP_PORT=8787

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "1/8 目录与依赖"
mkdir -p "$APP/storage/hls" "$APP/storage/uploads" "$APP/storage/tools"
apt-get install -y --no-install-recommends ffmpeg curl ca-certificates >/dev/null 2>&1 || true
command -v ffmpeg >/dev/null || { echo "缺少 ffmpeg，请先 apt-get install -y ffmpeg"; exit 1; }
command -v node   >/dev/null || { echo "缺少 node（需要 >=22.5，支持 node:sqlite）"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null || { echo "当前 node 版本不支持 node:sqlite：$(node -v)"; exit 1; }

log "2/8 生成 .env（首次）"
if [ ! -f "$APP/.env" ]; then
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-40)
  cat > "$APP/.env" <<EOF
PORT=$APP_PORT
MH_SECRET=$SECRET
MH_RTMP_PORT=$RTMP_PORT
MH_HLS_PORT=$HLS_PORT
NODE_ENV=production
EOF
  chmod 600 "$APP/.env"
fi

log "3/8 MediaMTX 二进制"
if [ ! -x "$APP/storage/tools/mediamtx" ]; then
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/mediamtx.tar.gz" \
    https://github.com/bluenviron/mediamtx/releases/download/v1.15.2/mediamtx_v1.15.2_linux_amd64.tar.gz
  tar -xzf "$TMP/mediamtx.tar.gz" -C "$APP/storage/tools"
  chmod +x "$APP/storage/tools/mediamtx"
  rm -rf "$TMP"
fi
[ -f "$APP/storage/tools/mediamtx.yml" ] || cat > "$APP/storage/tools/mediamtx.yml" <<'EOF'
logLevel: info
rtmpAddress: :1935
hlsAddress: 127.0.0.1:8890
apiAddress: 127.0.0.1:9997
paths:
  all_others:
EOF

log "4/8 systemd 服务"
install -m 644 "$APP/deploy/video-rr.service" /etc/systemd/system/video-rr.service
install -m 644 "$APP/deploy/mediamtx.service" /etc/systemd/system/mediamtx.service
systemctl daemon-reload
systemctl enable --now mediamtx.service
systemctl enable video-rr.service
systemctl restart video-rr.service
sleep 2
systemctl --no-pager --lines=0 status video-rr.service | head -3 || true
curl -fsS "http://127.0.0.1:$APP_PORT/api/constants" >/dev/null && echo "API 正常" || { echo "API 启动失败，看 /var/log/video-rr.err.log"; exit 1; }

log "5/8 nginx 片段"
install -m 644 "$APP/deploy/nginx-video.snippet.conf" "$SNIPPET"
install -m 644 "$APP/deploy/nginx-video-http.conf" "$HTTPCONF"

log "6/8 注入 site 配置（备份后幂等）"
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

log "7/8 nginx 并发参数"
NGX=/etc/nginx/nginx.conf
cp -a "$NGX" "$NGX.bak-video-$(date +%Y%m%d%H%M%S)"
sed -i 's/worker_connections 768;/worker_connections 65535;/' "$NGX"
grep -q 'worker_rlimit_nofile' "$NGX" || sed -i '0,/worker_processes auto;/s//worker_processes auto;\nworker_rlimit_nofile 100000;/' "$NGX"
nginx -t
systemctl reload nginx

log "8/8 健康检查"
for path in /video/ /video-admin/ /video/api/constants; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN$path" --resolve "$DOMAIN:443:127.0.0.1")
  printf '  %-24s %s\n' "$path" "$code"
done
echo
echo "完成：C 端 https://$DOMAIN/video/   后台 https://$DOMAIN/video-admin/"
echo "后台账号：admin / admin123（首次登录后请立刻改密码）"
