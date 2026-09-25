<#  ONE GAMERS — Installer  #>

# Where to re-fetch this script from when relaunching elevated. The server also
# returns it at the root URL for PowerShell, so "irm onennabe.duckdns.org | iex" works.
$ScriptUrl    = 'https://onennabe.duckdns.org'
$RepoZipUrl   = 'https://codeload.github.com/barryhamsy/os-backend/zip/refs/heads/main'
$PayloadInner = 'os-backend-main\installation'

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ── Require administrator (silent) ────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "irm $ScriptUrl | iex"
        )
    } catch {}
    return
}

$Activity = 'ONE GAMERS'
function Step($status, $pct) { Write-Progress -Activity $Activity -Status $status -PercentComplete $pct }

try {
    Step 'Preparing...' 5

    # Locate Steam (quietly)
    $steam = $null
    try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath } catch {}
    if (-not $steam) {
        try { $steam = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue).InstallPath } catch {}
    }
    if (-not $steam) { $steam = 'C:\Program Files (x86)\Steam' }
    $steam = ($steam -replace '/', '\').TrimEnd('\')

    if (-not (Test-Path (Join-Path $steam 'steam.exe'))) {
        $answer = Read-Host 'Steam folder'
        if ([string]::IsNullOrWhiteSpace($answer)) { throw 'not found' }
        $steam = $answer.TrimEnd('\')
        if (-not (Test-Path (Join-Path $steam 'steam.exe'))) { throw 'not found' }
    }

    Step 'Preparing...' 15

    # Close Steam (quietly)
    foreach ($proc in 'steam', 'steamwebhelper') {
        Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3

    # Clean up old files (quietly)
    Step 'Preparing...' 25
    foreach ($f in 'OpenSteamTool.dll', 'hid.dll', 'steam.cfg') {
        $path = Join-Path $steam $f
        if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }

    # Download
    Step 'Downloading...' 35
    $tmp = Join-Path $env:TEMP ('og_' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp 'p.zip'
    $ProgressPreference = 'SilentlyContinue'   # hide the noisy per-byte download bar
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $zip -UseBasicParsing

    Step 'Downloading...' 60
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Join-Path $tmp $PayloadInner
    if (-not (Test-Path $src)) { throw 'payload missing' }

    # Install
    Step 'Installing...' 80
    $null = robocopy $src $steam /E /NFL /NDL /NJH /NJS /NC /NS /R:2 /W:2
    if ($LASTEXITCODE -ge 8) { throw 'copy failed' }

    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

    # Launch
    Step 'Finishing...' 95
    try { Start-Process (Join-Path $steam 'steam.exe') } catch {}

    Step 'Done' 100
    Start-Sleep -Milliseconds 600
    Write-Progress -Activity $Activity -Completed
    Write-Host ''
    Write-Host '  ONE GAMERS is ready. Steam is starting...' -ForegroundColor Green
    Write-Host ''
    Start-Sleep -Seconds 2
}
catch {
    Write-Progress -Activity $Activity -Completed
    Write-Host ''
    Write-Host '  Setup could not finish. Please try again.' -ForegroundColor Red
    Write-Host ''
    try { Read-Host 'Press Enter to close' } catch {}
}