@echo off
rem Load the current source into the running Orca (no plugin reinstall, no Orca restart).
rem   scripts\run-local.bat            -> reload (replace the running engine)
rem   scripts\run-local.bat status     -> any command of scripts\sync.mjs
setlocal
set "CMD=%~1"
if "%CMD%"=="" set "CMD=reload"
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0sync.mjs" %CMD% %2 %3 %4 %5 %6
) else (
  rem No Node on PATH: use the Node inside Orca.
  set "ELECTRON_RUN_AS_NODE=1"
  "%LOCALAPPDATA%\Programs\orca\Orca.exe" "%~dp0sync.mjs" %CMD% %2 %3 %4 %5 %6
)
