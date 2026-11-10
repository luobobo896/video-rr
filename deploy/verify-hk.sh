#!/usr/bin/env bash
# 部署后验证：子路径可达、后台登录、示例转码、HLS 可播放
set -uo pipefail
DOMAIN=hk.hsddns.com
BASE="https://$DOMAIN"
CURL="curl -sk --resolve $DOMAIN:443:127.0.0.1"

echo "=== 1. 子路径可达性 ==="
for p in /video/ /video-admin/ /video/app.js /video-admin/app.js /video/api/constants; do
  code=$($CURL -o /dev/null -w '%{http_code}' "$BASE$p")
  printf '  %-26s %s\n' "$p" "$code"
done

echo "=== 2. 后台登录 ==="
TOKEN=$($CURL -X POST "$BASE/video-admin/api/login" \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.token)}catch{console.log("")}})')
if [ -z "$TOKEN" ]; then echo "  登录失败"; exit 1; fi
echo "  token ${TOKEN:0:16}…"

echo "=== 3. 概览 ==="
$CURL "$BASE/video-admin/api/stats" -H "authorization: Bearer $TOKEN" | head -c 400
echo

echo "=== 4. 触发示例转码（20s，720p+480p）==="
EP=$($CURL "$BASE/video-admin/api/dramas/1/episodes" -H "authorization: Bearer $TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const list=j.data.list||[];console.log(list[0]?list[0].id:"")})')
echo "  分集 id=$EP"
$CURL -X POST "$BASE/video-admin/api/episodes/$EP/sample" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seconds":20}' | head -c 300
echo

echo "=== 5. 等转码完成 ==="
for i in $(seq 1 40); do
  sleep 3
  JOBS=$($CURL "$BASE/video-admin/api/jobs" -H "authorization: Bearer $TOKEN")
  running=$(echo "$JOBS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data.running?1:0)})')
  pending=$(echo "$JOBS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data.pending)})')
  echo "  t=${i} running=$running pending=$pending"
  if [ "$running" = "0" ] && [ "$pending" = "0" ]; then break; fi
done

echo "=== 6. 分集状态 ==="
$CURL "$BASE/video-admin/api/dramas/1/episodes" -H "authorization: Bearer $TOKEN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const e=(j.data.list||[])[0]||{};console.log(JSON.stringify({id:e.id,no:e.no,status:e.status,progress:e.progress,hls:e.hls_path,error:e.error}))})'

echo "=== 7. HLS 产物 ==="
ls -ld /opt/video-rr/storage/hls/*/ 2>/dev/null | tail -3
find /opt/video-rr/storage/hls -name 'index.m3u8' | head -5

echo "=== 8. 公网 HLS 可达性（经 nginx）==="
for p in "/video/media/hls/$EP/index.m3u8" "/video/media/hls/$EP/480p/index.m3u8"; do
  code=$($CURL -o /dev/null -w '%{http_code}' "$BASE$p")
  printf '  %-48s %s\n' "$p" "$code"
done

echo "=== 9. C 端播放接口 ==="
$CURL "$BASE/video/api/play/1/1" | head -c 300
echo
echo "完成"
