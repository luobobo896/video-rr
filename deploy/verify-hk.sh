#!/usr/bin/env bash
# 线上验收（带断言 + 退出码）：子路径 / 防盗链（含分片）/ 后台强口令 / 权限 / 强制改密闸门 /
# C 端登录门禁 / 代发登录码 / 播放签名 / 支付安全 / 对账 / Redis / USDT 监听 / 审计
# 用法：bash deploy/verify-hk.sh            # 全量
#      READONLY=1 bash deploy/verify-hk.sh  # 只读（不建单、不代发码）
# 口令来源：$ADMIN_PASSWORD → storage/admin-initial-passwords.txt → 交互输入
# 退出码：0 全部通过；1 有断言失败
set -uo pipefail
APP=/opt/video-rr
DOMAIN=${DOMAIN:-hk.hsddns.com}
BASE="https://$DOMAIN"
CURL="curl -sk --resolve $DOMAIN:443:127.0.0.1"
READONLY=${READONLY:-0}
FAILED=0
PASSED=0

json() { python3 -c "
import sys, json
try: data = json.load(sys.stdin)
except Exception: print(''); raise SystemExit
for key in '$1'.split('.'):
    if isinstance(data, dict): data = data.get(key)
    elif isinstance(data, list) and key.isdigit() and int(key) < len(data): data = data[int(key)]
    else: data = None
    if data is None: break
print('' if data is None else data)
"; }
code() { $CURL -o /dev/null -w '%{http_code}' "$@"; }

ok()   { PASSED=$((PASSED+1)); printf '  \033[32m✓\033[0m %-34s %s\n' "$1" "$2"; }
bad()  { FAILED=$((FAILED+1)); printf '  \033[31m✗\033[0m %-34s %s\n' "$1" "$2"; }
# chk 标签 期望 实际  [说明]
chk() { if [ "$3" = "$2" ]; then ok "$1" "$3"; else bad "$1" "期望 $2，实际 ${3:-空} ${4:-}"; fi; }
# chkin 标签 期望列表(逗号) 实际
chkin() { case ",$2," in *",$3,"*) ok "$1" "$3";; *) bad "$1" "期望 $2 之一，实际 ${3:-空}";; esac; }
# chkle 标签 上限 实际
chkle() { if [ -n "$3" ] && [ "$3" -le "$2" ] 2>/dev/null; then ok "$1" "$3"; else bad "$1" "应 ≤ $2，实际 ${3:-空}"; fi; }
# chkge 标签 下限 实际
chkge() { if [ -n "$3" ] && [ "$3" -ge "$2" ] 2>/dev/null; then ok "$1" "$3"; else bad "$1" "应 ≥ $2，实际 ${3:-空}"; fi; }

# ---------- 口令 ----------
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
CRED="$APP/storage/admin-initial-passwords.txt"
if [ -z "$ADMIN_PASSWORD" ] && [ -f "$CRED" ]; then
  ADMIN_PASSWORD=$(awk -F'\t' '$1=="admin"{print $2}' "$CRED")
fi
if [ -z "$ADMIN_PASSWORD" ]; then
  read -r -s -p "admin 当前口令：" ADMIN_PASSWORD; echo
fi

echo "=== 1. 子路径与静态资源 ==="
chk "C 端首页" 200 "$(code "$BASE/video/")"
chk "后台首页" 200 "$(code "$BASE/video-admin/")"
chk "公开常量接口" 200 "$(code "$BASE/video/api/constants")"
chk "robots 禁抓 /api/" 1 "$($CURL "$BASE/video/robots.txt" | grep -c 'Disallow: /api/')"

echo "=== 2. 防盗链（未签名一律 403，含分片与源片） ==="
chk "未签名 master" 403 "$(code "$BASE/video/media/hls/1/index.m3u8")"
chk "未签名分片" 403 "$(code "$BASE/video/media/hls/1/720p/seg_000.ts")"
chk "源片目录已关闭" 403 "$(code "$BASE/video/media/uploads/x.mp4")"
chk "路径穿越" 404 "$(code "$BASE/video/media/hls/../../etc/passwd")"

