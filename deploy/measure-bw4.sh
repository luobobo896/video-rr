#!/usr/bin/env bash
# 并行聚合带宽（用 curl 自带 speed_download 求和，避免依赖 bc）
echo "=== 8 路并行下载 Cloudflare 20MB×8 ==="
for i in $(seq 1 8); do
  ( curl -s -o /dev/null --max-time 40 -w '%{speed_download}\n' \
      'https://speed.cloudflare.com/__down?bytes=20000000' > /tmp/spd_dl_$i ) &
done
wait
awk '{s+=$1} END {printf "  合计 %.2f MB/s = %.1f Mbps（单连接 %.2f MB/s）\n", s/1048576, s*8/1000000, s/8/1048576}' /tmp/spd_dl_*

echo "=== 4 路并行下载 清华源 ==="
for i in $(seq 1 4); do
  ( curl -sL -o /dev/null --max-time 30 -w '%{speed_download}\n' \
      'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso' > /tmp/spd_cn_$i ) &
done
wait
awk '{s+=$1} END {printf "  合计 %.2f MB/s = %.1f Mbps\n", s/1048576, s*8/1000000}' /tmp/spd_cn_*

echo "=== 4 路并行上传 Cloudflare 10MB×4 ==="
dd if=/dev/zero of=/tmp/u10.bin bs=1M count=10 status=none
for i in $(seq 1 4); do
  ( curl -s -o /dev/null --max-time 60 -T /tmp/u10.bin -w '%{speed_upload}\n' \
      'https://speed.cloudflare.com/__up' > /tmp/spd_ul_$i ) &
done
wait
awk '{s+=$1} END {printf "  合计 %.2f MB/s = %.1f Mbps\n", s/1048576, s*8/1000000}' /tmp/spd_ul_*
rm -f /tmp/u10.bin /tmp/spd_dl_* /tmp/spd_cn_* /tmp/spd_ul_*
