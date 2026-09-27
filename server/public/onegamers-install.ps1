<#  OneGamers Activation — Millennium plugin installer (native UI)  #>

# Served from the os-backend server, run via:
#   irm onennabe.duckdns.org/gamekey | iex
$ScriptUrl = 'https://onennabe.duckdns.org/gamekey'
# The built plugin bundle. Drop the `bun run build` output
# (com.onegamers.gamekey.star) into os-backend\onegamers\ or os-backend\server\public\.
$StarUrl   = 'https://onennabe.duckdns.org/onegamers/com.onegamers.gamekey.star'
$PluginId  = 'com.onegamers.gamekey'
$StarName  = 'com.onegamers.gamekey.star'

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ── Require administrator (silent) ────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-Command', "irm $ScriptUrl | iex"
        )
    } catch {}
    return
}

# ── Console show/hide (so only the native window is visible) ──────────────────
$script:ConsoleApi = $null
try {
    $script:ConsoleApi = Add-Type -Name Win -Namespace OGNative -PassThru -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
} catch {}
function Hide-Console { try { if ($script:ConsoleApi) { $null = $script:ConsoleApi::ShowWindow($script:ConsoleApi::GetConsoleWindow(), 0) } } catch {} }
function Show-Console { try { if ($script:ConsoleApi) { $null = $script:ConsoleApi::ShowWindow($script:ConsoleApi::GetConsoleWindow(), 5) } } catch {} }

# ── Native progress window (WinForms) ─────────────────────────────────────────
function New-Gui {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $bg    = [System.Drawing.Color]::FromArgb(15, 23, 32)
    $green = [System.Drawing.Color]::FromArgb(57, 211, 83)
    $red   = [System.Drawing.Color]::FromArgb(248, 113, 113)
    $light = [System.Drawing.Color]::FromArgb(230, 237, 243)
    $muted = [System.Drawing.Color]::FromArgb(148, 163, 184)

    $f = New-Object System.Windows.Forms.Form
    $f.Text            = 'OneGamers'
    $f.FormBorderStyle = 'FixedDialog'
    $f.ControlBox      = $false
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object System.Drawing.Size(480, 190)
    $f.BackColor       = $bg
    $f.TopMost         = $true

    $title = New-Object System.Windows.Forms.Label
    $title.Text      = 'OneGamers'
    $title.ForeColor = $green
    $title.Font      = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
    $title.AutoSize  = $true
    $title.Location  = New-Object System.Drawing.Point(28, 24)
    $f.Controls.Add($title)

    $sub = New-Object System.Windows.Forms.Label
    $sub.Text      = 'Activation plugin — Installer'
    $sub.ForeColor = $muted
    $sub.Font      = New-Object System.Drawing.Font('Segoe UI', 9)
    $sub.AutoSize  = $true
    $sub.Location  = New-Object System.Drawing.Point(30, 58)
    $f.Controls.Add($sub)

    $status = New-Object System.Windows.Forms.Label
    $status.Text      = 'Preparing...'
    $status.ForeColor = $light
    $status.Font      = New-Object System.Drawing.Font('Segoe UI', 10)
    $status.AutoSize  = $false
    $status.Location  = New-Object System.Drawing.Point(30, 96)
    $status.Size      = New-Object System.Drawing.Size(420, 22)
    $f.Controls.Add($status)

    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Style    = 'Continuous'
    $bar.Minimum  = 0
    $bar.Maximum  = 100
    $bar.Value    = 0
    $bar.Location = New-Object System.Drawing.Point(30, 126)
    $bar.Size     = New-Object System.Drawing.Size(420, 16)
    $f.Controls.Add($bar)

    $f.Show()
    $f.Activate()
    [System.Windows.Forms.Application]::DoEvents()

    return [pscustomobject]@{ Form = $f; Status = $status; Bar = $bar; Green = $green; Red = $red }
}

function Step($text, $pct) {
    if ($script:Gui) {
        try {
            $script:Gui.Status.Text = $text
            $v = [int]$pct; if ($v -lt 0) { $v = 0 }; if ($v -gt 100) { $v = 100 }
            $script:Gui.Bar.Value = $v
            [System.Windows.Forms.Application]::DoEvents()
        } catch {}
    } else {
        Write-Progress -Activity 'OneGamers' -Status $text -PercentComplete $pct
    }
}

function Ask-Folder($desc) {
    if ($script:Gui) {
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = $desc
        if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
        return $null
    }
    return Read-Host $desc
}

