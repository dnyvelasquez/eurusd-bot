#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Inicia el bridge MT5 y el bot de trading.
  Uso: .\start.ps1
#>

$TASK_BRIDGE = 'spx500-bridge'
$TASK_BOT    = 'spx500-bot'

function TaskState($name) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { return 'NOT_FOUND' }
    return $t.State
}

Write-Host ''
Write-Host '[SPX500 Bot] Iniciando servicios...' -ForegroundColor Cyan

# Verify tasks exist
if ((TaskState $TASK_BRIDGE) -eq 'NOT_FOUND') {
    Write-Host "  ERROR: Tarea '$TASK_BRIDGE' no encontrada. Ejecuta install.ps1 primero." -ForegroundColor Red
    exit 1
}
if ((TaskState $TASK_BOT) -eq 'NOT_FOUND') {
    Write-Host "  ERROR: Tarea '$TASK_BOT' no encontrada. Ejecuta install.ps1 primero." -ForegroundColor Red
    exit 1
}

# Start bridge
if ((TaskState $TASK_BRIDGE) -eq 'Running') {
    Write-Host "  Bridge ya está corriendo." -ForegroundColor DarkGray
} else {
    Start-ScheduledTask -TaskName $TASK_BRIDGE
    Write-Host "  Bridge iniciado." -ForegroundColor Green
}

# Short wait then start bot
Start-Sleep -Seconds 3

# Start bot
if ((TaskState $TASK_BOT) -eq 'Running') {
    Write-Host "  Bot ya está corriendo." -ForegroundColor DarkGray
} else {
    Start-ScheduledTask -TaskName $TASK_BOT
    Write-Host "  Bot iniciado (espera 15s para que el bridge levante)." -ForegroundColor Green
}

Write-Host ''
Write-Host '  Estado:' -ForegroundColor White
Write-Host "    Bridge : $(TaskState $TASK_BRIDGE)"
Write-Host "    Bot    : $(TaskState $TASK_BOT)"
Write-Host ''
Write-Host "  Logs: $PSScriptRoot\logs\" -ForegroundColor DarkGray