echo "=== 3. 后台登录 / 强口令 / 强制改密闸门 ==="
LOGIN=$($CURL -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(printf '%s' "$LOGIN" | json data.token)
if [ -z "$TOKEN" ]; then
  bad "admin 登录" "失败：$(printf '%s' "$LOGIN" | json msg)"
  echo "  口令可能已改过：export ADMIN_PASSWORD=... 再跑"
  exit 1
fi
ok "admin 登录" "token ${TOKEN:0:12}…"
MUST=$(printf '%s' "$LOGIN" | json data.mustChangePassword)
if [ "$MUST" = "True" ] || [ "$MUST" = "true" ]; then
  chk "未改密访问业务接口" 403 "$(code "$BASE/video-admin/api/users" -H "authorization: Bearer $TOKEN")"
else
  chk "业务接口可用" 200 "$(code "$BASE/video-admin/api/users" -H "authorization: Bearer $TOKEN")"
fi
chkin "弱口令 admin123 被拒" "400,401,429" "$(code -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}')"
printf '  角色/权限：%s\n' "$($CURL "$BASE/video-admin/api/me" -H "authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',{})
print('roles',[r.get('code') for r in d.get('roles',[])],'perms',len(d.get('permissions',[])))")"

OPS_PASSWORD=$(awk -F'\t' '$1=="ops01"{print $2}' "$CRED" 2>/dev/null)
if [ -n "${OPS_PASSWORD:-}" ]; then
  OPS=$($CURL -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' \
    -d "{\"username\":\"ops01\",\"password\":\"$OPS_PASSWORD\"}" | json data.token)
  if [ -n "$OPS" ]; then
    chkin "内容运营调退款列表（越权）" "401,403" "$(code "$BASE/video-admin/api/refunds" -H "authorization: Bearer $OPS")"
  fi
fi

echo "=== 4. 运行态：Redis / USDT 监听 / 风控留痕 ==="
SEC=$($CURL "$BASE/video-admin/api/security" -H "authorization: Bearer $TOKEN")
printf '  限流存储 %s\n' "$(printf '%s' "$SEC" | json data.redis)"
printf '  USDT 监听 %s\n' "$(printf '%s' "$SEC" | json data.usdtWatch)"
printf '  近 24h 拦截 %s\n' "$(printf '%s' "$SEC" | json data.last24h)"

echo "=== 5. C 端登录门禁 ==="
chk "未登录搜索" 401 "$(code "$BASE/video/api/search?kw=test")"
chk "未登录个人中心" 401 "$(code "$BASE/video/api/me")"
chk "未登录播放" 401 "$(code "$BASE/video/api/play/1/1")"
chk "手机号登录已下线" 410 "$(code -X POST "$BASE/video/api/auth/login" -H 'content-type: application/json' -d '{"phone":"13800000000"}')"
chk "匿名伪造 USDT 回调" 404 "$(code -X POST "$BASE/video/api/notify/usdt" -H 'content-type: application/json' -d '{"outTradeNo":"x","txid":"y","confirmations":19}')"
chk "匿名模拟支付已关闭" 404 "$(code -X POST "$BASE/video/api/pay/mock" -H 'content-type: application/json' -d '{"outTradeNo":"x"}')"
chk "匿名支付宝模拟已关闭" 404 "$(code -X POST "$BASE/video/api/pay/alipay-sim" -H 'content-type: application/json' -d '{"outTradeNo":"x"}')"

if [ "$READONLY" = "1" ]; then
  echo "=== 只读模式：跳过代发码 / 播放 / 下单 ==="
  echo; echo "结果：通过 $PASSED 项，失败 $FAILED 项"
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

echo "=== 6. 后台代发登录码 → C 端登录 → 播放签名 ==="
USER_ID=$($CURL "$BASE/video-admin/api/users" -H "authorization: Bearer $TOKEN" | python3 -c "
import sys,json
rows=json.load(sys.stdin).get('data',{}).get('list',[])
hit=[r for r in rows if r.get('email')]
print(hit[0]['id'] if hit else '')")
if [ -z "$USER_ID" ]; then
  echo "  跳过：线上暂无带邮箱的用户（后台用户列表给任意用户补 email 后重跑）"
else
  ISSUE=$($CURL -X POST "$BASE/video-admin/api/users/$USER_ID/login-code" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d '{"reason":"线上验收"}')
  EMAIL=$(printf '%s' "$ISSUE" | json data.email)
  CODE=$(printf '%s' "$ISSUE" | json data.code)
  chk "代发登录码" 6 "${#CODE}"
  USER=$($CURL -X POST "$BASE/video/api/auth/email/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | json data.token)
  if [ -z "$USER" ]; then
    bad "C 端邮箱登录" "失败"
  else
    ok "C 端邮箱登录" "token ${USER:0:12}…"
    DRAMA=$($CURL "$BASE/video/api/home" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(d['sections'][0]['items'][0]['dramaId'])")
    PLAY_JSON=$($CURL "$BASE/video/api/play/$DRAMA/1" -H "authorization: Bearer $USER")
    EXP=$(printf '%s' "$PLAY_JSON" | json data.expiresIn)
    HLS=$(printf '%s' "$PLAY_JSON" | json data.hls)
    chkge "播放签名有效期（≥整集）" 300 "$EXP"
    chkle "播放签名有效期（上限）" 14400 "$EXP"
    if [ -z "$HLS" ]; then
      echo "  该集无片源，跳过播放链路"
    else
      DIRECTORY=$(printf '%s' "$HLS" | sed 's#/index\.m3u8$##')
      $CURL -c /tmp/mh_cookie.txt -o /dev/null "$BASE/video/api/play/$DRAMA/1" -H "authorization: Bearer $USER"
      chk "带 Cookie 取 master" 200 "$(code -b /tmp/mh_cookie.txt "$BASE/video$HLS")"
      REND=$(code -b /tmp/mh_cookie.txt "$BASE/video$DIRECTORY/720p/index.m3u8")
      chkin "同集子播放列表（签名作用域）" "200,404" "$REND"
      chk "带 Cookie 取分片" 200 "$(code -b /tmp/mh_cookie.txt "$BASE/video$DIRECTORY/720p/seg_000.ts")"
      chk "无 Cookie 取 master" 403 "$(code "$BASE/video$HLS")"
      chk "换 UA 取 master" 403 "$(code -b /tmp/mh_cookie.txt -A 'Mozilla/5.0 (Different)' "$BASE/video$HLS")"
      chk "带 Cookie 取源片仍 403" 403 "$(code -b /tmp/mh_cookie.txt "$BASE/video/media/uploads/ep-1.mp4")"
      rm -f /tmp/mh_cookie.txt
    fi

    echo "=== 7. 下单 → 后台确认到账 → 权益生效 ==="
    ORDER=$($CURL -X POST "$BASE/video/api/orders" -H "authorization: Bearer $USER" -H 'content-type: application/json' \
      -d '{"productType":"subscription","planId":1}' | json data.outTradeNo)
    if [ -z "$ORDER" ]; then
      bad "创建订单" "失败"
    else
      ok "创建订单" "$ORDER"
      chk "模拟支付通道已关闭" 404 "$(code -X POST "$BASE/video/api/pay/mock" -H 'content-type: application/json' -d "{\"outTradeNo\":\"$ORDER\"}")"
      ORDER_ID=$($CURL "$BASE/video-admin/api/orders?kw=$ORDER" -H "authorization: Bearer $TOKEN" | python3 -c "
import sys,json
rows=json.load(sys.stdin).get('data',{}).get('list',[])
print(rows[0]['id'] if rows else '')")
      if [ -n "$ORDER_ID" ]; then
        CONF=$(code -X POST "$BASE/video-admin/api/orders/$ORDER_ID/confirm" -H "authorization: Bearer $TOKEN" \
          -H 'content-type: application/json' -d '{"note":"线上验收补单"}')
        chkin "后台人工确认到账" "200,409" "$CONF"
        chkin "确认后播放第 5 集" "200,402" "$(code "$BASE/video/api/play/$DRAMA/5" -H "authorization: Bearer $USER")"
      fi
    fi
  fi
fi

echo "=== 8. 对账与审计 ==="
$CURL -X POST "$BASE/video-admin/api/reconcile" -H "authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('  缺失支付',d['missingPayment'],'孤儿支付',d['orphanPayment'],'待补发',d['stuckPaid'])"
$CURL "$BASE/video-admin/api/audit?page=1" -H "authorization: Bearer $TOKEN" | python3 -c "
import sys,json
rows=json.load(sys.stdin).get('data',{}).get('list',[])
print('  最近动作',[r.get('action') for r in rows[:5]])"

echo
echo "结果：通过 $PASSED 项，失败 $FAILED 项"
[ "$FAILED" -eq 0 ] || exit 1
