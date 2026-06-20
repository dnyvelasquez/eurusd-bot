@echo off
REM Recreates the .venv from scratch using the current folder location.
REM Run this any time the project folder is moved/renamed, since venvs
REM hardcode absolute paths and break when the folder moves.

cd /d "%~dp0"

if exist .venv (
    echo Removing existing .venv...
    rmdir /s /q .venv
)

echo Creating venv at %cd%\.venv ...
python -m venv .venv

call .venv\Scripts\activate.bat
pip install -r requirements.txt

echo Done. Run start.bat to launch the bridge.
