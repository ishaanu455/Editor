#!/usr/bin/env bash
# AegisX Editor - one-command installer (Ubuntu)
#
#   curl -fsSL https://raw.githubusercontent.com/ishaanu455/Editor/main/deploy/install.sh | bash
#
# Re-run කරන්න ඕනම වෙලාවක (safe): update + restart වෙනවා.
# Optional env vars:  REPO=...  BRANCH=main  APP_DIR=/opt/aegis-editor  PORT=8000  AUTH_USER=admin  AUTH_PASS=...
set -euo pipefail

REPO="${REPO:-https://github.com/ishaanu455/Editor.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/aegis-editor}"
PORT="${PORT:-8000}"
AUTH_USER="${AUTH_USER:-admin}"
SVC="aegis-editor"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
RUN_USER="${SUDO_USER:-$(id -un)}"
AS_USER=""; [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != "root" ] && AS_USER="sudo -u $RUN_USER"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "1/5 Packages install කරනවා"
$SUDO apt-get update -qq
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg python3-venv git nginx apache2-utils curl

say "2/5 GitHub එකෙන් code ගන්නවා ($REPO)"
$SUDO install -d -o "$RUN_USER" -g "$RUN_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  $AS_USER git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  $AS_USER git -C "$APP_DIR" checkout -q "$BRANCH"
  $AS_USER git -C "$APP_DIR" pull --ff-only --quiet origin "$BRANCH"
else
  $AS_USER git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

say "3/5 Python venv + requirements"
[ -d "$APP_DIR/.venv" ] || $AS_USER python3 -m venv "$APP_DIR/.venv"
$AS_USER "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
$AS_USER "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
$AS_USER mkdir -p "$APP_DIR/data"

say "4/5 systemd service (auto start + auto restart)"
$SUDO tee "/etc/systemd/system/$SVC.service" >/dev/null <<EOF
[Unit]
Description=AegisX Editor
After=network.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SVC" >/dev/null 2>&1
$SUDO systemctl restart "$SVC"

say "5/5 Nginx (port 80) + password"
NEWPASS=""
if [ ! -f /etc/nginx/.htpasswd-aegis ]; then
  NEWPASS="${AUTH_PASS:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)}"
  $SUDO htpasswd -bc /etc/nginx/.htpasswd-aegis "$AUTH_USER" "$NEWPASS" >/dev/null 2>&1
fi
$SUDO tee /etc/nginx/sites-available/aegis >/dev/null <<EOF
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 2g;
    auth_basic "AegisX";
    auth_basic_user_file /etc/nginx/.htpasswd-aegis;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_read_timeout 600s;
        proxy_request_buffering off;
    }
}
EOF
$SUDO rm -f /etc/nginx/sites-enabled/default
$SUDO ln -sf /etc/nginx/sites-available/aegis /etc/nginx/sites-enabled/aegis
$SUDO nginx -t
$SUDO systemctl enable nginx >/dev/null 2>&1
$SUDO systemctl reload nginx || $SUDO systemctl restart nginx
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null
fi

IP="$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
say "Done ✔"
echo "  URL      : http://$IP"
if [ -n "$NEWPASS" ]; then
  echo "  Username : $AUTH_USER"
  echo "  Password : $NEWPASS   (මේක save කරගන්න)"
else
  echo "  Login    : කලින් හදපු username/password එකම"
fi
echo "  Status   : systemctl status $SVC"
echo "  Logs     : journalctl -u $SVC -f"
echo "  Update   : GitHub එකට push කරලා මේ command එකම ආයෙ run කරන්න (හෝ cd $APP_DIR && ./deploy/update.sh)"
