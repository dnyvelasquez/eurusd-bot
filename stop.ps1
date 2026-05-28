#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Detiene el bot y el bridge MT5.
  Uso: .\stop.ps1
#>

$TASK_BRIDGE = 'spx500-bridge'
$TASK_BOT    = 'spx500-bot'

function TaskState($name) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { return 'NOT_FOUND' }
    return $t.State
}

Write-Host ''
Write-Host '[SPX500 Bot] Deteniendo servicios...' -ForegroundColor Cyan

# Stop bot first (before bridge)
if ((TaskState $TASK_BOT) -eq 'Running') {
    Stop-ScheduledTask -TaskName $TASK_BOT
    Write-Host "  Bot detenido." -ForegroundColor Yellow
} else {
    Write-Host "  Bot no estaba corriendo." -ForegroundColor DarkGray
}

Start-Sleep -Seconds 2

# Stop bridge
if ((TaskState $TASK_BRIDGE) -eq 'Running') {
    Stop-ScheduledTask -TaskName $TASK_BRIDGE
    Write-Host "  Bridge detenido." -ForegroundColor Yellow
} else {
    Write-Host "  Bridge no estaba corriendo." -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Servicios detenidos.' -ForegroundColor Green
