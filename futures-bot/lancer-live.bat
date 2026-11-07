@echo off
cd /d "%~dp0"
title Futures Desk - LIVE (argent reel)
start "" http://127.0.0.1:8790
node src\index.js --mode=live
pause
