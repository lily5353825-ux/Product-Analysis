@echo off
cd /d "%~dp0"
node scripts/build.mjs
if errorlevel 1 (
  echo Build failed. Install Node.js 22 or newer and try again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4173 in your browser.
echo Press Ctrl+C to stop the local dashboard.
node scripts/serve.mjs
