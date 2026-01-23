#!/usr/bin/env python3
import os
import sys
import json
import argparse
import pathlib
import re
import requests
from typing import Dict, Any, Optional, Tuple
import time
# -------------------------
# Utilities
# -------------------------

def die(msg: str):
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(1)

def warn(msg: str):
    print(f"[WARN] {msg}", file=sys.stderr)

def ensure_writable_dir(path: pathlib.Path):
    path.mkdir(parents=True, exist_ok=True)
    if not os.access(path, os.W_OK):
        die(f"No write permission: {path}")

def get_filename_from_headers(url: str, headers: Dict[str, str]) -> str:
    cd = headers.get("Content-Disposition", "") or headers.get("content-disposition", "")
    if "filename=" in cd:
        fn = cd.split("filename=", 1)[1].strip()
        if fn.startswith('"') and fn.endswith('"'):
            fn = fn[1:-1]
        return fn
    return url.rstrip("/").split("/")[-1]

def uniquify_path(p: pathlib.Path) -> pathlib.Path:
    if not p.exists():
        return p
    stem = p.stem
    suf = p.suffix
    parent = p.parent
    i = 2
    while True:
        cand = parent / f"{stem}__{i}{suf}"
        if not cand.exists():
            return cand
        i += 1

# -------------------------
# AIR parsing (copiedMessage only)
# -------------------------

_AIR_URN_RE = re.compile(
    r"^urn:air:"
    r"(?P<ecosystem>[a-z0-9]+):"
    r"(?P<type>[a-z0-9]+):"
    r"(?P<source>[a-z0-9]+):"
    r"(?P<id>\d+)"
    r"(?:@(?P<version>\d+))?"
    r"(?:\.(?P<format>[A-Za-z0-9]+))?"
    r"$"
)

def parse_air(meta_obj: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    cm = meta_obj.get("copiedMessage")
    if not isinstance(cm, str) or not cm.strip():
        return None
    m = _AIR_URN_RE.match(cm.strip())
    if not m:
        warn(f"invalid AIR URN, fallback to default/: {cm!r}")
        return None
    return m.group("type").lower(), m.group("ecosystem").lower()

# -------------------------
# Networking
# -------------------------

def headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": "civitai-downloader/air-routing"
    }

def probe_filename(url: str, h: Dict[str, str]) -> str:
    try:
        r = requests.head(url, headers=h, allow_redirects=True, timeout=30)
        if r.status_code < 400:
            return get_filename_from_headers(r.url, r.headers)
    except Exception:
        pass
    with requests.get(url, headers=h, stream=True, allow_redirects=True, timeout=60) as r:
        r.raise_for_status()
        return get_filename_from_headers(r.url, r.headers)

def download(url: str, h: Dict[str, str], path: pathlib.Path) -> int:
    time.sleep(5)
    with requests.get(url, headers=h, stream=True, allow_redirects=True, timeout=60) as r:
        r.raise_for_status()
        total = 0
        with open(path, "wb") as f:
            for c in r.iter_content(chunk_size=1024 * 1024):
                if c:
                    f.write(c)
                    total += len(c)
    return total

# -------------------------
# Main
# -------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("meta_json")
    ap.add_argument("root_dir")
    args = ap.parse_args()

    token = os.environ.get("CIVIT_API")
    if not token:
        die("CIVIT_API not set")

    root = pathlib.Path(args.root_dir).resolve()
    ensure_writable_dir(root)

    with open(args.meta_json, "r", encoding="utf-8") as f:
        meta = json.load(f)

    h = headers(token)
    changed = False

    for item in meta.get("items", []):
        meta_obj = item.get("meta", {}) or {}
        links = meta_obj.get("downloadlinks") or []

        # ONLY deduplicate inside this list
        seen = set()
        links = [u for u in links if not (u in seen or seen.add(u))]

        air = parse_air(meta_obj)
        base = root / air[0] if air else root / "default"
        ensure_writable_dir(base)

        for url in links:
            try:
                name = probe_filename(url, h)
            except Exception as e:
                warn(f"filename probe failed: {url} -> {e}")
                continue

            if air:
                _, eco = air
                target = base / f"{eco}_{name}"
            else:
                target = base / name

            target = uniquify_path(target)

            print(f"[DOWNLOAD] {url}")
            try:
                size = download(url, h, target)
            except Exception as e:
                warn(f"download failed: {url} -> {e}")
                continue

            item.setdefault("downloads", []).append({
                "url": url,
                "relative_path": str(target),
                "size_bytes": size
            })
            changed = True
            print(f"[OK] {target} ({size} bytes)")

    if changed:
        p = pathlib.Path(args.meta_json)
        tmp = p.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        tmp.replace(p)

if __name__ == "__main__":
    main()
