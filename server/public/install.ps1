<#  ONENNABE — Installer (native UI)  #>

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
        # -STA so WinForms works; -WindowStyle Hidden so no console shows behind
        # the native UI window (revealed again only if the GUI fails to load).
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
    $f.Text            = 'ONENNABE'
    $f.FormBorderStyle = 'FixedDialog'
    $f.ControlBox      = $false       # no close/min/max while installing
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.StartPosition   = 'CenterScreen'
    $f.ClientSize      = New-Object System.Drawing.Size(480, 190)
    $f.BackColor       = $bg
    $f.TopMost         = $true

    $title = New-Object System.Windows.Forms.Label
    $title.Text      = 'ONENNABE'
    $title.ForeColor = $green
    $title.Font      = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
    $title.AutoSize  = $true
    $title.Location  = New-Object System.Drawing.Point(28, 24)
    $f.Controls.Add($title)

    $sub = New-Object System.Windows.Forms.Label
    $sub.Text      = 'Steam Unlock — Installer'
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
        Write-Progress -Activity 'ONENNABE' -Status $text -PercentComplete $pct
    }
}

# Ask for a folder via a native dialog when the GUI is up, else fall back to the console.
function Ask-Folder($desc) {
    if ($script:Gui) {
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = $desc
        if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
        return $null
    }
    return Read-Host $desc
}

# Build the native UI. If WinForms is unavailable, fall back to the console.
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

    Step 'Preparing...' 15

    # Close Steam (quietly)
    foreach ($proc in 'steam', 'steamwebhelper') {
        Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3

    # Clean up old loader/config leftovers (quietly).
    # NOTE: OpenSteamTool.dll is intentionally NOT removed — the new build merges
    # everything into it, so it is required. The payload copy below refreshes it.
    Step 'Preparing...' 25
    foreach ($f in 'hid.dll', 'steam.cfg') {
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

    Step 'Extracting...' 60
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
    if ($script:Gui) {
        try {
            $script:Gui.Status.ForeColor = $script:Gui.Green
            $script:Gui.Status.Text = 'Ready — Steam is starting...'
            [System.Windows.Forms.Application]::DoEvents()
        } catch {}
        Start-Sleep -Seconds 2
        try { $script:Gui.Form.Close(); $script:Gui.Form.Dispose() } catch {}
    } else {
        Write-Progress -Activity 'ONENNABE' -Completed
        Write-Host ''
        Write-Host '  ONENNABE is ready. Steam is starting...' -ForegroundColor Green
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
                "Setup could not finish. Please try again.`n`n$detail",
                'ONENNABE', 'OK', 'Error') | Out-Null
            $script:Gui.Form.Close(); $script:Gui.Form.Dispose()
        } catch {}
    } else {
        Show-Console
        Write-Progress -Activity 'ONENNABE' -Completed
        Write-Host ''
        Write-Host '  Setup could not finish. Please try again.' -ForegroundColor Red
        if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray }
        Write-Host ''
        try { Read-Host 'Press Enter to close' } catch {}
    }
}
