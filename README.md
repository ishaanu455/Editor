<div align="center">

# AegisX Editor

**A fast, self-hosted web video editor built with FastAPI, FFmpeg and vanilla JavaScript.**

![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)
![Platform](https://img.shields.io/badge/Ubuntu-22.04%20%7C%2024.04-E95420?logo=ubuntu&logoColor=white)

</div>

---

## Overview

AegisX Editor is a lightweight, timeline-based video editor that runs entirely in the browser and renders on your own server. Edit with instant proxy previews, then export a final MP4 with FFmpeg. No accounts, no cloud dependency, no heavy front-end framework.

## Features

| Area | Capabilities |
| --- | --- |
| **Timeline** | Split, delete, undo / redo, magnetic snapping, zoom, grid overlay |
| **Video** | Crop with aspect-ratio presets or free crop, speed control (0.25x to 8x), rounded corners on the cropped video, clip transitions (flash, zoom whoosh, shake, dip to black) |
| **Canvas** | Original, 9:16, 16:9, 1:1, 4:5, 3:4, 4:3 or auto-fit to crop |
| **Text** | Custom fonts, bold / italic / underline, outline, alignment, colors, drag and resize directly on the preview, scrolling ticker text (left / right, speed, opacity, X / Y position) |
| **Images & videos** | PNG, JPG, WebP and video overlays with transparency, opacity, **free move** (even partly off-canvas) and **free resize** (corner + side handles, `Shift` keeps proportions), rounded corners, scrolling logos, timed overlays |
| **Shapes** | Rectangle (corner radius), circle / ellipse, triangle, diamond, pentagon, hexagon, star, heart, arrow, line — free resize, fill + stroke colors, opacity, timing |
| **Layers** | One stacking order for text, images, videos, emoji and shapes. The **Layers** tab shows what is in front / behind — drag to reorder (exports exactly as previewed) |
| **Audio** | SFX and music libraries, per-item volume, shared across projects. Overlay videos keep their own sound (own mute + volume); the main video's mute button does not affect them |
| **Effects** | Grain, vintage, dust and glitch layers on the timeline, intensity 1% to 150% |
| **Export** | 1080p, 720p or original size, fast or best-quality presets, one-click download |

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` | Split at playhead |
| `C` | Enter crop mode |
| `Delete` | Delete selected item |
| `Ctrl` + `Z` | Undo |
| `Ctrl` + `Shift` + `Z` or `Ctrl` + `Y` | Redo |
| `Alt` (hold) | Temporarily disable snapping (items snap to the canvas, to each other and to the main video's edges / center, with guide lines) |
| `Shift` (while resizing) | Keep proportions |
| Arrow keys | Nudge the selected text / image / shape (`Shift` = bigger step) |

---

## Quick Install

Run a single command on a fresh **Ubuntu** server:

```bash
curl -fsSL https://raw.githubusercontent.com/ishaanu455/Editor/main/deploy/install.sh | bash
```

The installer will:

1. Install system packages (FFmpeg, Python venv, Git, Nginx, apache2-utils)
2. Clone this repository to `/opt/aegis-editor`
3. Create a Python virtual environment and install dependencies
4. Register a `systemd` service that starts on boot and restarts automatically on failure
5. Configure Nginx on port 80 with password protection and a 2 GB upload limit
6. Open port 80 in UFW if the firewall is active

When it finishes, it prints the access URL and a generated password:

```
==> Done
  URL      : http://<server-ip>
  Username : admin
  Password : <generated>
```

> **Using a different branch?** Set `BRANCH=master` before `bash`:
> `curl -fsSL <url> | BRANCH=master bash`

### Installer options

Pass these as environment variables to customize the install.

| Variable | Default | Description |
| --- | --- | --- |
| `REPO` | `https://github.com/ishaanu455/Editor.git` | Git repository to clone |
| `BRANCH` | `main` | Branch to deploy |
| `APP_DIR` | `/opt/aegis-editor` | Install location |
| `PORT` | `8000` | Internal app port (bound to `127.0.0.1`) |
| `AUTH_USER` | `admin` | Login username |
| `AUTH_PASS` | random | Login password (generated if not set) |

Example:

```bash
curl -fsSL https://raw.githubusercontent.com/ishaanu455/Editor/main/deploy/install.sh \
  | AUTH_USER=me AUTH_PASS='a-strong-password' bash
```

---

## Manual Install

<details>
<summary>Step-by-step setup without the installer</summary>

```bash
# 1. System packages
sudo apt update
sudo apt install -y ffmpeg python3-venv git nginx apache2-utils

# 2. Get the code
sudo git clone https://github.com/ishaanu455/Editor.git /opt/aegis-editor
sudo chown -R $USER /opt/aegis-editor
cd /opt/aegis-editor

# 3. Python environment
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# 4. Service (edit User= in the file to match your account first)
sudo cp deploy/aegis-editor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aegis-editor
```

Nginx reverse proxy (`/etc/nginx/sites-available/aegis`):

```nginx
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 2g;

    auth_basic "AegisX";
    auth_basic_user_file /etc/nginx/.htpasswd-aegis;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
        proxy_request_buffering off;
    }
}
```

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-aegis admin
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/aegis /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

</details>

---

## Updating

Push your changes to GitHub, then on the server run either:

```bash
# Re-run the installer (idempotent, keeps your password)
curl -fsSL https://raw.githubusercontent.com/ishaanu455/Editor/main/deploy/install.sh | bash

# or use the bundled updater
cd /opt/aegis-editor && ./deploy/update.sh
```

Both pull the latest code, refresh dependencies and restart the service.

## Operations

| Task | Command |
| --- | --- |
| Service status | `systemctl status aegis-editor` |
| Live logs | `journalctl -u aegis-editor -f` |
| Restart | `sudo systemctl restart aegis-editor` |
| Stop | `sudo systemctl stop aegis-editor` |
| Change login password | `sudo htpasswd /etc/nginx/.htpasswd-aegis admin` |
| Back up user data | `tar czf backup.tgz -C /opt/aegis-editor data` |

### Data location

All projects, uploaded assets and fonts live in `/opt/aegis-editor/data/` and are intentionally excluded from Git. To migrate an existing setup, copy that folder to the new server and run `sudo chown -R $USER /opt/aegis-editor/data`.

---

## Security

AegisX Editor has no built-in user accounts. The installer protects it with HTTP Basic Auth through Nginx.

- Basic Auth sends credentials in clear text over plain HTTP. For anything beyond a private network, put the server behind HTTPS.
- **With a domain:** `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d your.domain`
- **Without a domain:** use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [Tailscale](https://tailscale.com/) for encrypted access.
- The app listens on `127.0.0.1` only. Nginx is the single public entry point.

## Local Development

```bash
git clone https://github.com/ishaanu455/Editor.git
cd Editor
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload
```

Open <http://127.0.0.1:8000>. FFmpeg must be available on your `PATH`.

## Project Structure

```
.
├── backend/
│   ├── main.py              # FastAPI app, FFmpeg pipeline, REST API
│   └── requirements.txt
├── frontend/
│   ├── index.html           # UI layout
│   ├── app.js               # Editor logic (timeline, preview, overlays)
│   └── style.css
├── deploy/
│   ├── install.sh           # One-command installer
│   ├── update.sh            # Pull, update dependencies, restart
│   └── aegis-editor.service # systemd unit (reference copy)
└── data/                    # Runtime data (ignored by Git)
```

## API Overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` / `GET` | `/api/projects` | Create and list projects |
| `GET` / `PUT` | `/api/projects/{id}/edit` | Load and save the edit state |
| `POST` / `GET` | `/api/projects/{id}/export` | Start an export and poll its progress |
| `GET` | `/api/projects/{id}/output.mp4` | Download the rendered video |
| `GET` / `POST` / `DELETE` | `/api/assets` | Image, SFX and music library |
| `GET` / `POST` / `DELETE` | `/api/fonts` | Custom font library |

## Requirements

- Ubuntu 22.04 or 24.04 (other Debian-based distributions should work)
- Python 3.10 or newer
- FFmpeg
- 2 GB RAM recommended (exports run one at a time to keep memory usage low)

## Troubleshooting

<details>
<summary><b>The page does not load</b></summary>

Check that the service is running with `systemctl status aegis-editor`. If it is, confirm Nginx is healthy with `sudo nginx -t`. On cloud providers, also allow inbound port 80 in the provider firewall or security group.

</details>

<details>
<summary><b>Service fails to start with a permission error</b></summary>

The `User=` value in `/etc/systemd/system/aegis-editor.service` must own `/opt/aegis-editor`. Fix it with `sudo chown -R $USER /opt/aegis-editor` and restart the service.

</details>

<details>
<summary><b>Uploads fail on large videos</b></summary>

Nginx limits upload size through `client_max_body_size`. The installer sets it to `2g`. Raise it in `/etc/nginx/sites-available/aegis` if needed, then reload Nginx.

</details>

<details>
<summary><b>An image overlay shows a solid background</b></summary>

Only images that contain real transparency stay transparent. A PNG with a baked-in black or white background is opaque and must be exported with a transparent background from your design tool first.

</details>
