#!/usr/bin/env sh
# One command to run the lab on macOS and Linux. First run sets everything up.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
    echo "First run: creating a virtual environment and installing dependencies..."
    python3 -m venv .venv
    .venv/bin/python -m pip install --quiet --upgrade pip
    .venv/bin/python -m pip install --quiet -r requirements.txt
fi

exec .venv/bin/python -m lab "$@"
