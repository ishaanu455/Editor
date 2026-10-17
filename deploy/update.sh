#!/usr/bin/env bash
# Server එකේ: ./deploy/update.sh  → git pull + deps + restart
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r backend/requirements.txt
sudo systemctl restart aegis-editor
echo "Updated ✔"
