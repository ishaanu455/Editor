import base64, json, os, re, shutil, struct, subprocess, threading, time, uuid
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data" / "projects"
FRONT = BASE / "frontend"
ASSETS = BASE / "data" / "assets"
FONTS = BASE / "data" / "fonts"
EMOJI = BASE / "data" / "emoji"   # Apple style emoji PNGs (deploy/get-emoji.py)
DATA.mkdir(parents=True, exist_ok=True)
ASSETS.mkdir(parents=True, exist_ok=True)
FONTS.mkdir(parents=True, exist_ok=True)
EMOJI.mkdir(parents=True, exist_ok=True)
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

app = FastAPI()
ffmpeg_lock = threading.Lock()  # 2GB RAM: එකවර ffmpeg job එකක් විතරයි
JOBS = {}  # export job state (memory)
META_LOCK = threading.Lock()  # meta.json read-modify-write (rename vs proxy status)


# ---------- helpers ----------
def pdir(pid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{10}", pid):
        raise HTTPException(400, "bad id")
    d = DATA / pid
    if not d.exists():
        raise HTTPException(404, "not found")
    return d


def read_meta(d: Path) -> dict:
    return json.loads((d / "meta.json").read_text())


def write_meta(d: Path, m: dict):
    (d / "meta.json").write_text(json.dumps(m))


def probe(src: Path) -> dict:
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(src)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stderr
    dm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    dur = int(dm[1]) * 3600 + int(dm[2]) * 60 + float(dm[3]) if dm else 0
    sm = re.search(r"Video:.*?\b(\d{2,5})x(\d{2,5})\b", out)
    w, h = (int(sm[1]), int(sm[2])) if sm else (None, None)
    rm = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees", out)
    if rm and w and h and round(abs(float(rm[1]))) % 180 == 90:
        w, h = h, w
    return {"duration": dur, "width": w, "height": h, "has_audio": "Audio:" in out}


def make_proxy(pid: str):
    d = DATA / pid
    m = read_meta(d)
    ok = False
    with ffmpeg_lock:
        try:
            r = subprocess.run(
                [FFMPEG, "-y", "-i", str(d / m["original"]),
                 "-vf", "scale='min(480,iw)':-2", "-c:v", "libx264",
                 "-preset", "ultrafast", "-crf", "28", "-g", "15",
                 "-c:a", "aac", "-b:a", "96k", "-threads", "2",
                 "-movflags", "+faststart", str(d / "proxy.mp4")],
                capture_output=True)
            ok = r.returncode == 0
        except OSError as e:
            print("ffmpeg error:", e)
    if ok:
        make_thumb(d)
    with META_LOCK:   # rename කරලා තියෙන්න පුළුවන් -> අලුතින් read කරලා status විතරක් දානවා
        try:
            m = read_meta(d)
            m["status"] = "ready" if ok else "error"
            write_meta(d, m)
        except (OSError, ValueError):   # project එක delete කරලා
            pass


def make_thumb(d: Path):
    """project list එකට thumbnail (proxy එකේ පළමු frame එකකින්)"""
    src, out = d / "proxy.mp4", d / "thumb.jpg"
    if out.exists():
        return out
    if not src.exists():
        return None
    try:
        subprocess.run([FFMPEG, "-y", "-ss", "0.5", "-i", str(src), "-frames:v", "1",
                        "-vf", "scale='min(360,iw)':-2", "-q:v", "4", str(out)],
                       capture_output=True, timeout=30)
        if not out.exists() or out.stat().st_size == 0:   # video එක 0.5s ට අඩු නම් frame 0
            subprocess.run([FFMPEG, "-y", "-i", str(src), "-frames:v", "1",
                            "-vf", "scale='min(360,iw)':-2", "-q:v", "4", str(out)],
                           capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return out if out.exists() and out.stat().st_size else None


# ---------- projects ----------
PROJ_IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif", ".heic"}
IMG_PROJECT_MAX = 300   # image project එකක source length (තත්පර) - timeline එකේ මෙතනට වඩා දිග කරන්න බෑ (5 min)
IMG_PROJECT_DEFAULT = 5  # මුලින් timeline එකේ පේන දිග (තත්පර) - trim handle එකෙන් දිග කරන්න පුළුවන්


def image_to_video(img: Path, out: Path) -> bool:
    """image එකක් -> දිග still video එකක් (clip එක timeline එකේ දිග කරන්න පුළුවන් වෙන්න)"""
    with ffmpeg_lock:
        try:
            r = subprocess.run(
                [FFMPEG, "-y", "-loop", "1", "-framerate", "5", "-i", str(img),
                 "-t", str(IMG_PROJECT_MAX),
                 "-vf", "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,"
                        "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
                 "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-crf", "20",
                 "-g", "50", "-an", "-movflags", "+faststart", str(out)],
                capture_output=True)
            return r.returncode == 0 and out.exists() and out.stat().st_size > 0
        except OSError as e:
            print("ffmpeg error:", e)
            return False


@app.post("/api/projects")
async def create(bg: BackgroundTasks, file: UploadFile = File(...)):
    pid = uuid.uuid4().hex[:10]
    d = DATA / pid
    d.mkdir(parents=True)
    ext = Path(file.filename or "v.mp4").suffix.lower() or ".mp4"
    is_img = ext in PROJ_IMG_EXT or (file.content_type or "").startswith("image/")
    src = d / (f"upload_img{ext if ext in PROJ_IMG_EXT else '.png'}" if is_img else f"original{ext}")
    with src.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    extra = {}
    if is_img:
        vid = d / "original.mp4"
        if not image_to_video(src, vid):
            shutil.rmtree(d, ignore_errors=True)
            raise HTTPException(400, "මේ image එක read කරන්න බෑ (png/jpg/webp try කරන්න)")
        src.unlink(missing_ok=True)
        src = vid
        extra = {"is_image": True, "default_len": IMG_PROJECT_DEFAULT}
    m = {"id": pid, "name": file.filename, "original": src.name,
         "status": "processing", "created_at": time.time(), **probe(src), **extra}
    write_meta(d, m)
    bg.add_task(make_proxy, pid)
    return m


def edited_len(clips):
    try:
        return sum((c["end"] - c["start"]) / (c.get("speed") or 1) for c in clips)
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return 0


@app.get("/api/projects")
def list_projects():
    """home screen: හැම project එකක්ම, අන්තිමට edit කරපු එක උඩින්"""
    out = []
    for d in DATA.iterdir():
        if not (d.is_dir() and re.fullmatch(r"[a-f0-9]{10}", d.name) and (d / "meta.json").exists()):
            continue
        try:
            m = read_meta(d)
            orig = d / m.get("original", "")
            created = m.get("created_at") or (orig.stat().st_mtime if orig.exists() else d.stat().st_mtime)
            ep, ed = d / "edit.json", {}
            if ep.exists():
                try:
                    ed = json.loads(ep.read_text())
                except ValueError:
                    pass
            updated = max(created, ep.stat().st_mtime) if ep.exists() else created
            clips = ed.get("clips") or []
            out.append({"id": m["id"], "name": m.get("name") or m["id"], "status": m.get("status"),
                        "duration": m.get("duration", 0), "width": m.get("width"), "height": m.get("height"),
                        "clips": len(clips), "edited_duration": edited_len(clips) if clips else m.get("default_len") or m.get("duration", 0),
                        "sfx": len(ed.get("sfx") or []), "music": bool(ed.get("music")),
                        "created": created, "updated": updated,
                        "exported": (d / "output.mp4").exists(),
                        "thumb": (d / "proxy.mp4").exists()})
        except (OSError, ValueError, KeyError):
            continue
    out.sort(key=lambda x: x["updated"], reverse=True)
    return out


@app.put("/api/projects/{pid}/name")
async def rename_project(pid: str, request: Request):
    d = pdir(pid)
    name = str((await request.json()).get("name", "")).strip()[:100]
    if not name:
        raise HTTPException(400, "name හිස්")
    with META_LOCK:
        m = read_meta(d)
        m["name"] = name
        write_meta(d, m)
    return m


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    d = pdir(pid)
    if JOBS.get(pid, {}).get("status") in ("queued", "running"):
        raise HTTPException(409, "export වෙමින් පවතී")
    shutil.rmtree(d, ignore_errors=True)
    JOBS.pop(pid, None)
    return {"ok": True}


@app.get("/api/projects/{pid}/thumb.jpg")
def get_thumb(pid: str):
    d = pdir(pid)
    p = make_thumb(d)
    if not p:
        raise HTTPException(404, "no thumb")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


# UI state (playhead, timeline zoom, export settings) -> ui.json
# edit.json වලින් වෙනම: project එක open කරන එකෙන් "last edited" වෙලාව වෙනස් වෙන්නේ නෑ
@app.get("/api/projects/{pid}/ui")
def get_ui(pid: str):
    p = pdir(pid) / "ui.json"
    try:
        return json.loads(p.read_text()) if p.exists() else {}
    except ValueError:
        return {}


@app.put("/api/projects/{pid}/ui")
async def put_ui(pid: str, request: Request):
    b = await request.json()
    b = b if isinstance(b, dict) else {}
    ui = {"head": clamp(b.get("head"), 0, 36000, 0), "pps": clamp(b.get("pps"), 10, 200, 40),
          "res": str(b.get("res")) if str(b.get("res")) in ("0", "720", "1080", "1440", "2160", "hd") else "hd",
          "preset": b.get("preset") if b.get("preset") in ("veryfast", "medium") else "veryfast"}
    (pdir(pid) / "ui.json").write_text(json.dumps(ui))
    return {"ok": True}


def migrate_image_project(pid: str):
    """පරණ image project (තත්පර 0.04ක source එකක්) -> දිග still video එකක් (timeline එකේ දිග කරන්න පුළුවන්)"""
    d = DATA / pid
    ok = False
    try:
        m = read_meta(d)
        orig = d / m["original"]
        img = orig
        if orig.suffix.lower() not in PROJ_IMG_EXT:   # video එකක් නම් පළමු frame එක ගන්නවා
            img = d / "frame0.png"
            subprocess.run([FFMPEG, "-y", "-i", str(orig), "-frames:v", "1", str(img)], capture_output=True)
        out = d / "original_long.mp4"
        if img.exists() and image_to_video(img, out):
            for x in (d / "proxy.mp4", d / "thumb.jpg"):
                x.unlink(missing_ok=True)
            if orig != out:
                orig.unlink(missing_ok=True)
            final = d / "original.mp4"
            out.replace(final)
            with META_LOCK:
                m = read_meta(d)
                m.update({"original": final.name, "is_image": True, "default_len": IMG_PROJECT_DEFAULT, **probe(final)})
                write_meta(d, m)
            # edit.json එකේ තත්පර 0.04ක clip එක -> default දිගට
            ep = d / "edit.json"
            if ep.exists():
                try:
                    ed = json.loads(ep.read_text())
                    cl = ed.get("clips") or []
                    if len(cl) == 1 and float(cl[0].get("end", 0)) - float(cl[0].get("start", 0)) < 0.5:
                        cl[0]["start"], cl[0]["end"] = 0, IMG_PROJECT_DEFAULT
                        ep.write_text(json.dumps(ed))
                except (ValueError, TypeError):
                    pass
            ok = True
    except (OSError, ValueError, KeyError) as e:
        print("migrate error:", e)
    if ok:
        make_proxy(pid)
    else:
        with META_LOCK:
            try:
                m = read_meta(d); m["status"] = "ready"; m["migrate_failed"] = True; write_meta(d, m)
            except (OSError, ValueError):
                pass


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    d = pdir(pid)
    m = read_meta(d)
    # පරණ image project (fix එකට කලින් හදපු) -> auto upgrade
    if (m.get("status") == "ready" and not m.get("is_image") and not m.get("migrate_failed")
            and (m.get("duration") or 0) < 1
            and (Path(m.get("original", "")).suffix.lower() in PROJ_IMG_EXT
                 or Path(m.get("name") or "").suffix.lower() in PROJ_IMG_EXT)):
        with META_LOCK:
            m["status"] = "processing"; write_meta(d, m)
        threading.Thread(target=migrate_image_project, args=(pid,), daemon=True).start()
    return m


@app.get("/api/projects/{pid}/proxy.mp4")
def get_proxy(pid: str):
    p = pdir(pid) / "proxy.mp4"
    if not p.exists():
        raise HTTPException(404, "proxy not ready")
    return FileResponse(p, media_type="video/mp4")


@app.get("/api/projects/{pid}/edit")
def get_edit(pid: str):
    p = pdir(pid) / "edit.json"
    return json.loads(p.read_text()) if p.exists() else {}


@app.put("/api/projects/{pid}/edit")
async def put_edit(pid: str, request: Request):
    (pdir(pid) / "edit.json").write_text(json.dumps(await request.json()))
    return {"ok": True}


# ---------- emoji library (Apple style PNG) ----------
EMOJI_RE = re.compile(r"[0-9a-f]{2,8}(?:-[0-9a-f]{2,8}){0,10}")


def emoji_path(code):
    if not isinstance(code, str) or not EMOJI_RE.fullmatch(code):
        return None
    p = EMOJI / f"{code}.png"
    return p if p.is_file() else None


@app.get("/api/emoji")
def emoji_index():
    ip = EMOJI / "index.json"
    if not ip.exists():
        return {"ready": False, "cats": [], "items": []}
    try:
        return {"ready": True, **json.loads(ip.read_text(encoding="utf-8"))}
    except ValueError:
        return {"ready": False, "cats": [], "items": []}


EMOJI_JOB = {"status": "idle", "done": 0, "total": 0, "error": ""}
EMOJI_VER = "15.1.2"
EMOJI_CDN = os.environ.get("EMOJI_CDN", "https://cdn.jsdelivr.net")   # (test වලට වෙනස් කරන්න පුළුවන්)


def _http_get(url, timeout=30):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "aegisx-editor"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def emoji_install_job():
    """Apple style emoji PNG library එක download කරනවා (button එකෙන් / deploy/get-emoji.py එකෙන්)"""
    from concurrent.futures import ThreadPoolExecutor
    J = EMOJI_JOB
    J.update(status="running", done=0, total=0, error="")
    try:
        data = json.loads(_http_get(f"{EMOJI_CDN}/npm/emoji-datasource-apple@{EMOJI_VER}/emoji.json", 120))
        data = [d for d in data if d.get("has_img_apple") and d.get("image")]
        data.sort(key=lambda d: d.get("sort_order", 0))
        J["total"] = len(data)
        sources = [f"{EMOJI_CDN}/gh/iamcal/emoji-data@v{EMOJI_VER}/img-apple-160/",
                   f"{EMOJI_CDN}/gh/iamcal/emoji-data@master/img-apple-160/",
                   f"{EMOJI_CDN}/npm/emoji-datasource-apple@{EMOJI_VER}/img/apple/64/"]

        def fetch(d):
            stem = d["image"][:-4].lower()
            dst = EMOJI / f"{stem}.png"
            ok = dst.exists() and dst.stat().st_size > 100
            if not ok:
                for base in sources:
                    try:
                        b = _http_get(base + d["image"])
                        if b[:4] == b"\x89PNG":
                            dst.write_bytes(b)
                            ok = True
                            break
                    except OSError:
                        continue
            J["done"] += 1
            return stem, ok

        with ThreadPoolExecutor(8) as ex:
            res = list(ex.map(fetch, data))
        okset = {st for st, ok in res if ok}
        items, cats = [], []
        for d in data:
            stem = d["image"][:-4].lower()
            if stem not in okset:
                continue
            c = d.get("category") or "Other"
            if c not in cats:
                cats.append(c)
            items.append({"u": stem, "n": (d.get("name") or d["short_name"]).lower(), "c": c,
                          "k": " ".join(d.get("short_names") or [])})
        if not items:
            raise RuntimeError("emoji එකක්වත් download වුනේ නෑ (internet / jsDelivr)")
        (EMOJI / "index.json").write_text(json.dumps({"cats": cats, "items": items}, ensure_ascii=False), encoding="utf-8")
        J["status"] = "done"
    except Exception as e:   # noqa
        J.update(status="error", error=str(e)[:200])


@app.post("/api/emoji/install")
def emoji_install():
    if EMOJI_JOB["status"] != "running":
        EMOJI_JOB.update(status="running", done=0, total=0, error="")
        threading.Thread(target=emoji_install_job, daemon=True).start()
    return EMOJI_JOB


@app.get("/api/emoji/install")
def emoji_install_status():
    return EMOJI_JOB


@app.get("/api/emoji/{code}.png")
def emoji_file(code: str):
    p = emoji_path(code)
    if not p:
        raise HTTPException(404, "emoji not found")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "max-age=604800"})


