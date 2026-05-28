#Requires -RunAsAdministrator
<#
.SYNOPSIS
  SPX500 Bot - Production Installer

.DESCRIPTION
  Instala dependencias, compila el bot y registra los servicios como
  Scheduled Tasks de Windows que arrancan automáticamente al iniciar sesión.

.USAGE
  Desde cualquier máquina Windows (PowerShell como Admin):

    # Opción A - repo ya clonado:
    .\install.ps1

    # Opción B - máquina limpia (clona y configura todo):
    irm https://raw.githubusercontent.com/dnyvelasquez/spx500-bot/main/install.ps1 | iex

.NOTES
  Requisito MT5: el terminal de MetaTrader 5 debe estar configurado para
  arrancar automáticamente con Windows (o al iniciar sesión del usuario).
  El bridge se ejecuta en la sesión del usuario para poder comunicarse con MT5.
#>

$ErrorActionPreference = 'Stop'
$REPO_URL     = 'https://github.com/dnyvelasquez/spx500-bot.git'
$DEFAULT_DIR  = 'C:\spx500-bot'
$TASK_BRIDGE  = 'spx500-bridge'
$TASK_BOT     = 'spx500-bot'

# ── helpers ────────────────────────────────────────────────────────────────
function Step { param($msg) Write-Host "`n[>>] $msg" -ForegroundColor Cyan }
function OK   { param($msg) Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn { param($msg) Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Fail { param($msg) Write-Host "  ERR $msg" -ForegroundColor Red; exit 1 }

# ── check admin ────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Abre PowerShell como Administrador y vuelve a ejecutar.' }

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '   SPX500 Bot  —  Production Installer   ' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan

# ── determine repo directory ────────────────────────────────────────────────
Step 'Repositorio'
if ($PSScriptRoot -and (Test-Path "$PSScriptRoot\.git")) {
    $REPO_DIR = $PSScriptRoot
    OK "Usando repo en $REPO_DIR"
} elseif (Test-Path "$DEFAULT_DIR\.git") {
    $REPO_DIR = $DEFAULT_DIR
    OK "Repo encontrado en $REPO_DIR"
} else {
    $REPO_DIR = $DEFAULT_DIR
    try { git --version | Out-Null } catch { Fail 'Git no está instalado. Descárgalo desde https://git-scm.com' }
    Write-Host "  Clonando en $REPO_DIR..."
    git clone $REPO_URL $REPO_DIR
    OK 'Clonado'
}
Set-Location $REPO_DIR

# ── node.js ────────────────────────────────────────────────────────────────
Step 'Node.js 20+'
$hasNode = $false
try {
    $ver = node --version 2>&1
    if ([int]($ver.ToString().TrimStart('v').Split('.')[0]) -ge 20) { $hasNode = $true }
} catch {}
if (-not $hasNode) {
    Write-Host '  Instalando Node.js LTS via winget...'
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
}
OK "Node.js $(node --version)"

# ── python ─────────────────────────────────────────────────────────────────
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
    Write-Host '  Instalando Python 3.11 via winget...'
    winget install --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements --silent
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
    $pythonCmd = 'python'
}
OK "Python $(& $pythonCmd --version)"

# ── build bot ──────────────────────────────────────────────────────────────
Step 'Bot — npm install + build'
npm ci --prefer-offline
if ($LASTEXITCODE -ne 0) { Fail "npm ci falló (código $LASTEXITCODE)" }
npm run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build falló (código $LASTEXITCODE)" }
OK 'TypeScript compilado → dist/'

# ── python venv + deps ─────────────────────────────────────────────────────
Step 'Bridge — entorno Python'
$VENV = "$REPO_DIR\apps\mt5-bridge\.venv"
if (-not (Test-Path "$VENV\Scripts\python.exe")) {
    & $pythonCmd -m venv $VENV
    if ($LASTEXITCODE -ne 0) { Fail "python -m venv falló (código $LASTEXITCODE)" }
    OK 'venv creado'
} else {
    OK 'venv ya existe'
}
& "$VENV\Scripts\pip.exe" install --quiet --upgrade pip
if ($LASTEXITCODE -ne 0) { Fail "pip upgrade falló (código $LASTEXITCODE)" }
& "$VENV\Scripts\pip.exe" install --quiet -r "$REPO_DIR\apps\mt5-bridge\requirements.txt"
if ($LASTEXITCODE -ne 0) { Fail "pip install requirements falló (código $LASTEXITCODE)" }
OK 'Dependencias Python instaladas'

# ── .env ───────────────────────────────────────────────────────────────────
Step '.env'
if (-not (Test-Path "$REPO_DIR\.env")) {
    Copy-Item "$REPO_DIR\.env.example" "$REPO_DIR\.env"
    Warn '.env creado desde plantilla — EDÍTALO antes de iniciar el bot:'
    Warn "  notepad $REPO_DIR\.env"
} else {
    OK '.env existe'
}

# ── license key ────────────────────────────────────────────────────────────
Step 'License key'
$configPath = "$REPO_DIR\config.json"
$uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$currentKey = $cfg.LICENSE_KEY

$askForKey = $true
if ($currentKey -and $currentKey -match $uuidPattern) {
    Write-Host "  License key actual: $currentKey" -ForegroundColor DarkGray
    $resp = Read-Host "  Cambiarla? [s/N]"
    $askForKey = ($resp -eq 's' -or $resp -eq 'S')
}

if ($askForKey) {
    do {
        $newKey = Read-Host "  License key (UUID)"
        $valid  = $newKey -match $uuidPattern
        if (-not $valid) { Warn "  Formato inválido — debe ser: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
    } while (-not $valid)

    $cfg.LICENSE_KEY = $newKey.ToLower()
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8
    OK "License key guardada en config.json"
} else {
    OK 'License key sin cambios'
}

# ── logs dir ───────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$REPO_DIR\logs" | Out-Null
OK 'Directorio logs/ listo'

# ── scheduled tasks ────────────────────────────────────────────────────────
Step 'Scheduled Tasks de Windows'

$currentUser = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "  Tareas ejecutadas como: $currentUser" -ForegroundColor White
Write-Host ''
Write-Host '  NOTA: Las tareas corren en tu sesión de usuario para que el' -ForegroundColor DarkGray
Write-Host '  bridge pueda comunicarse con el terminal de MetaTrader 5.'    -ForegroundColor DarkGray
Write-Host ''

$settingsCommon = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

# -- bridge
$bridgeScript = "$REPO_DIR\scripts\run-bridge.ps1"
$bridgeAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$bridgeScript`"" `
    -WorkingDirectory "$REPO_DIR\apps\mt5-bridge"

$bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

Unregister-ScheduledTask -TaskName $TASK_BRIDGE -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TASK_BRIDGE `
    -Action      $bridgeAction `
    -Trigger     $bridgeTrigger `
    -Settings    $settingsCommon `
    -RunLevel    Highest `
    -Description 'SPX500 Bot — MT5 Bridge (FastAPI/uvicorn)' | Out-Null
OK "Tarea '$TASK_BRIDGE' registrada"

# -- bot (15 s delay via run-bot.ps1)
$botScript  = "$REPO_DIR\scripts\run-bot.ps1"
$botAction  = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$botScript`"" `
    -WorkingDirectory $REPO_DIR

$botTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

Unregister-ScheduledTask -TaskName $TASK_BOT -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TASK_BOT `
    -Action      $botAction `
    -Trigger     $botTrigger `
    -Settings    $settingsCommon `
    -RunLevel    Highest `
    -Description 'SPX500 Bot — Trading Engine (Node.js)' | Out-Null
OK "Tarea '$TASK_BOT' registrada"

# ── done ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '   Instalación completa!               ' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Próximos pasos:' -ForegroundColor White
Write-Host ''
Write-Host '  1. Configura tus credenciales:' -ForegroundColor Yellow
Write-Host "       notepad $REPO_DIR\.env"
Write-Host "       notepad $REPO_DIR\config.json"
Write-Host ''
Write-Host '  2. Inicia el bot:'
Write-Host "       $REPO_DIR\start.ps1"
Write-Host ''
Write-Host '  3. Verifica los logs:'
Write-Host "       $REPO_DIR\logs\"
Write-Host ''
Write-Host '  4. Para actualizaciones futuras:'
Write-Host "       $REPO_DIR\update.ps1"
Write-Host ''
Write-Host '  IMPORTANTE: Configura MetaTrader 5 para arrancar con Windows.' -ForegroundColor Yellow
Write-Host '  (Herramientas > Opciones > General > Iniciar con Windows)'     -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Los servicios arrancan automáticamente en cada inicio de sesión.' -ForegroundColor Cyan
