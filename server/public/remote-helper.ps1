<#
  ONENNABE / OpenSteamTool — Remote Install Helper
  -------------------------------------------------
  Runs on your gaming PC (the one with Steam). It polls your ONENNABE server for
  "install this game" requests you send from the dashboard (from any device, on
  any network) and runs  steam://install/<appid>  locally so Steam pops its
  normal install dialog on THIS PC.

  The helper only ever reaches OUT to the server (HTTPS GET), so it works behind
  any home router / NAT — no port forwarding, no inbound connection.

  USAGE
    First-time setup (registers it to auto-start at every login, and starts it now):
      powershell -NoProfile -ExecutionPolicy Bypass -File .\remote-helper.ps1 -Install `
        -ServerUrl "https://onennabe.duckdns.org" -SteamId "7656119..." -Token "abc123..."

    Run once in the foreground (to watch it / test it):
      powershell -NoProfile -ExecutionPolicy Bypass -File .\remote-helper.ps1 `
        -ServerUrl "https://onennabe.duckdns.org" -SteamId "7656119..." -Token "abc123..."

    Remove the auto-start task:
      powershell -NoProfile -ExecutionPolicy Bypass -File .\remote-helper.ps1 -Uninstall

  The exact command with your SteamID and token is shown on the dashboard under
  "Set up remote install".
#>

[CmdletBinding()]
param(
  [string]$ServerUrl,
  [string]$SteamId,
  [string]$Token,
  [int]$IntervalSeconds = 3,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$AppName    = 'ONENNABE'
$TaskName   = 'ONENNABE Remote Install Helper'
$InstallDir = Join-Path $env:LOCALAPPDATA $AppName
$LogFile    = Join-Path $InstallDir 'remote-helper.log'

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = ('[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
  Write-Host $line
  try {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
  } catch {}
}

# ── Uninstall ────────────────────────────────────────────────────────────────
if ($Uninstall) {
  try {
    schtasks.exe /Delete /TN $TaskName /F | Out-Null
    Write-Log "Removed auto-start task '$TaskName'."
  } catch {
    Write-Log "No auto-start task to remove (or removal failed): $($_.Exception.Message)" 'WARN'
  }
  return
}

# ── Validate required settings ───────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($ServerUrl) -or
    [string]::IsNullOrWhiteSpace($SteamId)   -or
    [string]::IsNullOrWhiteSpace($Token)) {
  Write-Host 'ERROR: -ServerUrl, -SteamId and -Token are all required.' -ForegroundColor Red
  Write-Host 'Copy the exact command from the dashboard under "Set up remote install".'
  exit 1
}
$ServerUrl = $ServerUrl.TrimEnd('/')

# ── Install: copy self to a stable location + register logon task ────────────
if ($Install) {
  if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
  $target = Join-Path $InstallDir 'remote-helper.ps1'
  try { Copy-Item -Path $PSCommandPath -Destination $target -Force } catch { $target = $PSCommandPath }

  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $args  = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ServerUrl "{1}" -SteamId "{2}" -Token "{3}" -IntervalSeconds {4}' `
             -f $target, $ServerUrl, $SteamId, $Token, $IntervalSeconds
  # Register a per-user logon task that runs in the interactive session
  # (so steam:// can open the Steam UI). schtasks is used for maximum
  # compatibility across Windows versions and needs no admin for a user task.
  try {
    schtasks.exe /Create /TN $TaskName /TR "`"$psExe`" $args" /SC ONLOGON /RL LIMITED /F | Out-Null
    Write-Log "Installed auto-start task '$TaskName'. It will run at every login."
  } catch {
    Write-Log "Could not register scheduled task: $($_.Exception.Message). Falling back to Startup folder." 'WARN'
    $startup = [Environment]::GetFolderPath('Startup')
    $cmdPath = Join-Path $startup 'ONENNABE-remote-helper.cmd'
    Set-Content -Path $cmdPath -Value ('@echo off' + "`r`n" + '"' + $psExe + '" ' + $args) -Encoding ASCII
    Write-Log "Wrote startup launcher: $cmdPath"
  }

  # Launch it now (hidden) so the user doesn't have to log out/in first.
  Start-Process -FilePath $psExe `
    -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ServerUrl "{1}" -SteamId "{2}" -Token "{3}" -IntervalSeconds {4}' `
      -f $target, $ServerUrl, $SteamId, $Token, $IntervalSeconds)
  Write-Log "Helper started in the background. Setup complete — you can close this window."
  return
}

# ── Poll loop ────────────────────────────────────────────────────────────────
$endpoint = ('{0}/api/remote/commands/{1}?token={2}' -f $ServerUrl, $SteamId, [uri]::EscapeDataString($Token))
Write-Log "Helper running. Polling $ServerUrl every $IntervalSeconds s for SteamID $SteamId."
Write-Log "Press Ctrl+C to stop (if auto-start is installed it restarts at next login)."

$wasOffline = $false
while ($true) {
  try {
    $resp = Invoke-RestMethod -Uri $endpoint -Method Get -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-store' }
    if ($wasOffline) { Write-Log 'Reconnected to server.'; $wasOffline = $false }

    if ($resp -and $resp.commands) {
      foreach ($cmd in $resp.commands) {
        if ($cmd.type -eq 'install' -and $cmd.appid) {
          $appid = ($cmd.appid -replace '\D', '')
          if ($appid) {
            Write-Log "Install request for AppID $appid -> launching steam://install/$appid"
            try { Start-Process ("steam://install/$appid") }
            catch { Write-Log "Failed to launch Steam for $appid : $($_.Exception.Message)" 'ERROR' }
          }
        } else {
          Write-Log "Ignoring unknown command: $($cmd.type)" 'WARN'
        }
      }
    }
  } catch {
    if (-not $wasOffline) {
      Write-Log "Cannot reach server (will keep retrying): $($_.Exception.Message)" 'WARN'
      $wasOffline = $true
    }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
