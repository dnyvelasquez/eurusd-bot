$REPO_DIR = Split-Path -Parent $PSScriptRoot
$logFile  = "$REPO_DIR\logs\bot-$(Get-Date -Format 'yyyy-MM-dd').log"

Start-Sleep -Seconds 15  # Wait for bridge to be ready
Set-Location $REPO_DIR
node dist\main.js 2>&1 |
    ForEach-Object { $_.ToString() } |
    Out-File -FilePath $logFile -Append -Encoding utf8
