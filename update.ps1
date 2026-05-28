#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Descarga la última versión, recompila y reinicia los servicios.
  Uso: .\update.ps1
#>

$ErrorActionPreference = 'Stop'
$REPO_DIR    = $PSScriptRoot
$TASK_BRIDGE = 'spx500-bridge'
$TASK_BOT    = 'spx500-bot'

function TaskState($name) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { return 'NOT_FOUND' }
    return $t.State
}

Write-Host ''
Write-Host '[SPX500 Bot] Actualizando...' -ForegroundColor Cyan
Set-Location $REPO_DIR

# 1. Stop services
Write-Host '  Deteniendo servicios...' -ForegroundColor DarkGray
if ((TaskState $TASK_BOT) -eq 'Running')    { Stop-ScheduledTask -TaskName $TASK_BOT }
Start-Sleep -Seconds 2
if ((TaskState $TASK_BRIDGE) -eq 'Running') { Stop-ScheduledTask -TaskName $TASK_BRIDGE }
Start-Sleep -Seconds 2
Write-Host '  Servicios detenidos.' -ForegroundColor Green

# 2. Pull latest
Write-Host '  git pull...' -ForegroundColor DarkGray
git pull --ff-only
Write-Host '  Código actualizado.' -ForegroundColor Green

# 3. Rebuild bot
Write-Host '  npm ci + build...' -ForegroundColor DarkGray
npm ci --prefer-offline
npm run build
Write-Host '  Build completo.' -ForegroundColor Green

# 4. Update Python deps (in case requirements.txt changed)
$VENV = "$REPO_DIR\apps\mt5-bridge\.venv"
Write-Host '  pip install...' -ForegroundColor DarkGray
& "$VENV\Scripts\pip.exe" install --quiet -r "$REPO_DIR\apps\mt5-bridge\requirements.txt"
Write-Host '  Dependencias Python OK.' -ForegroundColor Green

# 5. Restart services
Write-Host '  Reiniciando servicios...' -ForegroundColor DarkGray
Start-ScheduledTask -TaskName $TASK_BRIDGE
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName $TASK_BOT

Write-Host ''
Write-Host '  Estado:' -ForegroundColor White
Start-Sleep -Seconds 2
Write-Host "    Bridge : $(TaskState $TASK_BRIDGE)"
Write-Host "    Bot    : $(TaskState $TASK_BOT)"
Write-Host ''
Write-Host '  Actualización completa.' -ForegroundColor Green
