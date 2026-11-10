#!/usr/bin/env bash
# 多源带宽复测：确认 HK 机器的真实出口能力（不是单点路由问题）
echo "=== A. 下载：阿里云镜像（大陆方向）==="
curl -s -o /dev/null -w '  %{speed_download} B/s  %{time_total}s\n' --max-time 45 'https://mirrors.aliyun.com/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso' || echo '  失败'

echo "=== B. 下载：Cloudflare 50MB ==="
curl -s -o /dev/null -w '  %{speed_download} B/s  %{time_total}s\n' --max-time 45 'https://speed.cloudflare.com/__down?bytes=50000000' || echo '  失败'

echo "=== C. 下载：bunny CDN 100MB ==="
curl -s -o /dev/null -w '  %{speed_download} B/s  %{time_total}s\n' --max-time 45 'https://bunnycdn-test.b-cdn.net/100mb.bin' || echo '  失败'

echo "=== D. 上传：Cloudflare 50MB ==="
dd if=/dev/zero of=/tmp/up50.bin bs=1M count=50 status=none
curl -s -o /dev/null -w '  %{speed_upload} B/s  %{time_total}s\n' --max-time 90 -T /tmp/up50.bin 'https://speed.cloudflare.com/__up' || echo '  失败'
rm -f /tmp/up50.bin

echo "=== E. 上传：transfer.sh 20MB ==="
dd if=/dev/zero of=/tmp/up20.bin bs=1M count=20 status=none
curl -s -o /dev/null -w '  %{speed_upload} B/s  %{time_total}s\n' --max-time 60 -T /tmp/up20.bin 'https://transfer.sh/up20.bin' || echo '  失败'
rm -f /tmp/up20.bin

echo "=== F. 到大陆的延迟 ==="
for host in mirrors.aliyun.com www.baidu.com speed.cloudflare.com; do
  printf '  %-26s %s\n' "$host" "$(ping -c 3 -W 2 $host 2>/dev/null | tail -1)"
done
