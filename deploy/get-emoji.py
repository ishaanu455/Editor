#!/usr/bin/env python3
"""Apple style emoji PNG library download කරනවා -> data/emoji/  (+ index.json)

  python3 deploy/get-emoji.py            # සියල්ල (resume කරන්න පුළුවන්)
  python3 deploy/get-emoji.py --version 15.1.2

Source: emoji-datasource-apple (iamcal/emoji-data) — jsDelivr CDN එකෙන්. 160px PNG තියෙනවා නම් ඒක,
නැත්නම් 64px. (Apple emoji artwork එක Apple ගේ — පුද්ගලික/ඔයාගේම වැඩ වලට විතරක් use කරන්න.)
ඔයාගේම Apple emoji PNG තියෙනවා නම් data/emoji/<codepoint>.png විදියට දාලත් හරි (උදා: 1f600.png).
"""
import argparse, json, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "emoji"
ap = argparse.ArgumentParser()
ap.add_argument("--version", default="15.1.2")
ap.add_argument("--workers", type=int, default=8)
a = ap.parse_args()
V = a.version
OUT.mkdir(parents=True, exist_ok=True)


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "aegisx-editor"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


try:
    data = json.loads(get(f"https://cdn.jsdelivr.net/npm/emoji-datasource-apple@{V}/emoji.json", 120))
except Exception as e:
    sys.exit(f"emoji.json download කරන්න බෑ ({e}). Internet / --version බලන්න")

data = [d for d in data if d.get("has_img_apple") and d.get("image")]
data.sort(key=lambda d: d.get("sort_order", 0))
print(f"{len(data)} emoji…")

SRC = [  # ලොකු quality මුලින්
    f"https://cdn.jsdelivr.net/gh/iamcal/emoji-data@v{V}/img-apple-160/",
    f"https://cdn.jsdelivr.net/gh/iamcal/emoji-data@master/img-apple-160/",
    f"https://cdn.jsdelivr.net/npm/emoji-datasource-apple@{V}/img/apple/64/",
]
stats = {"160": 0, "64": 0, "skip": 0, "fail": 0}


def fetch(d):
    name = d["image"]
    stem = name[:-4].lower()
    dst = OUT / f"{stem}.png"
    if dst.exists() and dst.stat().st_size > 100:
        stats["skip"] += 1
        return stem, True
    for base in SRC:
        try:
            b = get(base + name)
            if b[:4] == b"\x89PNG":
                dst.write_bytes(b)
                stats["64" if "/64/" in base else "160"] += 1
                return stem, True
        except (urllib.error.URLError, OSError):
            continue
    stats["fail"] += 1
    return stem, False


with ThreadPoolExecutor(a.workers) as ex:
    res = list(ex.map(fetch, data))

okset = {s for s, ok in res if ok}
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
(OUT / "index.json").write_text(json.dumps({"cats": cats, "items": items}, ensure_ascii=False), encoding="utf-8")
print(f"done: {len(items)} emoji  (160px: {stats['160']}, 64px: {stats['64']}, already: {stats['skip']}, failed: {stats['fail']})")
