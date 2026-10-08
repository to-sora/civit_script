#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
basedir="$(cd -- "$script_dir/../comfyui" && pwd)"
venv_dir="${COMFY_VENV:-$basedir/venv}"
bootstrap_python="${COMFY_BOOTSTRAP_PYTHON:-python3}"
[[ -x "$venv_dir/bin/python" ]] || "$bootstrap_python" -m venv "$venv_dir"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$basedir/.runtime/pip}"
export TMPDIR="${TMPDIR:-$basedir/.runtime/tmp}"
mkdir -p "$PIP_CACHE_DIR" "$TMPDIR"
pip4() {
    "$venv_dir/bin/python" "$script_dir/pip_ipv4.py" "$@"
}
pip4 install torch==2.13.0 torchvision==0.28.0 \
    --index-url https://download.pytorch.org/whl/cu130
pip4 install -r "$basedir/requirements.txt"
