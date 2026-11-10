#!/usr/bin/env bash
# 一次性配置线上运营凭据：QQ 邮箱通道 + USDT(TRC20) 收款地址
# 用法（在 /opt/video-rr 下）：
#   ADMIN_PASSWORD=xxx MAIL_USER=269580442@qq.com MAIL_PASS=授权码 \
#   USDT_ADDRESS=T... USDT_RATE=7.2 bash deploy/setup-channels.sh
set -uo pipefail
DOMAIN=${DOMAIN:-hk.hsddns.com}
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
CURL=(curl -sk -A "$UA" --resolve "$DOMAIN:443:127.0.0.1")
API="https://$DOMAIN/video-admin/api"
FAIL=0
ok() { printf '  \033[32m✓\033[0m %-24s %s\n' "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %-24s %s\n' "$1" "$2"; }
jget() { python3 -c "import sys,json
d=json.load(sys.stdin)
for k in sys.argv[1].split('.'):
    d=(d.get(k) if isinstance(d,dict) else (d[int(k)] if isinstance(d,list) and k.isdigit() and int(k)<len(d) else None))
    if d is None: break
print('' if d is None else d)" "$1"; }

: "${ADMIN_PASSWORD:?需要 ADMIN_PASSWORD}"
: "${MAIL_USER:?需要 MAIL_USER}"
: "${MAIL_PASS:?需要 MAIL_PASS}"
: "${USDT_ADDRESS:?需要 USDT_ADDRESS}"

echo "== 1. 后台登录 =="
T=$("${CURL[@]}" -X POST "$API/login" -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER:-admin}\",\"password\":\"$ADMIN_PASSWORD\"}" | jget data.token)
[ -n "$T" ] || { echo "登录失败（口令错 / 需要改密）"; exit 1; }
ok "登录" "token ${T:0:16}…"

echo "== 2. 邮件通道（QQ SMTP）=="
CH=$("${CURL[@]}" "$API/email-channels" -H "authorization: Bearer $T")
EXIST=$(printf '%s' "$CH" | python3 -c "import sys,json
rows=json.load(sys.stdin).get('data',{}).get('channels',[])
hit=[c for c in rows if c.get('presetId')=='qq' or 'QQ' in (c.get('name') or '')]
print(hit[0]['id'] if hit else '')")
PAYLOAD=$(python3 -c "
import json,sys
p={'name':'QQ 邮箱 · $MAIL_USER','type':'smtp','enabled':True,'priority':0,
   'from':'$MAIL_USER','fromName':'影巢','presetId':'qq',
   'smtp':{'host':'smtp.qq.com','port':465,'secure':True,'authMode':'login','user':'$MAIL_USER','pass':'$MAIL_PASS'}}
print(json.dumps(p, ensure_ascii=False))")
if [ -n "$EXIST" ]; then
  PAYLOAD=$(python3 -c "import json,sys;p=json.loads(sys.argv[1]);p['id']=sys.argv[2];print(json.dumps(p,ensure_ascii=False))" "$PAYLOAD" "$EXIST")
fi
SAVED=$("${CURL[@]}" -X POST "$API/email-channels" -H "authorization: Bearer $T" -H 'content-type: application/json' -d "$PAYLOAD")
CID=$(printf '%s' "$SAVED" | jget data.channel.id)
[ -n "$CID" ] || { bad "保存通道" "$(printf '%s' "$SAVED" | head -c 200)"; }
[ -n "$CID" ] && ok "保存通道" "id=$CID"

SET=$("${CURL[@]}" -X PUT "$API/email-settings" -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d "{\"from\":\"$MAIL_USER\",\"fromName\":\"影巢\"}")
[ -n "$(printf '%s' "$SET" | jget data.from)" ] && ok "默认发信人" "$MAIL_USER" || bad "默认发信人" "$(printf '%s' "$SET" | head -c 160)"

if [ -n "$CID" ]; then
  TST=$("${CURL[@]}" -X POST "$API/email-channels/$CID/test" -H "authorization: Bearer $T" \
    -H 'content-type: application/json' -d "{\"to\":\"$MAIL_USER\"}")
  TOK=$(printf '%s' "$TST" | jget data.ok)
  MSG=$(printf '%s' "$TST" | jget data.message)
  [ "$TOK" = "True" ] && ok "通道自检+实投" "${MSG:-已投递}" || bad "通道自检+实投" "${MSG:-$(printf '%s' "$TST" | head -c 200)}"
fi

echo "== 3. USDT 收款地址（TRC20）=="
PC=$("${CURL[@]}" "$API/pay-channels" -H "authorization: Bearer $T")
PID=$(printf '%s' "$PC" | python3 -c "import sys,json
rows=json.load(sys.stdin).get('data',{}).get('list',[])
hit=[c for c in rows if c.get('channelCode')=='usdt']
print(hit[0]['id'] if hit else '')")
[ -n "$PID" ] && ok "找到 USDT 通道" "id=$PID" || bad "找到 USDT 通道" "未找到（先跑一次 install-hk.sh 迁移渠道）"
if [ -n "$PID" ]; then
  RATE=${USDT_RATE:-7.2}
  UPD=$("${CURL[@]}" -X PUT "$API/pay-channels/$PID" -H "authorization: Bearer $T" -H 'content-type: application/json' \
    -d "{\"status\":\"enabled\",\"config\":{\"walletAddress\":\"$USDT_ADDRESS\",\"network\":\"TRC20\",\"rate\":$RATE,\"minConfirmations\":19}}")
  [ -n "$(printf '%s' "$UPD" | jget data.id)" ] && ok "写入地址" "$USDT_ADDRESS（rate=$RATE）" || bad "写入地址" "$(printf '%s' "$UPD" | head -c 200)"
fi

echo "== 4. 运行态复查 =="
SEC=$("${CURL[@]}" "$API/security" -H "authorization: Bearer $T")
printf '%s' "$SEC" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',{})
w=d.get('usdtWatch') or {}
m=d.get('mail') or {}
print('  USDT 监听:', json.dumps({'enabled':w.get('enabled'),'address':w.get('address'),'minConfirmations':w.get('minConfirmations')}, ensure_ascii=False))
print('  邮件可用:', d.get('mailReady'), '| 通道数:', (m.get('channels') if isinstance(m,dict) else None))"
echo
echo "结果：失败 $FAIL 项"
[ "$FAIL" -eq 0 ] || exit 1
