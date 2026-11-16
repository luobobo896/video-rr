@echo off
chcp 65001 >nul
rem Refresh expiring jable links and push new images + data to production.
rem Run by Windows Task Scheduler every 30 minutes.
rem Refresh must happen on this machine: the server has no browser and gets 403 from Cloudflare.
rem --max-left 40 keeps each run short: only links with <40 minutes left are re-parsed.
setlocal
cd /d E:\video-rr
if not exist storage\logs mkdir storage\logs
set LOG=storage\logs\adult-sync.log

echo === %DATE% %TIME% start ===>> "%LOG%"
node scripts\jable-import.mjs --refresh --max-left 40 >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: refresh >> "%LOG%"
  exit /b 1
)
node scripts\adult-export.mjs >> "%LOG%" 2>&1
node scripts\push-images.mjs >> "%LOG%" 2>&1
scp -q storage\adult-export.json hk:/tmp/adult-export.json >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: upload >> "%LOG%"
  exit /b 1
)
ssh hk "cd /opt/video-rr && MH_DB=/opt/video-rr/storage/app.db node scripts/adult-migrate.mjs /tmp/adult-export.json --mode free --trial 0" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: remote migrate >> "%LOG%"
  exit /b 1
)
echo === %DATE% %TIME% done ===>> "%LOG%"
exit /b 0
