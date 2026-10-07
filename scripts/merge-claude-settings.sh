#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="$HOME/.claude/settings.json"
BASE="$REPO_ROOT/config/claude-settings.base.json"

if ! command -v jq >/dev/null 2>&1; then
  printf '[dotagents] ERROR: jq is required to merge Claude settings\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
if [[ ! -e "$TARGET" ]]; then
  cp -- "$BASE" "$TARGET"
  printf '[dotagents] Installed Claude settings base\n'
  exit 0
fi

if ! jq -e 'type == "object"' "$TARGET" >/dev/null 2>&1; then
  printf '[dotagents] ERROR: %s is not valid JSON; leaving it untouched\n' "$TARGET" >&2
  exit 1
fi

merged="$(jq -s '
  def merge_arrays: map(. // []) | add | unique;
  def merge_hooks($local; $base):
    reduce (($local.hooks // {} | keys_unsorted[]), ($base.hooks // {} | keys_unsorted[])) as $event
      ({}; .[$event] = ((($local.hooks[$event] // []) + ($base.hooks[$event] // [])) | unique));
  .[0] as $local | .[1] as $base |
  ($local * $base) |
  .permissions.allow = ([$local.permissions.allow, $base.permissions.allow] | merge_arrays) |
  .permissions.deny  = ([$local.permissions.deny,  $base.permissions.deny]  | merge_arrays) |
  .permissions.ask   = ([$local.permissions.ask,   $base.permissions.ask]   | merge_arrays) |
  .hooks = merge_hooks($local; $base)
' "$TARGET" "$BASE")"

current_sorted="$(jq --sort-keys . "$TARGET")"
merged_sorted="$(printf '%s' "$merged" | jq --sort-keys .)"
if [[ "$current_sorted" == "$merged_sorted" ]]; then
  printf '[dotagents] Claude settings already up to date\n'
  exit 0
fi

printf '%s\n' "$merged" | jq . >"$TARGET.tmp"
mv -- "$TARGET.tmp" "$TARGET"
printf '[dotagents] Merged managed values into Claude settings\n'
