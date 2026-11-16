@echo off
chcp 65001 >nul
rem Push new images and data from this machine to production.
rem Run by Windows Task Scheduler every 2 hours, or manually after importing new titles.
rem Link refresh is NOT done here: jable challenges this home IP after bulk imports,
rem so the refresh loop moved to the HK server (/etc/cron.d/video-refresh, every 30 minutes).
rem adult-migrate keeps whichever remote_url expires later, so a stale local link
rem can never overwrite a fresh production one.
rem Adult access mode default lives in scripts/lib/adult-mode.mjs (MH_ADULT_MODE overrides);
rem this file must not hardcode free/subscription again.
setlocal
cd /d E:\video-rr
if not exist storage\logs mkdir storage\logs
set LOG=storage\logs\adult-sync.log

if not defined MODE for /f "usebackq delims=" %%i in (`node scripts\adult-mode.mjs --print-default`) do set "MODE=%%i"
if not defined TRIAL set TRIAL=0
if not defined REMOTE_APP set REMOTE_APP=/opt/video-rr
if not defined HOST set HOST=hk

rem These values are spliced into a remote shell command: validate against a whitelist first.
node scripts\adult-mode.mjs --validate "%MODE%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: bad MODE %MODE% >> "%LOG%"
  exit /b 2
)
echo %TRIAL%| findstr /r "^[0-9][0-9]*$" >nul || (
  echo FAILED: bad TRIAL %TRIAL% >> "%LOG%"
  exit /b 2
)
echo %REMOTE_APP%| findstr /r "^/[A-Za-z0-9._/-]*$" >nul || (
  echo FAILED: bad REMOTE_APP %REMOTE_APP% >> "%LOG%"
  exit /b 2
)
echo %HOST%| findstr /r "^[A-Za-z0-9._@-][A-Za-z0-9._@-]*$" >nul || (
  echo FAILED: bad HOST %HOST% >> "%LOG%"
  exit /b 2
)

echo === %DATE% %TIME% start ===>> "%LOG%"
node scripts\adult-export.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: export >> "%LOG%"
  exit /b 1
)
node scripts\push-images.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: push-images >> "%LOG%"
  exit /b 1
)
scp -q storage\adult-export.json %HOST%:/tmp/adult-export.json >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: upload >> "%LOG%"
  exit /b 1
)
ssh %HOST% "cd '%REMOTE_APP%' && MH_DB='%REMOTE_APP%/storage/app.db' node scripts/adult-migrate.mjs /tmp/adult-export.json --mode '%MODE%' --trial '%TRIAL%'" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: remote migrate >> "%LOG%"
  exit /b 1
)
echo === %DATE% %TIME% done ===>> "%LOG%"
exit /b 0
