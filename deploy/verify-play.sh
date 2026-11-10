#!/usr/bin/env bash
# 真实播放链路验收：登录 → 取一集有片源的内容 → Cookie 取 master / 子播放列表 / 首分片
# 用法：ADMIN_PASSWORD=xxx bash deploy/verify-play.sh
set -uo pipefail
DOMAIN=${DOMAIN:-hk.hsddns.com}
BASE="https://$DOMAIN"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
CURL=(curl -sk -A "$UA" --resolve "$DOMAIN:443:127.0.0.1")
ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(awk -F'\t' '$1=="admin"{print $2}' /opt/video-rr/storage/admin-initial-passwords.txt)}
FAILED=0
ok() { printf '  \033[32m✓\033[0m %-30s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1)); printf '  \033[31m✗\033[0m %-30s %s\n' "$1" "$2"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);
k='$1'.split('.')
for x in k:
    d=(d.get(x) if isinstance(d,dict) else (d[int(x)] if isinstance(d,list) and x.isdigit() and int(x)<len(d) else None))
    if d is None: break
print('' if d is None else d)"; }

T=$("${CURL[@]}" -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | jget data.token)
[ -n "$T" ] || { echo "后台登录失败（口令？）"; exit 1; }
UID_=$("${CURL[@]}" "$BASE/video-admin/api/users" -H "authorization: Bearer $T" | python3 -c "import sys,json;r=json.load(sys.stdin)['data']['list'];e=[x for x in r if x.get('email')];print(e[0]['id'] if e else '')")
[ -n "$UID_" ] || { echo "没有带邮箱的用户，先在后台补 email"; exit 1; }
ISSUE=$("${CURL[@]}" -X POST "$BASE/video-admin/api/users/$UID_/login-code" -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"reason":"播放链路验收"}')
if printf '%s' "$ISSUE" | grep -q send_too_frequent; then
  W=$(printf '%s' "$ISSUE" | sed -n 's/.*请 \([0-9]\+\) 秒.*/\1/p'); sleep "${W:-30}"
  ISSUE=$("${CURL[@]}" -X POST "$BASE/video-admin/api/users/$UID_/login-code" -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"reason":"播放链路验收"}')
fi
EMAIL=$(printf '%s' "$ISSUE" | jget data.email); CODE=$(printf '%s' "$ISSUE" | jget data.code)
U=$("${CURL[@]}" -X POST "$BASE/video/api/auth/email/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | jget data.token)
[ -n "$U" ] || { echo "C 端登录失败"; exit 1; }
ok "登录" "${EMAIL}"

PICK=$("${CURL[@]}" "$BASE/video/api/home" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
for sec in d.get('sections',[]):
    for it in sec.get('items',[]):
        print(it.get('dramaId')); raise SystemExit" )
TRIES=0
for DID in $(printf '%s' "$PICK"); do :; done
# 逐集探测：从首页前若干部剧集里找一集能签发出 hls 的
for DID in $("${CURL[@]}" "$BASE/video/api/home" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
ids=[]
for sec in d.get('sections',[]):
    for it in sec.get('items',[]):
        x=it.get('dramaId')
        if x and x not in ids: ids.append(x)
print(' '.join(str(i) for i in ids[:12]))"); do
  for EP in 1 2 3; do
    PLAY=$("${CURL[@]}" "$BASE/video/api/play/$DID/$EP" -H "authorization: Bearer $U")
    HLS=$(printf '%s' "$PLAY" | jget data.hls)
    [ -n "$HLS" ] && break 2
  done
done
if [ -z "${HLS:-}" ]; then echo "  未找到已就绪片源，无法验证播放链路（后台转码完成后再跑）"; exit 2; fi
DIR=$(printf '%s' "$HLS" | sed 's#/index\.m3u8$##')
ok "签名到手" "$HLS"
"${CURL[@]}" -c /tmp/pc.txt -o /dev/null "$BASE/video/api/play/$DID/$EP" -H "authorization: Bearer $U"
c() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }
chk() { local got; got=$(c "${@:3}"); [ "$got" = "$2" ] && ok "$1" "$got" || bad "$1" "期望 $2 实际 $got"; }
chk "带 Cookie master" 200 -b /tmp/pc.txt "$BASE/video$HLS"
REND=$(printf '%s' "$PLAY" | jget data.hls | sed 's#/index\.m3u8$##')/720p/index.m3u8
GOT=$(c -b /tmp/pc.txt "$BASE/video$REND"); case "$GOT" in 200) ok "同集子播放列表" "$GOT";; 404) ok "同集子播放列表" "404（无 720p 档，非鉴权问题）";; *) bad "同集子播放列表" "期望 200/404 实际 $GOT";; esac
chk "带 Cookie 首分片" 200 -b /tmp/pc.txt "$BASE/video$DIR/720p/seg_000.ts"
chk "无 Cookie master" 403 "$BASE/video$HLS"
chk "换 UA master" 403 -b /tmp/pc.txt -A 'Mozilla/5.0 (Different/1.0)' "$BASE/video$HLS"
chk "源片仍拒" 403 -b /tmp/pc.txt "$BASE/video/media/uploads/ep-1.mp4"
rm -f /tmp/pc.txt
echo; echo "结果：失败 $FAILED 项"
[ "$FAILED" -eq 0 ] || exit 1
