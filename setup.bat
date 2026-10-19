@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem AxiomPilotCode V1 alpha installer for Windows 10/11.
rem No Git, administrator rights, or PowerShell profile changes required.
rem Source is pinned to a reviewed Git commit, not to a moving branch.
set "AXIOM_VERSION=1.0.0-alpha.1"
set "AXIOM_SOURCE_SHA=a37e6bc2390d484599f5f34f3540abb0ccf231ab"
set "AXIOM_SOURCE_URL=https://codeload.github.com/zaoastronaftik-bit/axiom-pilot-code/zip/%AXIOM_SOURCE_SHA%"
set "AXIOM_WORK="

if /I "%~1"=="--ci" goto :start
if not "%~1"=="" (
  echo [ERROR] Unknown option: %~1
  echo Usage: setup.bat [--ci]
  exit /b 2
)

:start
title AxiomPilotCode V1 Alpha - Windows Setup
echo.
echo ====================================================
echo    AxiomPilotCode - Windows Setup
 echo   Version: %AXIOM_VERSION%  [DEVELOPER PREVIEW]
echo ====================================================
echo.
echo This installer downloads pinned source code from GitHub,
echo builds the CLI with npm and installs the pilotcode command.
echo It does NOT install a local AI model, start a server,
echo require administrator rights, or upload your chats.
echo.

call :install
set "AXIOM_EXIT_CODE=%ERRORLEVEL%"
if "%AXIOM_EXIT_CODE%"=="0" (
  if defined AXIOM_WORK if exist "%AXIOM_WORK%\" rmdir /s /q "%AXIOM_WORK%" >nul 2>nul
  echo.
  echo [SUCCESS] AxiomPilotCode %AXIOM_VERSION% is installed.
  echo Open a NEW CMD window and type: pilotcode doctor
  echo For local inference, start LM Studio Local Server first.
  echo Example: pilotcode --backend external --url http://127.0.0.1:1234/v1
  echo.
) else (
  echo.
  echo [FAILED] Installation stopped with exit code %AXIOM_EXIT_CODE%.
  if defined AXIOM_WORK echo Temporary files for troubleshooting: %AXIOM_WORK%
  echo Please copy the error text if you need help.
  echo.
)
if /I not "%~1"=="--ci" pause
exit /b %AXIOM_EXIT_CODE%

:install
where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required.
  echo Install the LTS version: https://nodejs.org/en/download
  exit /b 2
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found. Reinstall Node.js with npm.
  echo https://nodejs.org/en/download
  exit /b 2
)
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell is required to download the source archive.
  exit /b 2
)
set "AXIOM_NODE_MAJOR="
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "AXIOM_NODE_MAJOR=%%V"
if not defined AXIOM_NODE_MAJOR (
  echo [ERROR] Unable to detect the Node.js version.
  exit /b 2
)
if %AXIOM_NODE_MAJOR% LSS 22 (
  echo [ERROR] Found Node.js %AXIOM_NODE_MAJOR%; version 22 or newer is required.
  echo Download: https://nodejs.org/en/download
  exit /b 2
)
echo [1/6] Node.js and npm found.

set "AXIOM_WORK=%TEMP%\AxiomPilotCode-setup-%RANDOM%-%RANDOM%"
set "AXIOM_ZIP=%AXIOM_WORK%\source.zip"
mkdir "%AXIOM_WORK%" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Cannot create the temporary build directory.
  exit /b 1
)

echo [2/6] Downloading pinned V1 Alpha source from GitHub...
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:AXIOM_SOURCE_URL -OutFile $env:AXIOM_ZIP; Expand-Archive -LiteralPath $env:AXIOM_ZIP -DestinationPath $env:AXIOM_WORK -Force"
if errorlevel 1 (
  echo [ERROR] Could not download or extract the GitHub source archive.
  exit /b 1
)
set "AXIOM_SOURCE_DIR="
for /d %%D in ("%AXIOM_WORK%\axiom-pilot-code-*") do if exist "%%~fD\package-lock.json" set "AXIOM_SOURCE_DIR=%%~fD"
if not defined AXIOM_SOURCE_DIR (
  echo [ERROR] Downloaded archive does not contain the expected project files.
  exit /b 1
)

pushd "%AXIOM_SOURCE_DIR%"
if errorlevel 1 (
  echo [ERROR] Could not open the extracted source directory.
  exit /b 1
)
echo [3/6] Installing pinned build dependencies...
call npm.cmd ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 (
  popd
  echo [ERROR] npm ci failed. Check your network connection and npm output.
  exit /b 1
)

echo [4/6] Checking and compiling the CLI...
call npm.cmd run check
if errorlevel 1 (
  popd
  echo [ERROR] TypeScript checks failed. No program was installed.
  exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
  popd
  echo [ERROR] TypeScript build failed. No program was installed.
  exit /b 1
)

echo [5/6] Packaging and installing AxiomPilotCode...
call npm.cmd pack --ignore-scripts --pack-destination "%AXIOM_WORK%" --silent
if errorlevel 1 (
  popd
  echo [ERROR] Could not create the npm package.
  exit /b 1
)
popd
set "AXIOM_PACKAGE=%AXIOM_WORK%\axiom-pilot-code-%AXIOM_VERSION%.tgz"
if not exist "%AXIOM_PACKAGE%" (
  echo [ERROR] Expected package archive was not created.
  exit /b 1
)
call npm.cmd install -g --ignore-scripts --no-audit --no-fund "%AXIOM_PACKAGE%"
if errorlevel 1 (
  echo [ERROR] npm global installation failed.
  echo Check npm permissions and the error above. Do not run as admin by default.
  exit /b 1
)

echo [6/6] Verifying the installed command...
set "AXIOM_GLOBAL_PREFIX="
for /f "delims=" %%P in ('npm.cmd prefix -g 2^>nul') do set "AXIOM_GLOBAL_PREFIX=%%P"
if not defined AXIOM_GLOBAL_PREFIX (
  echo [ERROR] npm did not report a global installation path.
  exit /b 1
)
if not exist "%AXIOM_GLOBAL_PREFIX%\pilotcode.cmd" (
  echo [ERROR] Installed pilotcode command not found in: %AXIOM_GLOBAL_PREFIX%
  exit /b 1
)
call "%AXIOM_GLOBAL_PREFIX%\pilotcode.cmd" --version
if errorlevel 1 (
  echo [ERROR] Installed CLI could not start.
  exit /b 1
)
call "%AXIOM_GLOBAL_PREFIX%\pilotcode.cmd" doctor
if errorlevel 1 (
  echo [ERROR] The pilotcode doctor check failed.
  exit /b 1
)
exit /b 0
