@echo off
rem One command to run the lab on Windows. First run sets everything up.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo First run: creating a virtual environment and installing dependencies...
    py -3 -m venv .venv 2>nul || python -m venv .venv || goto :nopython
    ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
    ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :failed
)

".venv\Scripts\python.exe" -m lab %*
exit /b %errorlevel%

:nopython
echo Python 3.11 or later is needed. Get it from https://www.python.org/downloads/
exit /b 1

:failed
echo Installing the dependencies failed. Check your connection and run this again.
exit /b 1
