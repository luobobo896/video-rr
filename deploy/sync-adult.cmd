@echo off
chcp 65001 >nul
rem Push new images and data from this machine to production.
rem Run by Windows Task Scheduler every 2 hours, or manually after importing new titles.
rem Link refresh is NOT done here: jable challenges this home IP after bulk imports,
rem so the refresh loop moved to the HK server (/etc/cron.d/video-refresh, every 30 minutes).
rem adult-migrate keeps whichever remote_url expires later, so a stale local link
rem can never overwrite a fresh production one.
setlocal
cd /d E:\video-rr
if not exist storage\logs mkdir storage\logs
set LOG=storage\logs\adult-sync.log

echo === %DATE% %TIME% start ===>> "%LOG%"
node scripts\adult-export.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: export >> "%LOG%"
  exit /b 1
)
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
