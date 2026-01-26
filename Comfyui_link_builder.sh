#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# USAGE
#   bash match.sh <DIR_A> <SRC1> <SRC2> [SRC3 ...]
#
# ENV (optional):
#   MATCH_GLOB="*.safetensors"   # default: all files
###############################################################################

err() { printf "ERROR: %s\n" "$*" >&2; exit 1; }

need_dir() {
  local d="$1"
  [[ -d "$d" ]] || err "Directory not found: $d"
}

# Remove trailing slashes (except keep "/" as "/")
norm_path() {
  local p="$1"
  [[ "$p" == "/" ]] && { printf "/"; return; }
  # strip all trailing slashes
  while [[ "$p" == */ ]]; do p="${p%/}"; done
  printf "%s" "$p"
}

link_tree() {
  local src_root="$1"
  local src_label="$2"
  local match_glob="${MATCH_GLOB:-}"

  src_root="$(norm_path "$src_root")"

  local find_args=()
  find_args+=( "$src_root" -type f )
  if [[ -n "$match_glob" ]]; then
    find_args+=( -name "$match_glob" )
  fi

  find "${find_args[@]}" -print0 | while IFS= read -r -d '' src_path; do
    # Defensive: ensure src_path is under src_root
    case "$src_path" in
      "$src_root"/*) ;;
      *) err "Internal: path not under src_root. src_root=$src_root src_path=$src_path" ;;
    esac

    # Relative path within src_root
    rel="${src_path#"$src_root"/}"

    # Destination path in A
    dst_path="$DIR_A/$rel"
    dst_dir="$(dirname "$dst_path")"

    mkdir -p "$dst_dir"
    ln -sfn "$src_path" "$dst_path"
  done

  printf "Linked from %s: %s -> %s (MATCH_GLOB=%s)\n" \
    "$src_label" "$src_root" "$DIR_A" "${match_glob:-<all>}"
}

###############################################################################
# MAIN
###############################################################################
(( $# >= 3 )) || err "Usage: bash $0 <DIR_A> <SRC1> <SRC2> [SRC3 ...]"

DIR_A="$(norm_path "$1")"
shift

need_dir "$DIR_A"

i=1
for src in "$@"; do
  src="$(norm_path "$src")"
  need_dir "$src"
  link_tree "$src" "SRC#$i"
  i=$((i+1))
done

echo "Done. Conflict policy: later sources win (later overwrote any same-path names from earlier)."
