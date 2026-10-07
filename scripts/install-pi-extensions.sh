#!/usr/bin/env bash
set -euo pipefail

if ! command -v pi >/dev/null 2>&1; then
  printf '[dotagents] Pi not found, skipping Pi extension installs\n'
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  printf '[dotagents] jq not found, skipping Pi extension installs\n' >&2
  exit 0
fi

settings="$HOME/.pi/agent/settings.json"
declare -A floor=(
  ["pi-web-access"]=0.36.0
  ["pi-ollama-cloud"]=0.12.2
)
if command -v omarchy >/dev/null 2>&1 || [[ -d "$HOME/.local/share/omarchy" ]]; then
  floor["@juicesharp/rpiv-ask-user-question"]=2.12.0
fi

newer_than() {
  [[ -z "$2" ]] && return 0
  [[ "$1" == "$2" ]] && return 1
  [[ "$(printf '%s\n' "$2" "$1" | sort -V | tail -n 1)" == "$1" ]]
}

unpin() {
  local name="$1" tmp
  [[ -f "$settings" ]] || return 0
  tmp="$(mktemp)"
  if ! jq --arg name "$name" '
    if .packages then
      .packages |= map(
        (if type == "object" then .source else . end) as $src
        | ($src | capture("^npm:(?<n>.+)@(?<v>[^@]+)$") // null) as $m
        | if $m != null and $m.n == $name
          then (if type == "object" then .source |= sub("@[^@]+$"; "") else sub("@[^@]+$"; "") end)
          else . end)
    else . end' "$settings" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    printf '[dotagents] ERROR: could not read Pi package settings; leaving them alone\n' >&2
    return 1
  fi
  if cmp -s "$tmp" "$settings"; then
    rm -f "$tmp"
  else
    mv -- "$tmp" "$settings"
    printf '[dotagents] Removed version pin from Pi extension: %s\n' "$name"
  fi
}

declare -A installed=()
while IFS=$'\t' read -r name version; do
  [[ -n "$name" ]] && installed["$name"]="$version"
done < <(
  pi list 2>/dev/null | awk '
    /^[[:space:]]+(npm:|git:|file:)[^[:space:]]*$/ {
      name = $1
      sub(/@[0-9][^@]*$/, "", name)
      sub(/^[a-z]+:/, "", name)
      next
    }
    name != "" && $1 ~ /^\// { print name "\t" $1; name = "" }
  ' | while IFS=$'\t' read -r name path; do
    if [[ -f "$path/package.json" ]]; then
      printf '%s\t%s\n' "$name" "$(jq -r '.version // empty' "$path/package.json" 2>/dev/null)"
    fi
  done
)

for name in "${!floor[@]}"; do
  minimum="${floor[$name]}"
  current="${installed[$name]:-}"
  unpin "$name"
  if [[ -n "$current" ]] && ! newer_than "$minimum" "$current"; then
    printf '[dotagents] Pi extension at or above floor: %s %s\n' "$name" "$current"
    continue
  fi
  printf '[dotagents] Installing/updating Pi extension npm:%s@latest (floor %s)\n' "$name" "$minimum"
  if pi install "npm:$name@latest"; then
    unpin "$name"
  else
    printf '[dotagents] WARNING: failed to install npm:%s@latest\n' "$name" >&2
  fi
done
