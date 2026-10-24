@echo off
cd /d "%~dp0\.."
:loop
node server.js
echo [start-windows] Bot kapandi (kod %ERRORLEVEL%). 5 sn sonra yeniden baslatiliyor... Durdurmak icin Ctrl+C.
timeout /t 5 /nobreak >nul
goto loop
