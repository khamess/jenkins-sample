@echo off
cd /d "%~dp0"
title MEXC Desk - PAPER
start "" http://127.0.0.1:8790
node src\index.js --mode=paper
pause