$script:Gui = $null
try { $script:Gui = New-Gui } catch { $script:Gui = $null }
if ($script:Gui) { Hide-Console } else { Show-Console }

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
        $answer = Ask-Folder 'Select your Steam folder'
        if ([string]::IsNullOrWhiteSpace($answer)) { throw 'Steam folder not found.' }
        $steam = $answer.TrimEnd('\')
        if (-not (Test-Path (Join-Path $steam 'steam.exe'))) { throw 'Steam folder not found.' }
    }

    # Ensure Millennium plugins directory exists
    $mPlugins = Join-Path $steam 'millennium\plugins'
    $mConfig  = Join-Path $steam 'millennium\config\config.json'
    if (-not (Test-Path $mPlugins)) {
        New-Item -ItemType Directory -Path $mPlugins -Force | Out-Null
    }

    Step 'Preparing...' 15

    # Close Steam so reloads plugins + config cleanly on launch.
    foreach ($proc in 'steam', 'steamwebhelper') {
        Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3

    # Fetch and download all files inside os-backend\server\onegamers\ from the server
    Step 'Downloading files...' 40
    $ProgressPreference = 'SilentlyContinue'
    $downloadedCount = 0

    $filesList = @()
    try {
        $res = Invoke-RestMethod -Uri 'https://onennabe.duckdns.org/api/onegamers/files' -UseBasicParsing
        if ($res -and $res.files) { $filesList = $res.files }
    } catch {}

    if ($filesList.Count -gt 0) {
        foreach ($file in $filesList) {
            $relPath  = ($file.path -replace '/', '\')
            $destFile = Join-Path $steam $relPath
            $destDir  = Split-Path $destFile
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

            $downloadUrl = "https://onennabe.duckdns.org/onegamers/$($file.path)"
            try {
                Invoke-WebRequest -Uri $downloadUrl -OutFile $destFile -UseBasicParsing
                if (Test-Path $destFile) { $downloadedCount++ }
            } catch {}

            # If it's the plugin bundle (.star), also ensure a copy in millennium\plugins\
            if ($file.path -like '*.star' -or $file.path -eq $StarName) {
                $pluginStarPath = Join-Path $mPlugins $StarName
                if ($destFile -ne $pluginStarPath) {
                    try { Copy-Item -Path $destFile -Destination $pluginStarPath -Force } catch {}
                }
            }
        }
    }

    # Fallback: if no files were downloaded via API list, attempt direct download of plugin bundle
    if ($downloadedCount -eq 0) {
        Step 'Downloading plugin bundle...' 50
        $starPath = Join-Path $mPlugins $StarName
        $downloaded = $false

        foreach ($url in @('https://onennabe.duckdns.org/onegamers/com.onegamers.gamekey.star', 'https://onennabe.duckdns.org/com.onegamers.gamekey.star')) {
            try {
                Invoke-WebRequest -Uri $url -OutFile $starPath -UseBasicParsing
                if ((Test-Path $starPath) -and (Get-Item $starPath).Length -ge 1024) { $downloaded = $true; break }
            } catch {}
        }
        if (-not $downloaded) {
            throw "Couldn't download $StarName from the server. Make sure files are placed in os-backend\server\onegamers\ on the server."
        }
    }

    # Enable the plugin in Millennium's config.json (plugins.enabledPlugins).
    Step 'Enabling...' 75
    try {
        $cfg = $null
        if (Test-Path $mConfig) {
            try { $cfg = Get-Content $mConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { $cfg = $null }
        }
        if (-not $cfg) { $cfg = [pscustomobject]@{} }
        if (-not $cfg.PSObject.Properties['plugins']) {
            $cfg | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        if (-not $cfg.plugins.PSObject.Properties['enabledPlugins']) {
            $cfg.plugins | Add-Member -NotePropertyName enabledPlugins -NotePropertyValue @() -Force
        }
        $list = @($cfg.plugins.enabledPlugins | Where-Object { $_ })
        if ($list -notcontains $PluginId) { $list = @($list + $PluginId) }
        # Assign back as an array so the JSON keeps enabledPlugins as a list.
        $cfg.plugins.enabledPlugins = @($list)

        $dir = Split-Path $mConfig
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        ($cfg | ConvertTo-Json -Depth 20) | Set-Content -Path $mConfig -Encoding UTF8
    } catch {
        # Non-fatal: the .star is in place; the user can enable it in
        # Millennium → Plugins if the config edit didn't take.
    }

    # Launch Steam
    Step 'Finishing...' 95
    try { Start-Process (Join-Path $steam 'steam.exe') } catch {}

    Step 'Done' 100
    if ($script:Gui) {
        try {
            $script:Gui.Status.ForeColor = $script:Gui.Green
            $script:Gui.Status.Text = 'Installed — Steam is starting...'
            [System.Windows.Forms.Application]::DoEvents()
        } catch {}
        Start-Sleep -Seconds 2
        try { $script:Gui.Form.Close(); $script:Gui.Form.Dispose() } catch {}
    } else {
        Write-Progress -Activity 'OneGamers' -Completed
        Write-Host ''
        Write-Host '  OneGamers Activation installed. Steam is starting...' -ForegroundColor Green
        Write-Host '  Open Steam -> Settings -> OneGamers Activation to redeem a key.' -ForegroundColor Gray
        Write-Host ''
        Start-Sleep -Seconds 2
    }
}
catch {
    $detail = ''
    try { $detail = $_.Exception.Message } catch {}
    if ($script:Gui) {
        try {
            $script:Gui.Status.ForeColor = $script:Gui.Red
            $script:Gui.Status.Text = 'Setup could not finish.'
            [System.Windows.Forms.Application]::DoEvents()
            [System.Windows.Forms.MessageBox]::Show(
                "Setup could not finish.`n`n$detail",
                'OneGamers', 'OK', 'Error') | Out-Null
            $script:Gui.Form.Close(); $script:Gui.Form.Dispose()
        } catch {}
    } else {
        Show-Console
        Write-Progress -Activity 'OneGamers' -Completed
        Write-Host ''
        Write-Host '  Setup could not finish.' -ForegroundColor Red
        if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray }
        Write-Host ''
        try { Read-Host 'Press Enter to close' } catch {}
    }
}
