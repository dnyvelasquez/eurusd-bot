$REPO_DIR = Split-Path -Parent $PSScriptRoot
$logFile  = "$REPO_DIR\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log"
$PYTHON   = "$REPO_DIR\apps\mt5-bridge\.venv\Scripts\python.exe"

Set-Location "$REPO_DIR\apps\mt5-bridge"
& $PYTHON -m uvicorn app.main:app --host 127.0.0.1 --port 8001 2>&1 |
    ForEach-Object { $_.ToString() } |
    Out-File -FilePath $logFile -Append -Encoding utf8