# ---------- audio assets (SFX / music library, projects අතර share) ----------
AUDIO_EXT = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus"}
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}   # asset library එකේ තියෙන්න පුළුවන් (stored) formats
IMG_IN = IMG_EXT | {".gif", ".bmp", ".tif", ".tiff", ".avif", ".heic"}   # upload කරන්න පුළුවන් formats (PNG එකකට convert වෙනවා)


def asset_path(aid):
    if not isinstance(aid, str) or not re.fullmatch(r"[a-f0-9]{10}", aid):
        return None
    mp = ASSETS / f"{aid}.json"
    if not mp.exists():
        return None
    p = ASSETS / f"{aid}{json.loads(mp.read_text())['ext']}"
    return p if p.exists() else None


@app.get("/api/assets")
def list_assets():
    ms = [json.loads(p.read_text()) for p in sorted(ASSETS.glob("*.json"), key=lambda x: x.stat().st_mtime)]
    return ms


@app.post("/api/assets")
async def upload_asset(file: UploadFile = File(...), kind: str = Form("sfx")):
    ext = Path(file.filename or "").suffix.lower()
    if kind == "image":
        if ext not in IMG_IN:
            raise HTTPException(400, "image file විතරයි (png/jpg/webp/gif/bmp/tiff)")
    elif ext not in AUDIO_EXT:
        raise HTTPException(400, "audio file විතරයි (mp3/wav/ogg/m4a/aac/flac)")
    aid = uuid.uuid4().hex[:10]
    path = ASSETS / (f"{aid}_raw{ext}" if kind == "image" else f"{aid}{ext}")   # image: raw -> PNG convert (same name clash නොවෙන්න)
    size = 0
    with path.open("wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if kind == "image" and size > 25 << 20:
                f.close()
                path.unlink(missing_ok=True)
                raise HTTPException(400, "image ලොකු වැඩියි (25MB max)")
            f.write(chunk)
    if kind == "image":
        # ඕනෑම image format එකක් -> PNG (frame 1, EXIF rotate සහිතව, උපරිම 2048px) : preview + export දෙකටම එකම file එක
        out = ASSETS / f"{aid}.png"
        try:
            r = subprocess.run([FFMPEG, "-y", "-i", str(path), "-frames:v", "1", "-vf",
                                "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
                                "-pix_fmt", "rgba", str(out)], capture_output=True, timeout=90)
        except (OSError, subprocess.TimeoutExpired):
            r = None
        if path != out:
            path.unlink(missing_ok=True)
        if r is None or r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            out.unlink(missing_ok=True)
            raise HTTPException(400, "මේ image එක read කරන්න බෑ (png/jpg/webp try කරන්න)")
        path, ext = out, ".png"
    pr = probe(path)
    m = {"id": aid, "name": Path(file.filename).stem[:60], "kind": kind if kind in ("sfx", "music", "image") else "sfx",
         "ext": ext, "duration": pr["duration"]}
    if kind == "image":
        m["w"], m["h"] = pr["width"], pr["height"]
    (ASSETS / f"{aid}.json").write_text(json.dumps(m))
    return m


@app.get("/api/assets/{aid}/file")
def asset_file(aid: str):
    p = asset_path(aid)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p)


