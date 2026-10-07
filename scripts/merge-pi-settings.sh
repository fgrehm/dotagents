#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="$HOME/.pi/agent/settings.json"
MANAGED="$REPO_ROOT/config/pi-settings.managed.json"

if ! command -v jq >/dev/null 2>&1; then
  printf '[dotagents] ERROR: jq is required to merge Pi settings\n' >&2
  exit 1
fi
if ! jq -e 'type == "object"' "$MANAGED" >/dev/null 2>&1; then
  printf '[dotagents] ERROR: managed Pi settings are not valid JSON\n' >&2
  exit 1
fi

if [[ ! -e "$TARGET" ]]; then
  mkdir -p "$(dirname "$TARGET")"
  jq . "$MANAGED" >"$TARGET"
  printf '[dotagents] Seeded Pi settings with managed presentation keys\n'
  exit 0
fi
if ! jq -e 'type == "object"' "$TARGET" >/dev/null 2>&1; then
  printf '[dotagents] ERROR: %s is not a JSON object; leaving it untouched\n' "$TARGET" >&2
  exit 1
fi

merged="$(jq -s '.[0] * .[1]' "$TARGET" "$MANAGED")"
changed="$(jq -r -s '
  def old($local; $key): if $local | has($key) then $local[$key] else null end;
  .[0] as $local | .[1] as $managed |
  $managed | to_entries
  | map(select(old($local; .key) != .value))
  | .[]
  | "\(.key): \(old($local; .key) | @json) -> \(.value | @json)"
' "$TARGET" "$MANAGED")"
if [[ -z "$changed" ]]; then
  printf '[dotagents] Pi settings already match managed keys\n'
  exit 0
fi

printf '%s\n' "$merged" | jq . >"$TARGET.tmp"
mv -- "$TARGET.tmp" "$TARGET"
printf '[dotagents] Updated managed Pi settings keys:\n%s\n' "$changed"
