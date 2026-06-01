#Requires -RunAsAdministrator
<#
.SYNOPSIS
  EURUSD Bot - Production Installer

.USAGE
  Option A - from cloned repo:
    .\install.ps1

  Option B - fresh machine (clones and configures everything):
    irm https://raw.githubusercontent.com/dnyvelasquez/eurusd-bot/main/install.ps1 | iex

#>

$ErrorActionPreference = 'Stop'
$REPO_URL    = 'https://github.com/dnyvelasquez/eurusd-bot.git'
$DEFAULT_DIR = 'C:\eurusd-bot'
$TASK_BRIDGE = 'eurusd-bridge'
$TASK_BOT    = 'eurusd-bot'

function Step { param($msg) Write-Host "`n[>>] $msg" -ForegroundColor Cyan }
function OK   { param($msg) Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn { param($msg) Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Fail { param($msg) Write-Host "  ERR $msg" -ForegroundColor Red; exit 1 }

# -- admin check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator and try again.' }

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '   EURUSD Bot  -  Production Installer   ' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan

# -- repo
Step 'Repository'
if ($PSScriptRoot -and (Test-Path "$PSScriptRoot\.git")) {
    $REPO_DIR = $PSScriptRoot
    OK "Using repo at $REPO_DIR"
} elseif (Test-Path "$DEFAULT_DIR\.git") {
    $REPO_DIR = $DEFAULT_DIR
    OK "Repo found at $REPO_DIR"
} else {
    $REPO_DIR = $DEFAULT_DIR
    try { git --version | Out-Null } catch { Fail 'Git is not installed. Download from https://git-scm.com' }
    Write-Host "  Cloning to $REPO_DIR..."
    git clone $REPO_URL $REPO_DIR
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed" }
    OK 'Cloned'
}
Set-Location $REPO_DIR

# -- node.js
Step 'Node.js 20+'
$hasNode = $false
try {
    $ver = node --version 2>&1
    if ([int]($ver.ToString().TrimStart('v').Split('.')[0]) -ge 20) { $hasNode = $true }
} catch {}
if (-not $hasNode) {
    Write-Host '  Installing Node.js LTS via winget...'
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
}
OK "Node.js $(node --version)"

# -- python
Step 'Python 3.11+'
$pythonCmd = $null
foreach ($cmd in @('python','python3','py')) {
    try {
        $pv = & $cmd --version 2>&1
        $parts = $pv.ToString().Replace('Python ','').Split('.')
        if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11) { $pythonCmd = $cmd; break }
    } catch {}
}
if (-not $pythonCmd) {
    Write-Host '  Installing Python 3.11 via winget...'
    winget install --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements --silent
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
    $pythonCmd = 'python'
}
OK "Python $(& $pythonCmd --version)"

# -- build bot
Step 'Bot - npm install + build'
npm ci --prefer-offline
if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (exit $LASTEXITCODE)" }
npm run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build failed (exit $LASTEXITCODE)" }
OK 'TypeScript compiled -> dist/'

# -- python venv + deps
Step 'Bridge - Python environment'
$VENV = "$REPO_DIR\apps\mt5-bridge\.venv"
if (-not (Test-Path "$VENV\Scripts\python.exe")) {
    & $pythonCmd -m venv $VENV
    if ($LASTEXITCODE -ne 0) { Fail "python -m venv failed (exit $LASTEXITCODE)" }
    OK 'venv created'
} else {
    OK 'venv already exists'
}
& "$VENV\Scripts\pip.exe" install --quiet --upgrade pip
if ($LASTEXITCODE -ne 0) { Fail "pip upgrade failed (exit $LASTEXITCODE)" }
& "$VENV\Scripts\pip.exe" install --quiet -r "$REPO_DIR\apps\mt5-bridge\requirements.txt"
if ($LASTEXITCODE -ne 0) { Fail "pip install requirements failed (exit $LASTEXITCODE)" }
OK 'Python dependencies installed'

# -- .env
Step '.env'
$envPath = "$REPO_DIR\.env"
if (-not (Test-Path $envPath)) {
    Copy-Item "$REPO_DIR\.env.example" $envPath
    OK '.env created from template'
} else {
    OK '.env exists'
}

function Get-EnvValue($file, $key) {
    $line = Get-Content $file | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    if ($line) { return $line.Split('=', 2)[1].Trim("'`"") }
    return $null
}

function Set-EnvValue($file, $key, $value) {
    $content = Get-Content $file
    $found   = $false
    $updated = $content | ForEach-Object {
        if ($_ -match "^$key=") { "$key=$value"; $found = $true } else { $_ }
    }
    if (-not $found) { $updated += "$key=$value" }
    $updated | Set-Content $file -Encoding utf8
}

# -- Telegram token
Step 'Telegram - Bot Token'
do {
    $newToken = Read-Host '  Bot Token (get it from @BotFather)'
    $valid = $newToken -match '^\d+:[A-Za-z0-9_-]{35,}$'
    if (-not $valid) { Warn '  Invalid format - expected: 123456789:AABBccDD...' }
} while (-not $valid)
Set-EnvValue $envPath 'TELEGRAM_BOT_TOKEN' $newToken
OK 'TELEGRAM_BOT_TOKEN saved'

# -- Telegram chat ID
Step 'Telegram - Chat ID'
do {
    $newChatId = Read-Host '  Chat ID (send a message to the bot and check api.telegram.org/bot{TOKEN}/getUpdates)'
    $valid = $newChatId -match '^-?\d+$'
    if (-not $valid) { Warn '  Invalid format - expected a number (e.g. 6423918192)' }
} while (-not $valid)
Set-EnvValue $envPath 'TELEGRAM_CHAT_ID' $newChatId
OK 'TELEGRAM_CHAT_ID saved'

# -- license key
Step 'License key'
$configPath  = "$REPO_DIR\config.json"
$uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
do {
    $newKey = Read-Host '  License key (UUID format)'
    $valid  = $newKey -match $uuidPattern
    if (-not $valid) { Warn '  Invalid format - expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }
} while (-not $valid)
$cfg.LICENSE_KEY = $newKey.ToLower()
$cfg | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8
OK 'License key saved to config.json'

# -- logs dir
New-Item -ItemType Directory -Force -Path "$REPO_DIR\logs" | Out-Null
OK 'logs/ directory ready'

# -- scheduled tasks
Step 'Windows Scheduled Tasks'
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "  Running as: $currentUser" -ForegroundColor White

$settingsCommon = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

# bridge
$bridgeScript = "$REPO_DIR\scripts\run-bridge.ps1"
$bridgeAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$bridgeScript`"" `
    -WorkingDirectory "$REPO_DIR\apps\mt5-bridge"
Unregister-ScheduledTask -TaskName $TASK_BRIDGE -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TASK_BRIDGE `
    -Action      $bridgeAction `
    -Settings    $settingsCommon `
    -RunLevel    Highest `
    -Description 'EURUSD Bot - MT5 Bridge (FastAPI/uvicorn)' | Out-Null
OK "Task '$TASK_BRIDGE' registered (manual start only)"

# bot
$botScript = "$REPO_DIR\scripts\run-bot.ps1"
$botAction  = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$botScript`"" `
    -WorkingDirectory $REPO_DIR

Unregister-ScheduledTask -TaskName $TASK_BOT -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TASK_BOT `
    -Action      $botAction `
    -Settings    $settingsCommon `
    -RunLevel    Highest `
    -Description 'EURUSD Bot - Trading Engine (Node.js)' | Out-Null
OK "Task '$TASK_BOT' registered (manual start only)"

# -- done
Write-Host ''
Write-Host '======================================' -ForegroundColor Green
Write-Host '   Installation complete!            ' -ForegroundColor Green
Write-Host '======================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Next steps:' -ForegroundColor White
Write-Host ''
Write-Host '  1. Start the bot:'
Write-Host "       $REPO_DIR\start.ps1"
Write-Host ''
Write-Host '  2. Check logs:'
Write-Host "       $REPO_DIR\logs\"
Write-Host ''
Write-Host '  3. Future updates:'
Write-Host "       $REPO_DIR\update.ps1"
Write-Host ''
Write-Host '  El bot NO se inicia automaticamente. Usa start.ps1 y stop.ps1.' -ForegroundColor Cyan
Write-Host '  Asegurate de abrir MetaTrader 5 manualmente antes de ejecutar start.ps1.' -ForegroundColor Yellow
