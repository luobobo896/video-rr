#!/usr/bin/env bash
# 成人片外部源（jable 直链）播放链路验收：登录 → 取播放地址 → 清单重写 → 分片 → AES key → 解密解码
# 用法：bash deploy/verify-adult.sh
#      DOMAIN=www.wyfclyes.top ADMIN_PASSWORD=xxx USER_EMAIL=xxx bash deploy/verify-adult.sh
# 退出码：0 全部通过；1 有断言失败；2 库里没有外部源
set -uo pipefail
DOMAIN=${DOMAIN:-www.wyfclyes.top}
BASE="https://$DOMAIN"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
CURL=(curl -sk -A "$UA" --resolve "$DOMAIN:443:127.0.0.1")
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
USER_EMAIL=${USER_EMAIL:-}
APP=${APP:-/opt/video-rr}
FAILED=0
ok() { printf '  \033[32m✓\033[0m %-22s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1)); printf '  \033[31m✗\033[0m %-22s %s\n' "$1" "$2"; }
jget() { python3 -c "import sys,json
d=json.load(sys.stdin)
for x in '$1'.split('.'):
    if isinstance(d,dict): d=d.get(x)
    elif isinstance(d,list) and x.isdigit() and int(x)<len(d): d=d[int(x)]
    else: d=None
    if d is None: break
print('' if d is None else d)"; }

[ -n "$ADMIN_PASSWORD" ] || { echo "需要 ADMIN_PASSWORD"; exit 1; }
T=$("${CURL[@]}" -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" | jget data.token)
[ -n "$T" ] || { echo "后台登录失败（口令？）"; exit 1; }
ok "后台登录" "$ADMIN_USER"

# C 端身份：优先用参数指定，否则取后台用户列表里第一个带邮箱的
UID_=$("${CURL[@]}" "$BASE/video-admin/api/users" -H "authorization: Bearer $T" | USER_EMAIL="$USER_EMAIL" python3 -c "
import sys, json, os
want = os.environ.get('USER_EMAIL', '').lower()
rows = json.load(sys.stdin)['data']['list']
pick = [x for x in rows if (x.get('email') or '').lower() == want] if want else [x for x in rows if x.get('email')]
print(pick[0]['id'] if pick else '')")
[ -n "$UID_" ] || { echo "找不到 C 端账号"; exit 1; }
ISSUE=$("${CURL[@]}" -X POST "$BASE/video-admin/api/users/$UID_/login-code" -H "authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"reason":"成人外部源播放验收"}')
if printf '%s' "$ISSUE" | grep -q send_too_frequent; then
  W=$(printf '%s' "$ISSUE" | sed -n 's/.*请 \([0-9]\+\) 秒.*/\1/p'); sleep "${W:-30}"
  ISSUE=$("${CURL[@]}" -X POST "$BASE/video-admin/api/users/$UID_/login-code" -H "authorization: Bearer $T" \
    -H 'content-type: application/json' -d '{"reason":"成人外部源播放验收"}')
fi
EMAIL=$(printf '%s' "$ISSUE" | jget data.email); CODE=$(printf '%s' "$ISSUE" | jget data.code)
U=$("${CURL[@]}" -X POST "$BASE/video/api/auth/email/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | jget data.token)
[ -n "$U" ] || { echo "C 端登录失败：$ISSUE"; exit 1; }
ok "C 端登录" "$EMAIL"

CANDS=$(MH_DB="$APP/storage/app.db" python3 - <<'PY'
import os, sqlite3
con = sqlite3.connect(os.environ['MH_DB'])
where = "remote_url IS NOT NULL AND remote_url <> '' AND status = 'ready'"
extra = (os.environ.get('WHERE_EXTRA') or '').strip()
if extra:
    where += f" AND ({extra})"
rows = []
# 最老一条、最新一条、加上任一 alonestreaming 来源（上游 CDN 会换域名，两种都要覆盖）
for sql in (
    f"SELECT drama_id, no FROM episodes WHERE {where} ORDER BY id ASC LIMIT 1",
    f"SELECT drama_id, no FROM episodes WHERE {where} ORDER BY id DESC LIMIT 1",
    f"SELECT drama_id, no FROM episodes WHERE {where} AND remote_url LIKE '%alonestreaming%' ORDER BY id DESC LIMIT 1",
):
    rows += con.execute(sql).fetchall()
seen, uniq = set(), []
for pair in rows:
    if pair not in seen:
        seen.add(pair)
        uniq.append(pair)
print(' '.join(f'{a}:{b}' for a, b in uniq))
PY
)
[ -n "$CANDS" ] || { echo "库里没有就绪的外部源"; exit 2; }

HLS=""; DID=""
for PAIR in $CANDS; do
  D=${PAIR%%:*}; E=${PAIR##*:}
  H=$("${CURL[@]}" "${BASE}/video/api/play/$D/$E" -H "authorization: Bearer $U" | jget data.hls)
  [ -n "$H" ] && { HLS=$H; DID=$D; break; }
done
[ -n "$HLS" ] || { bad "取播放地址" "候选 $CANDS 均无"; echo; echo "结果：失败 $FAILED 项"; exit 1; }
ok "取播放地址" "drama#$DID → ${HLS%%\?*}"
case "$HLS" in /media/remote/*) ok "走外部源代理" "${HLS%%\?*}";; *) bad "走外部源代理" "$HLS";; esac

"${CURL[@]}" -c /tmp/av-cookie.txt -o /dev/null "${BASE}/video/api/play/$DID/1" -H "authorization: Bearer $U"
# curl 写出的 jar 里 HttpOnly 行以 #HttpOnly_ 开头，不能按注释过滤掉
COOKIE=$(awk 'NF>=7 && ($1 !~ /^#/ || $1 ~ /^#HttpOnly_/) {print $6"="$7}' /tmp/av-cookie.txt | paste -sd';' -)
chk() { local got; got=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${@:3}"); [ "$got" = "$2" ] && ok "$1" "$got" || bad "$1" "期望 $2 实际 $got"; }

chk "带 Cookie 清单" 200 -b /tmp/av-cookie.txt "${BASE}/video$HLS"
LIST=$("${CURL[@]}" -b /tmp/av-cookie.txt "${BASE}/video$HLS")
case "$LIST" in '#EXTM3U'*) ok "清单格式" "EXTM3U ${#LIST} 字节";; *) bad "清单格式" "$(printf '%s' "$LIST" | head -c 60)";; esac
case "$LIST" in
  *seg/*) ok "分片已重写" "$(printf '%s' "$LIST" | grep -m1 'seg/' | tr -d '\r' | cut -c1-40)";;
  *) bad "分片已重写" "未见 seg/ 路径";;
esac
case "$LIST" in
  *mushroomtrack*|*alonestreaming*|*jable.tv*) bad "不泄露上游域名" "清单里仍有上游域名";;
  *) ok "不泄露上游域名" "已全部改写";;
esac

DIR=$(printf '%s' "$HLS" | sed 's#index\.m3u8$##')
SEG=$(printf '%s' "$LIST" | grep -v '^#' | grep -m1 '\.ts' | tr -d '\r')
chk "首分片" 200 -b /tmp/av-cookie.txt "${BASE}/video$DIR$SEG"
SIZE=$("${CURL[@]}" -b /tmp/av-cookie.txt -o /tmp/av-seg.ts -w '%{size_download}' "${BASE}/video$DIR$SEG")
[ "${SIZE:-0}" -gt 100000 ] && ok "分片体积" "$SIZE bytes" || bad "分片体积" "$SIZE bytes"

KEYF=$(printf '%s' "$LIST" | sed -n 's/.*URI="\([^"]*\)".*/\1/p' | head -1)
IV=$(printf '%s' "$LIST" | sed -n 's/.*IV=0x\([0-9a-fA-F]*\).*/\1/p' | head -1)
if [ -n "$KEYF" ]; then
  KSIZE=$("${CURL[@]}" -b /tmp/av-cookie.txt -o /tmp/av-key.bin -w '%{size_download}' "${BASE}/video$DIR$KEYF")
  [ "${KSIZE:-0}" -eq 16 ] && ok "AES key" "$KSIZE 字节" || bad "AES key" "$KSIZE 字节"
  if [ -n "$IV" ] && [ "${KSIZE:-0}" -eq 16 ]; then
    KEYHEX=$(od -An -tx1 /tmp/av-key.bin | tr -d ' \n')
    if openssl aes-128-cbc -d -in /tmp/av-seg.ts -out /tmp/av-seg.dec.ts -K "$KEYHEX" -iv "$IV" 2>/dev/null; then
      CODE=$(timeout 25 ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 /tmp/av-seg.dec.ts 2>&1 | head -1)
      case "$CODE" in *h264*) ok "解密可解码" "$CODE";; *) bad "解密可解码" "${CODE:-空}";; esac
    else
      bad "AES 解密" "openssl 失败"
    fi
  fi
fi

chk "无 Cookie 清单" 403 "${BASE}/video$HLS"
chk "换 UA 清单" 403 -b /tmp/av-cookie.txt -A 'Mozilla/5.0 (Different/1.0)' "${BASE}/video$HLS"

DUR=$(timeout 30 ffprobe -v error -user_agent "$UA" -headers "Cookie: $COOKIE"$'\r\n' \
  -show_entries format=duration -of csv=p=0 "${BASE}/video$HLS" 2>&1 | head -1)
case "$DUR" in ''|*[!0-9.]*) bad "ffprobe 全链路" "${DUR:-空}";; *) ok "ffprobe 全链路" "${DUR}s";; esac

rm -f /tmp/av-cookie.txt /tmp/av-seg.ts /tmp/av-seg.dec.ts /tmp/av-key.bin
echo; echo "结果：失败 $FAILED 项"
[ "$FAILED" -eq 0 ] || exit 1
