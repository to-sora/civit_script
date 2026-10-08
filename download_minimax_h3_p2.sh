#!/usr/bin/env bash
set -Eeuo pipefail

MODEL_ROOT="/mnt/DATA9/Comfyui_P2/models"
HF_BASE="https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main"

FILES=(
    "vae|minimax_h3_video_vae_fp16.safetensors|5207808496|7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522"
  "vae|minimax_h3_audio_vae_fp32.safetensors|605254808|8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48"
  "diffusion_models|minimax_h3_fl2va_pruned_int8_convrot.safetensors|20970379616|e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a"
  "diffusion_models|minimax_h3_ref2va_pruned_int8_convrot.safetensors|20970379616|9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779"
  "diffusion_models|wan_animate_2_int8_convrot.safetensors|16653175528|0580ecdd65e47e97c30df9670d13a6c4a131d26de5a1faf2ccc78392d5167584|https://huggingface.co/Comfy-Org/Wan-Animate-2/resolve/main/diffusion_models/wan_animate_2_int8_convrot.safetensors"
  "text_encoders|qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors|15687142551|35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6"
)

usage() {
    printf 'Usage: bash %s\n' "$0" >&2
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

(( $# == 0 )) || { usage; exit 2; }

for command in awk curl df findmnt id mkdir mv sha256sum stat tail tr; do
    command -v "$command" >/dev/null || die "Required command not found: $command"
done

[[ -d "$MODEL_ROOT" ]] || die "Model root does not exist: $MODEL_ROOT"

mount_target="$(findmnt -n -o TARGET -T "$MODEL_ROOT")"
mount_options="$(findmnt -n -o OPTIONS -T "$MODEL_ROOT")"
[[ ",$mount_options," != *,ro,* ]] || die "$mount_target is mounted read-only. ACLs cannot grant writes until an administrator mounts it read-write."
[[ -r "$MODEL_ROOT" && -w "$MODEL_ROOT" && -x "$MODEL_ROOT" ]] || die "The current account does not have read/write/traverse access to $MODEL_ROOT. Configure its ACL first."

curl_args=(--fail --location --silent --show-error --retry 5 --retry-all-errors)
if [[ -n "${HF_TOKEN:-}" ]]; then
    curl_args+=(--header "Authorization: Bearer $HF_TOKEN")
fi

printf 'Checking the Hugging Face files...\n'
for entry in "${FILES[@]}"; do
    IFS='|' read -r subdir filename expected_size expected_sha source_url <<< "$entry"
    url="${source_url:-$HF_BASE/$subdir/$filename}"
    curl "${curl_args[@]}" --head --output /dev/null "$url" || die "Hugging Face file is unavailable: $url"
    printf '  FOUND %s\n' "$filename"
done

required_bytes=0
for entry in "${FILES[@]}"; do
    IFS='|' read -r subdir filename expected_size expected_sha source_url <<< "$entry"
    target="$MODEL_ROOT/$subdir/$filename"
    if [[ -e "$target" ]]; then
        actual_size="$(stat -c %s "$target")"
        [[ "$actual_size" == "$expected_size" ]] || die "Existing file has the wrong size: $target"
        actual_sha="$(sha256sum "$target" | awk '{print $1}')"
        [[ "$actual_sha" == "$expected_sha" ]] || die "Existing file has the wrong SHA-256: $target"
    else
        required_bytes=$((required_bytes + expected_size))
    fi
done

available_bytes="$(df --output=avail -B1 "$MODEL_ROOT" | tail -n 1 | tr -d ' ')"
(( available_bytes >= required_bytes )) || die "Insufficient free space: need $required_bytes bytes, have $available_bytes bytes"

for entry in "${FILES[@]}"; do
    IFS='|' read -r subdir filename expected_size expected_sha source_url <<< "$entry"
    destination_dir="$MODEL_ROOT/$subdir"
    target="$destination_dir/$filename"
    part="$target.part.$(id -u)"
    url="${source_url:-$HF_BASE/$subdir/$filename}"

    if [[ -e "$target" ]]; then
        printf 'SKIP verified existing file: %s\n' "$target"
        continue
    fi

    if [[ ! -d "$destination_dir" ]]; then
        mkdir -p "$destination_dir"
    fi
    [[ -r "$destination_dir" && -w "$destination_dir" && -x "$destination_dir" ]] || die "The current account cannot write to $destination_dir"
    [[ ! -e "$part" || -w "$part" ]] || die "Partial download is not writable by the current account: $part"

    printf 'Downloading %s\n' "$url"
    curl "${curl_args[@]}" --continue-at - --output "$part" "$url"

    actual_size="$(stat -c %s "$part")"
    if [[ "$actual_size" != "$expected_size" ]]; then
        die "Size verification failed for $filename: expected $expected_size, got $actual_size"
    fi

    actual_sha="$(sha256sum "$part" | awk '{print $1}')"
    if [[ "$actual_sha" != "$expected_sha" ]]; then
        die "SHA-256 verification failed for $filename"
    fi

    [[ ! -e "$target" ]] || die "Destination appeared while downloading; leaving the verified partial file in place: $part"
    mv --no-clobber "$part" "$target"
    [[ ! -e "$part" ]] || die "Destination appeared while downloading; leaving the verified partial file in place: $part"
    printf 'VERIFIED %s\n' "$target"
done

printf 'MiniMax H3 model set installed under %s\n' "$MODEL_ROOT"
