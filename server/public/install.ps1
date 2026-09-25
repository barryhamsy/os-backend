<#
    ONE GAMERS — Installer
    - Locates the Steam installation folder
    - Closes Steam
    - Removes old files if present: OpenSteamTool.dll, hid.dll, steam.cfg
    - Downloads the /installation payload from GitHub (millennium folder + DLLs + any config)
    - Copies everything into the Steam root
    - Restarts Steam

    Host this file on your server and have users run, in PowerShell:
        irm https://YOUR-SERVER/install.ps1 | iex
#>

# Where to re-fetch this script from when relaunching elevated.
# The server returns this script at the root URL when the request comes from
# PowerShell, so the short "irm onennabe.duckdns.org | iex" works too.
$ScriptUrl = 'https://onennabe.duckdns.org'

# Source of the payload (a public GitHub repo). The script downloads the repo
# zip and copies its "installation" folder into Steam.
$RepoZipUrl   = 'https://codeload.github.com/barryhamsy/os-backend/zip/refs/heads/main'
$PayloadInner = 'os-backend-main\installation'   # folder inside the extracted zip

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }

# ── Require administrator (needed to write into Program Files) ─────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Step 'Requesting administrator privileges...'
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-Command', "irm $ScriptUrl | iex"
        )
    } catch {
        Write-Warn2 'Could not auto-elevate. Right-click PowerShell -> Run as administrator, then run the command again.'
    }
    return
}

Write-Host ''
Write-Host '  ONE GAMERS Installer' -ForegroundColor White
Write-Host '  --------------------' -ForegroundColor DarkGray
Write-Host ''

# ── 1. Locate Steam ───────────────────────────────────────────────────────────
Write-Step 'Locating Steam...'
$steam = $null
try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath } catch {}
if (-not $steam) {
    try { $steam = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue).InstallPath } catch {}
}
if (-not $steam) { $steam = 'C:\Program Files (x86)\Steam' }
$steam = $steam -replace '/', '\'
$steam = $steam.TrimEnd('\')

if (-not (Test-Path (Join-Path $steam 'steam.exe'))) {
    Write-Warn2 "steam.exe not found in: $steam"
    $answer = Read-Host 'Enter your Steam folder path (or press Enter to abort)'
    if ([string]::IsNullOrWhiteSpace($answer)) { throw 'Steam folder not found. Aborting.' }
    $steam = $answer.TrimEnd('\')
    if (-not (Test-Path (Join-Path $steam 'steam.exe'))) { throw "steam.exe not found in: $steam" }
}
Write-Ok "Steam: $steam"

# ── 2. Close Steam ────────────────────────────────────────────────────────────
Write-Step 'Closing Steam...'
$wasRunning = $false
foreach ($proc in 'steam', 'steamwebhelper') {
    $p = Get-Process -Name $proc -ErrorAction SilentlyContinue
    if ($p) { $wasRunning = $true; $p | Stop-Process -Force -ErrorAction SilentlyContinue }
}
if ($wasRunning) { Start-Sleep -Seconds 4; Write-Ok 'Steam closed.' } else { Write-Ok 'Steam was not running.' }

# ── 3. Remove old files ───────────────────────────────────────────────────────
Write-Step 'Removing old files (if present)...'
foreach ($f in 'OpenSteamTool.dll', 'hid.dll', 'steam.cfg') {
    $path = Join-Path $steam $f
    if (Test-Path $path) {
        try { Remove-Item $path -Force; Write-Ok "Deleted $f" }
        catch { Write-Warn2 "Could not delete $f ($($_.Exception.Message))" }
    } else {
        Write-Ok "$f not present"
    }
}

# ── 4. Download payload ───────────────────────────────────────────────────────
Write-Step 'Downloading ONE GAMERS files...'
$tmp = Join-Path $env:TEMP ('onegamers_install_' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp 'payload.zip'
try {
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $zip -UseBasicParsing
} catch {
    throw "Download failed: $($_.Exception.Message)"
}
Write-Ok 'Downloaded.'

Write-Step 'Extracting...'
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Join-Path $tmp $PayloadInner
if (-not (Test-Path $src)) {
    throw "installation folder not found in the download ($PayloadInner). Make sure the 'installation' folder is committed and pushed to the repo."
}
Write-Ok 'Extracted.'

# ── 5. Copy into Steam (merges folders, overwrites files) ─────────────────────
Write-Step 'Installing into Steam...'
# robocopy is the reliable way to merge the millennium folder + DLLs into Steam.
$null = robocopy $src $steam /E /NFL /NDL /NJH /NJS /NC /NS /R:2 /W:2
if ($LASTEXITCODE -ge 8) {
    throw "Copy failed (robocopy exit $LASTEXITCODE)."
}
Write-Ok 'Files installed.'

# ── 6. Clean up ───────────────────────────────────────────────────────────────
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

# ── 7. Restart Steam ──────────────────────────────────────────────────────────
Write-Step 'Starting Steam...'
try {
    Start-Process (Join-Path $steam 'steam.exe')
    Write-Ok 'Steam started.'
} catch {
    Write-Warn2 'Could not start Steam automatically — start it yourself.'
}

Write-Host ''
Write-Host '  Done! Open Steam and use "ONE GAMERS Activation" next to "Add a Game".' -ForegroundColor Green
Write-Host ''
try { Read-Host 'Press Enter to close' } catch {}
