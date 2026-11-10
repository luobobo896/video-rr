#!/usr/bin/env bash
# 并行多连接测速：区分「单连接限速」和「总出口限速」
echo "=== 8 路并行下载（Cloudflare 20MB × 8）==="
START=$(date +%s.%N)
for i in $(seq 1 8); do
  curl -s -o /dev/null --max-time 40 'https://speed.cloudflare.com/__down?bytes=20000000' &
done
wait
END=$(date +%s.%N)
ELAPSED=$(echo "$END - $START" | bc)
TOTAL_MB=160
echo "  合计 ${TOTAL_MB} MB / ${ELAPSED}s = $(echo "scale=2; $TOTAL_MB * 8 / $ELAPSED" | bc) Mbps"

echo "=== 并行 4 路下载（清华源 100MB × 4）==="
START=$(date +%s.%N)
for i in $(seq 1 4); do
  curl -sL -o /dev/null --max-time 40 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso' &
done
wait
END=$(date +%s.%N)
ELAPSED=$(echo "$END - $START" | bc)
echo "  4 × 3GB(约) / ${ELAPSED}s（注：文件很大，40s 内按速度折算）"

echo "=== tc 限速规则 ==="
tc qdisc show 2>/dev/null | head -10 || echo '  (无 tc / 无权限)'

echo "=== 网卡错误/丢包 ==="
ip -s link show ens17 2>/dev/null | tail -4 || true
