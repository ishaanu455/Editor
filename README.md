# AegisX Editor

Mini web video editor (FastAPI + FFmpeg + vanilla JS).

## Server setup (එක පාරයි)
```
sudo apt install -y ffmpeg python3-venv git
sudo git clone <repo-url> /opt/aegis-editor && sudo chown -R $USER /opt/aegis-editor
cd /opt/aegis-editor && python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
sudo cp deploy/aegis-editor.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aegis-editor
```
Nginx/Caddy වලින් 127.0.0.1:8000 reverse proxy කරන්න (`client_max_body_size 2g`).

## Update (පස්සේ හැම වෙලාවකම)
```
cd /opt/aegis-editor && ./deploy/update.sh
```

## Local test
```
pip install -r backend/requirements.txt && uvicorn backend.main:app --reload
```
