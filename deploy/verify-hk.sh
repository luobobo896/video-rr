#!/usr/bin/env bash
# 线上验收（付费链路 + 权限 + 防盗链）
set -uo pipefail
DOMAIN=hk.hsddns.com
BASE="https://$DOMAIN"
CURL="curl -sk --resolve $DOMAIN:443:127.0.0.1"
jq_get() { python3 -c "
import sys, json
data = json.load(sys.stdin)
for key in '$1'.split('.'):
    data = data.get(key) if isinstance(data, dict) else None
    if data is None: break
print(data if data is not None else '')
"; }

echo "=== 1. 子路径 ==="
for p in /video/ /video-admin/ /video/api/constants; do
  printf '  %-24s %s\n' "$p" "$($CURL -o /dev/null -w '%{http_code}' "$BASE$p")"
done

echo "=== 2. 未签名切片必须 403 ==="
printf '  unsigned hls           %s\n' "$($CURL -o /dev/null -w '%{http_code}' "$BASE/video/media/hls/1/index.m3u8")"

echo "=== 3. 后台登录 + 权限 ==="
TOKEN=$($CURL -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq_get data.token)
echo "  admin token ${TOKEN:0:16}…"
$CURL "$BASE/video-admin/api/me" -H "authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json;d=json.load(sys.stdin)['data'];print('  roles',[r['code'] for r in d['roles']],'perms',len(d['permissions']))"

OPS=$($CURL -X POST "$BASE/video-admin/api/login" -H 'content-type: application/json' \
  -d '{"username":"ops01","password":"admin123"}' | jq_get data.token)
printf '  内容运营调退款列表       %s（应 403）\n' "$($CURL -o /dev/null -w '%{http_code}' "$BASE/video-admin/api/refunds" -H "authorization: Bearer $OPS")"

echo "=== 4. C 端：登录 → 未授权播放 402 → 下单 → 支付 → 再播放 ==="
USER=$($CURL -X POST "$BASE/video/api/auth/login" -H 'content-type: application/json' -d '{"phone":"13900000001"}' | jq_get data.token)
DRAMA=$($CURL "$BASE/video/api/home" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['sections'][0]['items'][0]['dramaId'])")
echo "  测试剧集 #$DRAMA"
printf '  未订阅播放第 5 集        %s（应 402）\n' "$($CURL -o /dev/null -w '%{http_code}' "$BASE/video/api/play/$DRAMA/5" -H "authorization: Bearer $USER")"
ORDER=$($CURL -X POST "$BASE/video/api/orders" -H "authorization: Bearer $USER" -H 'content-type: application/json' \
  -d '{"productType":"subscription","planId":1,"channel":"mock"}' | jq_get data.outTradeNo)
echo "  订单 $ORDER"
$CURL -X POST "$BASE/video/api/pay/mock" -H 'content-type: application/json' -d "{\"outTradeNo\":\"$ORDER\"}" | python3 -c \
  "import sys,json;d=json.load(sys.stdin)['data'];print('  支付结果',d['order']['status'],'重复',d['duplicate'])"
printf '  订阅后播放第 5 集        %s（应 200）\n' "$($CURL -o /dev/null -w '%{http_code}' "$BASE/video/api/play/$DRAMA/5" -H "authorization: Bearer $USER")"

echo "=== 5. 播放签名 Cookie 有效 ==="
$CURL -c /tmp/mh_cookie.txt -o /dev/null "$BASE/video/api/play/$DRAMA/5" -H "authorization: Bearer $USER"
printf '  带 Cookie 取 m3u8        %s（应 200/404，403 为失败）\n' "$($CURL -b /tmp/mh_cookie.txt -o /dev/null -w '%{http_code}' "$BASE/video/media/hls/1/index.m3u8")"
rm -f /tmp/mh_cookie.txt

echo "=== 6. 对账 ==="
$CURL -X POST "$BASE/video-admin/api/reconcile" -H "authorization: Bearer $TOKEN" | python3 -c \
  "import sys,json;d=json.load(sys.stdin)['data'];print('  缺失支付',d['missingPayment'],'孤儿支付',d['orphanPayment'],'待补发',d['stuckPaid'])"

echo "完成"
