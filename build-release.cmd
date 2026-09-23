@echo off
rem Double-click entry for scripts\build-release.ps1; extra args are passed through, e.g. build-release.cmd -Bundle -Test
powershell -NoProfile -File "%~dp0scripts\build-release.ps1" %*
set "code=%ERRORLEVEL%"
pause
exit /b %code%
