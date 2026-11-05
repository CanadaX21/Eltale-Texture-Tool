@echo off
setlocal
title Eltale Texture Tool
set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY py -3 --version >nul 2>&1 && set "PY=py -3"
if defined PY goto run
echo Python 3 was not found. Install it from https://www.python.org/downloads/
echo Then install Pillow with:  python -m pip install pillow
set RC=1
goto end
:run
%PY% "%~dp0drop_helper.py" export %*
set RC=%ERRORLEVEL%
:end
echo.
pause
exit /b %RC%