@app.delete("/api/assets/{aid}")
def delete_asset(aid: str):
    p = asset_path(aid)
    if p:
        p.unlink()
        (ASSETS / f"{aid}.json").unlink(missing_ok=True)
    return {"ok": True}


# ---------- fonts (user upload, projects අතර share; browser එකේ text render කරන්න) ----------
FONT_EXT = {".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2"}


def font_path(fid):
    if not isinstance(fid, str) or not re.fullmatch(r"[a-f0-9]{10}", fid):
        return None
    mp = FONTS / f"{fid}.json"
    if not mp.exists():
        return None
    p = FONTS / f"{fid}{json.loads(mp.read_text())['ext']}"
    return p if p.exists() else None


@app.get("/api/fonts")
def list_fonts():
    return [json.loads(p.read_text()) for p in sorted(FONTS.glob("*.json"), key=lambda x: x.stat().st_mtime)]


@app.post("/api/fonts")
async def upload_font(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in FONT_EXT:
        raise HTTPException(400, "font file විතරයි (ttf/otf/woff/woff2)")
    fid = uuid.uuid4().hex[:10]
    path = FONTS / f"{fid}{ext}"
    size = 0
    with path.open("wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > 30 << 20:
                f.close()
                path.unlink(missing_ok=True)
                raise HTTPException(400, "font file ලොකු වැඩියි (30MB max)")
            f.write(chunk)
    m = {"id": fid, "name": Path(file.filename).stem[:60], "ext": ext}
    (FONTS / f"{fid}.json").write_text(json.dumps(m))
    return m


@app.get("/api/fonts/{fid}/file")
def font_file(fid: str):
    p = font_path(fid)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type=FONT_EXT[p.suffix], headers={"Cache-Control": "max-age=86400"})


@app.delete("/api/fonts/{fid}")
def delete_font(fid: str):
    p = font_path(fid)
    if p:
        p.unlink()
        (FONTS / f"{fid}.json").unlink(missing_ok=True)
    return {"ok": True}


# ---------- export ----------
def clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


TR_TYPES = {"flash", "zoom", "zoomflash", "shake", "black"}
TR_COLOR = {"flash": "white", "zoomflash": "white", "black": "black"}


def clean_tr(t):
    t = t if isinstance(t, dict) else {}
    return {"type": t.get("type") if t.get("type") in TR_TYPES else "none",
            "dur": clamp(t.get("dur"), 0.1, 1.2, 0.4),
            "snd": t.get("snd") if asset_path(t.get("snd")) else None,
            "sv": clamp(t.get("sv"), 0, 3, 1)}


def clean_crop(c):
    """crop box (0..1, source frame එකට සාපේක්ෂව). full frame නම් None"""
    if not isinstance(c, dict):
        return None
    w = clamp(c.get("w"), 0.05, 1, 1)
    h = clamp(c.get("h"), 0.05, 1, 1)
    x = clamp(c.get("x"), 0, 1 - w, 0)
    y = clamp(c.get("y"), 0, 1 - h, 0)
    if w > 0.999 and h > 0.999:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def clean_canvas(k):
    """output canvas ratio: auto (1st clip crop ratio) | orig | 'a:b'"""
    if k in ("auto", "orig"):
        return k
    if isinstance(k, str) and re.fullmatch(r"\d{1,2}:\d{1,2}", k) and all(int(x) for x in k.split(":")):
        return k
    return "auto"


def canvas_dims(canvas, clips, sw, sh):
    if canvas == "auto":
        cr = clips[0].get("crop")
        return (max(2, round(cr["w"] * sw)), max(2, round(cr["h"] * sh))) if cr else (sw, sh)
    if canvas == "orig":
        return sw, sh
    a, b = (int(x) for x in canvas.split(":"))
    r = a / b
    return (sw, round(sw / r)) if r > sw / sh else (round(sh * r), sh)


def clip_len(c):
    return (c["end"] - c["start"]) / c["speed"]


def tr_half(clips, i):
    """transition window එකෙන් භාගයක් (cut එකට කලින් / පස්සේ)"""
    return min(clips[i]["tr"]["dur"] / 2, clip_len(clips[i - 1]) / 2, clip_len(clips[i]) / 2)


def transition_sfx(clips):
    out, off = [], 0.0
    for i, c in enumerate(clips):
        if i > 0 and c["tr"]["type"] != "none" and c["tr"]["snd"]:
            out.append({"asset": c["tr"]["snd"], "t": max(0.0, off - tr_half(clips, i)), "vol": c["tr"]["sv"]})
        off += clip_len(c)
    return out


def sanitize(raw, dur):
    out = []
    for c in raw or []:
        try:
            s = max(0.0, float(c["start"]))
            e = float(c["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if dur:
            e = min(e, dur)
        if e - s < 0.04:
            continue
        out.append({"start": s, "end": e,
                    "speed": clamp(c.get("speed"), 0.25, 8, 1),
                    "zoom": clamp(c.get("zoom"), 1, 4, 1),
                    "zx": clamp(c.get("zx"), 0, 1, 0.5),
                    "zy": clamp(c.get("zy"), 0, 1, 0.5),
                    "crop": clean_crop(c.get("crop")),
                    "tr": clean_tr(c.get("tr"))})
    return out


def sanitize_audio(sfx_raw, music_raw):
    sfx = []
    for x in (sfx_raw or [])[:60]:
        if isinstance(x, dict) and asset_path(x.get("asset")):
            sfx.append({"id": str(x.get("id", ""))[:16], "asset": x["asset"],
                        "t": clamp(x.get("t"), 0, 36000, 0), "vol": clamp(x.get("vol"), 0, 3, 1)})
    music = None
    if isinstance(music_raw, dict) and asset_path(music_raw.get("asset")):
        music = {"asset": music_raw["asset"], "vol": clamp(music_raw.get("vol"), 0, 2, 0.3),
                 "fade": clamp(music_raw.get("fade"), 0, 10, 1.5)}
    return sfx, music


def sanitize_texts(raw, d: Path):
    """browser එකේ render කරපු text PNG (sinhala shaping + user fonts එක්ක) -> temp files + overlay params"""
    out = []
    for t in (raw or [])[:40]:
        if not isinstance(t, dict):
            continue
        png = t.get("png")
        if not isinstance(png, str) or not png.startswith("data:image/png;base64,"):
            continue
        try:
            data = base64.b64decode(png.split(",", 1)[1], validate=True)
        except ValueError:
            continue
        if len(data) > 12 << 20 or not data.startswith(b"\x89PNG"):
            continue
        k = len(out)
        path = d / f"txt_{k}.png"
        path.write_bytes(data)
        s0 = clamp(t.get("start"), 0, 36000, 0)
        out.append({"path": path, "pw": struct.unpack(">I", data[16:20])[0] if len(data) > 24 else 0,
                    "wf": clamp(t.get("wf"), 0.001, 4, 0.3),
                    "x": clamp(t.get("x"), 0, 1, 0.5), "y": clamp(t.get("y"), 0, 1, 0.5),
                    "op": clamp(t.get("op"), 0, 1, 1),
                    "start": s0, "end": max(s0 + 0.05, clamp(t.get("end"), 0, 36000, s0 + 3))})
    return out


def sanitize_imgs(raw):
    """image overlays (asset library එකේ image) -> file path + position / size / opacity / time"""
    out = []
    for x in (raw or [])[:60]:
        if not isinstance(x, dict):
            continue
        if x.get("emoji"):
            p = emoji_path(x.get("emoji"))
            if not p:
                continue
        else:
            p = asset_path(x.get("asset"))
            if not p or p.suffix.lower() not in IMG_EXT:
                continue
        s0 = clamp(x.get("start"), 0, 36000, 0)
        d = clamp(x.get("dur"), 0.05, 36000, 3)
        out.append({"path": p, "w": clamp(x.get("w"), 0.01, 4, 0.4),
                    "x": clamp(x.get("x"), 0, 1, 0.5), "y": clamp(x.get("y"), 0, 1, 0.5),
                    "op": clamp(x.get("op"), 0, 1, 1), "start": s0, "end": s0 + d})
    return out


FX_TYPES = {"grain", "vintage", "dust", "glitch"}


def sanitize_fxs(raw):
    """timeline FX items (grain / vintage / dust / glitch) -> start/end/amt"""
    out = []
    for x in (raw or [])[:60]:
        if not isinstance(x, dict) or x.get("type") not in FX_TYPES:
            continue
        s0 = clamp(x.get("start"), 0, 36000, 0)
        d = clamp(x.get("dur"), 0.1, 36000, 3)
        out.append({"type": x["type"], "start": s0, "end": s0 + d, "amt": clamp(x.get("amt"), 0.05, 1, 0.6)})
    return out


def hx(z):
    """ffmpeg expression: pseudo-random 0..1 (frontend preview එකේ hh() එකම formula එක)"""
    return f"mod(abs(sin({z})*43758.5453),1)"


def build_fx(vin, fxs, ow, oh, total):
    """concat කළ video ([v]) උඩට FX chain. returns (graph, final label)"""
    ch, cur = [], vin
    for i, f in enumerate(fxs):
        a = f["amt"]
        en = f"between(t,{f['start']:.3f},{f['end']:.3f})"
        out = f"[fx{i}]"
        if f["type"] == "grain":
            c0, c1 = round(a * 55), round(a * 20)
            ch.append(f"{cur}noise=c0s={c0}:c0f=t+u:c1s={c1}:c1f=t+u:c2s={c1}:c2f=t+u:enable='{en}'{out}")
        elif f["type"] == "vintage":
            ch.append(f"{cur}split[va{i}][vb{i}]")
            # warm sepia-ish tone + faded blacks + soft focus + vignette (blend opacity = intensity)
            ch.append(f"[vb{i}]format=gbrp,colorchannelmixer=rr=.62:rg=.50:rb=.10:gr=.24:gg=.60:gb=.10:br=.16:bg=.34:bb=.34,"
                      f"curves=all='0/0.08 0.25/0.28 0.75/0.77 1/0.91',eq=contrast=1.08:saturation=0.9,"
                      f"gblur=sigma=0.7,vignette=angle=PI/3.5,format=yuv420p[vc{i}]")
            ch.append(f"[va{i}][vc{i}]blend=c0_mode=normal:c0_opacity=1:c1_mode=normal:c2_mode=normal:"
                      f"all_opacity={a:.3f}:enable='{en}'{out}")
        elif f["type"] == "dust":
            d = f"{total:.3f}"
            w4, h4 = max(2, ow // 4), max(2, oh // 4)
            # සුදු දූවිලි (screen), කළු දූවිලි (multiply), සිරස් scratches (screen) -- සියල්ල අඩු resolution එකෙන් හදලා scale කරනවා
            ch.append(f"color=c=black:s={w4}x{h4}:r=12:d={d},format=yuv420p,"
                      f"geq=lum='if(gt(random(0),0.9993),255,0)':cb=128:cr=128,scale={ow}:{oh}:flags=bicubic,fps=30,format=yuv420p[dw{i}]")
            ch.append(f"color=c=white:s={w4}x{h4}:r=12:d={d},format=yuv420p,"
                      f"geq=lum='if(gt(random(1),0.9994),0,255)':cb=128:cr=128,scale={ow}:{oh}:flags=bicubic,fps=30,format=yuv420p[dk{i}]")
            h1 = hx("X*12.9898+floor(T*10)*78.233")
            h2 = hx("X*4.1414+floor(T*10)*9.123")
            ch.append(f"color=c=black:s={max(2, ow // 2)}x96:r=10:d={d},format=yuv420p,"
                      f"geq=lum='if(gt({h1},0.996),if(lt(abs(Y/H-{h2}),0.35),190,0),0)':cb=128:cr=128,"
                      f"scale={ow}:{oh}:flags=neighbor,fps=30,format=yuv420p[sc{i}]")
            ch.append(f"{cur}[dw{i}]blend=c0_mode=screen:c0_opacity={a:.3f}:c1_expr=A:c2_expr=A:enable='{en}'[da{i}]")
            ch.append(f"[da{i}][dk{i}]blend=c0_mode=multiply:c0_opacity={a:.3f}:c1_expr=A:c2_expr=A:enable='{en}'[db{i}]")
            ch.append(f"[db{i}][sc{i}]blend=c0_mode=screen:c0_opacity={a:.3f}:c1_expr=A:c2_expr=A:enable='{en}'{out}")
        else:   # glitch: random bursts (8Hz grid) -- RGB split + horizontal slice shift
            k = "floor(t*8)"
            en = f"between(t,{f['start']:.3f},{f['end']:.3f})*lt({hx(k + '*91.7')},{0.22 + 0.4 * a:.3f})"
            r = max(1, round((3 + 14 * a) * ow / 1080))
            b1, b2 = max(2, round(oh * 0.07)), max(2, round(oh * 0.035))
            y1, y2 = hx(k + "*7.31"), hx(k + "*11.9")
            dx1 = f"({hx(k + '*3.17')}-0.5)*2*{0.15 * a:.4f}*main_w"
            dx2 = f"({hx(k + '*5.53')}-0.5)*2*{0.10 * a:.4f}*main_w"
            ch.append(f"{cur}format=gbrp,rgbashift=rh=-{r}:bh={r}:enable='{en}',format=yuv420p,split=3[g0{i}][g1{i}][g2{i}]")
            ch.append(f"[g1{i}]crop=iw:{b1}:0:'(ih-{b1})*{y1}'[gb1{i}]")
            ch.append(f"[g2{i}]crop=iw:{b2}:0:'(ih-{b2})*{y2}'[gb2{i}]")
            ch.append(f"[g0{i}][gb1{i}]overlay=x='{dx1}':y='(main_h-overlay_h)*{y1}':enable='{en}'[go{i}]")
            ch.append(f"[go{i}][gb2{i}]overlay=x='{dx2}':y='(main_h-overlay_h)*{y2}':enable='{en}'{out}")
        cur = out
    return ";".join(ch), cur


def atempo(s: float) -> str:
    parts = []
    while s < 0.5:
        parts.append(0.5)
        s /= 0.5
    parts.append(s)
    return ",".join(f"atempo={p:.4f}" for p in parts)


def build_graph(clips, ow, oh, has_audio, sfx, music, total, sw=None, sh=None, texts=None, tbase=0, fxs=None, imgs=None, ibase=0):
    chains, tags, n = [], "", len(clips)
    T = "(on/30)"
    for i, c in enumerate(clips):
        L = clip_len(c)
        v = (f"[0:v]trim=start={c['start']:.3f}:end={c['end']:.3f},"
             f"setpts=(PTS-STARTPTS)/{c['speed']:.4f}")
        cr = c.get("crop")
        if cr:   # 1) user crop box
            v += (f",crop=iw*{cr['w']:.5f}:ih*{cr['h']:.5f}:"
                  f"iw*{cr['x']:.5f}:ih*{cr['y']:.5f}")
        if c["zoom"] > 1.001:   # 2) zoom (crop කළ frame එක ඇතුළේ)
            z = c["zoom"]
            v += (f",crop=iw/{z:.4f}:ih/{z:.4f}:"
                  f"(iw-ow)*{c['zx']:.4f}:(ih-oh)*{c['zy']:.4f}")
        fw, fh = (cr["w"], cr["h"]) if cr else (1.0, 1.0)
        frame_r = (fw * (sw or ow)) / (fh * (sh or oh))   # crop+zoom පස්සේ frame ratio (zoom එකෙන් වෙනස් වෙන්නේ නෑ)
        if abs(frame_r / (ow / oh) - 1) > 0.005:
            # frame ratio එක canvas ratio එකට වෙනස් -> canvas එකට fit කරලා කළු bars (CapCut වගේ)
            v += (f",scale={ow}:{oh}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos"
                  f",pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:black,fps=30")
        else:
            v += f",scale={ow}:{oh}:flags=lanczos,fps=30"
        # transition sides: B = cut එකට පස්සේ (clip මුල), A = cut එකට කලින් (clip අග)
        B = (clips[i]["tr"]["type"], tr_half(clips, i)) if i > 0 and clips[i]["tr"]["type"] != "none" else None
        A = (clips[i + 1]["tr"]["type"], tr_half(clips, i + 1)) if i < n - 1 and clips[i + 1]["tr"]["type"] != "none" else None
        zt, st = [], []
        for side, ty, h in [("A", *A)] if A else []:
            term = f"if(gt({T},{L - h:.4f}),pow(({T}-{L - h:.4f})/{h:.4f},2),0)"
            (zt if ty in ("zoom", "zoomflash") else st if ty == "shake" else []).append(term)
        if B:
            ty, h = B
            term = f"if(lt({T},{h:.4f}),pow(1-{T}/{h:.4f},2),0)"
            (zt if ty in ("zoom", "zoomflash") else st if ty == "shake" else []).append(term)
        if zt or st:
            zx = "1" + (f"+0.5*({'+'.join(zt)})" if zt else "") + (f"+0.12*({'+'.join(st)})" if st else "")
            px = "iw/2-(iw/zoom/2)" + (f"+{0.03 * ow:.2f}*({'+'.join(st)})*sin({T}*80)" if st else "")
            py = "ih/2-(ih/zoom/2)" + (f"+{0.02 * oh:.2f}*({'+'.join(st)})*sin({T}*97)" if st else "")
            v += f",zoompan=z='{zx}':x='{px}':y='{py}':d=1:s={ow}x{oh}:fps=30"
        if A and A[0] in TR_COLOR:
            v += f",fade=t=out:st={L - A[1]:.4f}:d={A[1]:.4f}:color={TR_COLOR[A[0]]}"
        if B and B[0] in TR_COLOR:
            v += f",fade=t=in:st=0:d={B[1]:.4f}:color={TR_COLOR[B[0]]}"
        v += f",setsar=1,format=yuv420p[v{i}]"
        chains.append(v)
        tags += f"[v{i}]"
        if has_audio:
            chains.append(
                f"[0:a]atrim=start={c['start']:.3f}:end={c['end']:.3f},"
                f"asetpts=PTS-STARTPTS,{atempo(c['speed'])},"
                f"aformat=sample_rates=44100:channel_layouts=stereo[a{i}]")
            tags += f"[a{i}]"
    chains.append(f"{tags}concat=n={n}:v=1:a={1 if has_audio else 0}[v]"
                  + ("[abase]" if has_audio else ""))
    extras = bool(sfx or music)
    label = None
    if extras:
        if not has_audio:
            chains.append(f"anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration={total:.3f}[abase]")
        fm = "aformat=sample_rates=44100:channel_layouts=stereo"
        parts = ["[abase]"]
        for k, x in enumerate(sfx):
            ms = round(x["t"] * 1000)
            chains.append(f"[{1 + k}:a]{fm},volume={x['vol']:.3f},adelay={ms}|{ms}[s{k}]")
            parts.append(f"[s{k}]")
        if music:
            f = min(music["fade"], total)
            m = f"[{1 + len(sfx)}:a]{fm},volume={music['vol']:.3f},atrim=duration={total:.3f}"
            if f > 0.05:
                m += f",afade=t=out:st={total - f:.3f}:d={f:.3f}"
            chains.append(m + "[mus]")
            parts.append("[mus]")
        chains.append("".join(parts) + f"amix=inputs={len(parts)}:normalize=0:duration=first,alimiter=limit=0.97[aout]")
        label = "[aout]"
    elif has_audio:
        label = "[abase]"
    vlabel = "[v]"
    if fxs:   # FX: concat එකට පස්සේ, text වලට යටින්
        fg, vlabel = build_fx("[v]", fxs, ow, oh, total)
        chains.append(fg)
    if texts or imgs:   # overlay සියල්ල 4:4:4 වලින් (chroma blur නැතුව), අන්තිමට එක පාරක් විතරක් 4:2:0
        chains.append(f"{vlabel}format=yuv444p[v444]")
        vlabel = "[v444]"
    for k, im in enumerate(imgs or []):   # image overlays: FX වලට උඩින්, text වලට යටින්
        w = max(2, round(im["w"] * ow))
        opa = f",colorchannelmixer=aa={im['op']:.3f}" if im["op"] < 0.999 else ""
        chains.append(f"[{ibase + k}:v]format=rgba,scale={w}:-1:flags=lanczos{opa}[im{k}]")
        chains.append(f"{vlabel}[im{k}]overlay=x=main_w*{im['x']:.5f}-overlay_w/2:y=main_h*{im['y']:.5f}-overlay_h/2"
                      f":enable='between(t,{im['start']:.3f},{im['end']:.3f})':format=auto[vi{k}]")
        vlabel = f"[vi{k}]"
    for k, t in enumerate(texts or []):   # text layers: concat එකට පස්සේ overlay (flash/transition වලට උඩින්)
        w = max(2, round(t["wf"] * ow))
        fl = ["format=rgba"]
        if abs(w - (t.get("pw") or 0)) > 1:   # size එක ගැලපෙනවා නම් resample නෑ (1:1 pixels = තියුණුම)
            fl.append(f"scale={w}:-1:flags=lanczos")
        if t.get("op", 1) < 0.999:
            fl.append(f"colorchannelmixer=aa={t['op']:.3f}")
        chains.append(f"[{tbase + k}:v]" + ",".join(fl) + f"[tx{k}]")
        chains.append(f"{vlabel}[tx{k}]overlay=x=main_w*{t['x']:.5f}-overlay_w/2:y=main_h*{t['y']:.5f}-overlay_h/2"
                      f":enable='between(t,{t['start']:.3f},{t['end']:.3f})':format=auto[vt{k}]")
        vlabel = f"[vt{k}]"
    if texts or imgs:
        chains.append(f"{vlabel}format=yuv420p[vout]")
        vlabel = "[vout]"
    return ";".join(chains), label, vlabel


def run_export(pid: str, clips, sfx, music, width: int, preset: str, canvas: str = "auto", texts=None, fxs=None, imgs=None):
    d = DATA / pid
    job = JOBS[pid]
    with ffmpeg_lock:
        job["status"] = "running"
        try:
            m = read_meta(d)
            src = d / m["original"]
            info = probe(src)
            ow, oh = info["width"], info["height"]
            if not ow or not oh:
                raise RuntimeError("video size read කරන්න බෑ")
            sw0, sh0 = ow, oh
            ow, oh = canvas_dims(canvas, clips, sw0, sh0)
            if width:
                oh = round(oh * width / ow)
                ow = width
            ow -= ow % 2
            oh -= oh % 2
            sfx = [x for x in sfx + transition_sfx(clips) if asset_path(x["asset"])]
            if music and not asset_path(music["asset"]):
                music = None
            total = sum((c["end"] - c["start"]) / c["speed"] for c in clips)
            texts = texts or []
            tbase = 1 + len(sfx) + (1 if music else 0)
            fxs = [dict(f, end=min(f["end"], total)) for f in (fxs or []) if f["start"] < total - 0.05]
            imgs = imgs or []
            ibase = tbase + len(texts)
            graph, label, vlabel = build_graph(clips, ow, oh, info["has_audio"], sfx, music, total, sw0, sh0, texts, tbase, fxs, imgs, ibase)
            tmp = d / "output_tmp.mp4"
            cmd = [FFMPEG, "-y", "-i", str(src)]
            for x in sfx:
                cmd += ["-i", str(asset_path(x["asset"]))]
            if music:
                cmd += ["-stream_loop", "-1", "-i", str(asset_path(music["asset"]))]
            for t in texts:
                cmd += ["-loop", "1", "-framerate", "30", "-t", f"{total:.3f}", "-i", str(t["path"])]
            for im in imgs:
                cmd += ["-loop", "1", "-framerate", "30", "-t", f"{total:.3f}", "-i", str(im["path"])]
            cmd += ["-filter_complex", graph, "-map", vlabel]
            if label:
                cmd += ["-map", label, "-c:a", "aac", "-b:a", "192k"]
            cmd += ["-c:v", "libx264", "-preset", preset, "-crf", "14" if preset == "medium" else "15",
                    "-profile:v", "high", "-pix_fmt", "yuv420p", "-t", f"{total:.3f}",
                    "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(tmp)]
            with (d / "export.log").open("wb") as logf:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=logf, text=True)
                for line in proc.stdout:
                    if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                        try:
                            us = int(line.split("=")[1])
                            job["progress"] = min(0.99, us / 1e6 / total)
                        except ValueError:
                            pass
                proc.wait()
            if proc.returncode != 0:
                tail = (d / "export.log").read_text(errors="replace")[-300:]
                raise RuntimeError("ffmpeg failed: " + tail)
            os.replace(tmp, d / "output.mp4")
            job.update(status="done", progress=1)
        except Exception as e:
            job.update(status="error", error=str(e))
        finally:
            for f in d.glob("txt_*.png"):
                f.unlink(missing_ok=True)


@app.post("/api/projects/{pid}/export")
async def start_export(pid: str, request: Request, bg: BackgroundTasks):
    d = pdir(pid)
    if JOBS.get(pid, {}).get("status") in ("queued", "running"):
        raise HTTPException(409, "already running")
    body = await request.json()
    clips = sanitize(body.get("clips"), read_meta(d).get("duration", 0))
    if not clips:
        raise HTTPException(400, "no clips")
    sfx, music = sanitize_audio(body.get("sfx"), body.get("music"))
    canvas = clean_canvas(body.get("canvas"))
    ep = d / "edit.json"
    try:
        ed = json.loads(ep.read_text()) if ep.exists() else {}
    except ValueError:
        ed = {}
    ed.update({"clips": clips, "sfx": sfx, "music": music, "canvas": canvas})
    layers = body.get("layers")
    if isinstance(layers, list) and len(layers) <= 100 and all(isinstance(x, dict) for x in layers):
        ed["texts"] = layers
    raw_fxs = body.get("fxs")
    if isinstance(raw_fxs, list) and len(raw_fxs) <= 100 and all(isinstance(x, dict) for x in raw_fxs):
        ed["fxs"] = raw_fxs
    raw_imgs = body.get("imgs")
    if isinstance(raw_imgs, list) and len(raw_imgs) <= 100 and all(isinstance(x, dict) for x in raw_imgs):
        ed["imgs"] = raw_imgs
    ep.write_text(json.dumps(ed))
    fxs = sanitize_fxs(raw_fxs)
    imgs = sanitize_imgs(raw_imgs)
    texts = sanitize_texts(body.get("texts"), d)
    width = int(body.get("width") or 0)
    width = width if 240 <= width <= 4320 else 0
    preset = body.get("preset") if body.get("preset") in ("veryfast", "medium") else "veryfast"
    JOBS[pid] = {"status": "queued", "progress": 0, "error": ""}
    bg.add_task(run_export, pid, clips, sfx, music, width, preset, canvas, texts, fxs, imgs)
    return JOBS[pid]


@app.get("/api/projects/{pid}/export")
def export_status(pid: str):
    d = pdir(pid)
    if pid in JOBS:
        return JOBS[pid]
    done = (d / "output.mp4").exists()
    return {"status": "done" if done else "idle", "progress": 1 if done else 0, "error": ""}


@app.get("/api/projects/{pid}/output.mp4")
def get_output(pid: str):
    p = pdir(pid) / "output.mp4"
    if not p.exists():
        raise HTTPException(404, "no export yet")
    return FileResponse(p, media_type="video/mp4", filename="edited.mp4")


class NoCacheStatic(StaticFiles):
    """frontend files හැම වෙලාවෙම revalidate කරනවා (පරණ app.js cache වෙලා තියෙන එක නවත්තන්න)"""
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


app.mount("/", NoCacheStatic(directory=FRONT, html=True), name="front")
