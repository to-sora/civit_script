#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
basedir="$(cd -- "$script_dir/../comfyui" && pwd)"
mnt_root="${COMFY_MODEL_ROOT:-/mnt/DATA9}"
default_python="$basedir/venv/bin/python"
[[ -x "$default_python" ]] || default_python="$script_dir/../comfyui-llm-module/plugin/.local-tool-app/venv/bin/python"
python_bin="${COMFY_PYTHON:-$default_python}"
tls_dir="${COMFY_TLS_DIR:-$basedir/.runtime/tls}"
[[ -f "$basedir/main.py" && -x "$python_bin" ]] || {
    echo 'Run civit_script/install.sh first / 請先執行安裝腳本' >&2
    exit 1
}
cd -- "$basedir"
mkdir -p models "$tls_dir" user/default

# Keep existing workspace directories; never migrate or delete their contents.
link_directory() {
    local link="$1" target="$2"
    [[ -d "$target" ]] || { echo "Missing directory: $target" >&2; exit 1; }
    if [[ -L "$link" ]]; then
        ln -sfn -- "$target" "$link"
    elif [[ ! -e "$link" ]]; then
        ln -s -- "$target" "$link"
    fi
}
link_directory input "$mnt_root/Comfyui_MAIN/input"
link_directory output "$mnt_root/Comfyui_MAIN/output"
link_directory user/default/workflows "$mnt_root/Comfyui_MAIN/workflows"
bash "$script_dir/Comfyui_link_builder.sh" "$basedir/models" \
    "$mnt_root/Comfyui_P2/models" "$mnt_root/Comfyui_P1/models" \
    "$mnt_root/Comfyui_MAIN/models" "$mnt_root/SD_MODEL_output/models"

if [[ ! -f "$tls_dir/cert.pem" || ! -f "$tls_dir/key.pem" ]]; then
    (umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -keyout "$tls_dir/key.pem" -out "$tls_dir/cert.pem" \
        -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
        >/dev/null 2>&1)
fi
args=(--listen 0.0.0.0 --port "${COMFY_PORT:-8188}"
      --disable-all-custom-nodes --disable-api-nodes --disable-auto-launch
      --tls-keyfile "$tls_dir/key.pem" --tls-certfile "$tls_dir/cert.pem")
if [[ "${COMFY_ENABLE_LLM:-0}" == 1 ]]; then
    args+=(--whitelist-custom-nodes comfyui-llm-module)
fi
[[ "${1:-}" != -Y ]] || shift
exec "$python_bin" main.py "${args[@]}" "$@"
