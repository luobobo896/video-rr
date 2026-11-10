#!/usr/bin/env bash
# 实测 HK 机器出口带宽 + 网络/磁盘能力（决定能扛多少路点播）
echo "=== 网卡链路速率 ==="
for i in $(ls /sys/class/net | grep -v lo); do printf '  %-12s %s Mb/s\n' "$i" "$(cat /sys/class/net/$i/speed 2>/dev/null || echo unknown)"; done

echo "=== 外网下载（Cloudflare，200MB）==="
curl -s -o /dev/null -w '  speed=%{speed_download} B/s  time=%{time_total}s\n' --max-time 60 'https://speed.cloudflare.com/__down?bytes=200000000' || echo '  下载测试失败'

echo "=== 外网上传（Cloudflare，100MB）==="
dd if=/dev/urandom of=/tmp/up.bin bs=1M count=100 status=none
curl -s -o /dev/null -w '  speed=%{speed_upload} B/s  time=%{time_total}s\n' --max-time 90 -T /tmp/up.bin 'https://speed.cloudflare.com/__up' || echo '  上传测试失败'
rm -f /tmp/up.bin

echo "=== 磁盘顺序读（HLS 切片热数据）==="
dd if=/opt/video-rr/storage/hls/1/480p/seg_000.ts of=/dev/null bs=1M count=1 iflag=nocache 2>&1 | tail -1
dd if=/opt/video-rr/storage/hls/1/index.m3u8 of=/dev/null bs=4k count=1 2>&1 | tail -1

echo "=== 当前负载 ==="
uptime
echo "=== ffmpeg / node ==="
node -v
ffmpeg -version 2>/dev/null | head -1
