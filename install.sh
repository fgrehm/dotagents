#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENTS_SOURCE="$REPO_ROOT/agents"
AGENTS_HOME="$HOME/.agents"
DRY_RUN=0
ADOPT_IDENTICAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
  --dry-run) DRY_RUN=1 ;;
  --adopt-identical) ADOPT_IDENTICAL=1 ;;
  -h | --help)
    printf 'Usage: %s [--dry-run] [--adopt-identical]\n' "$0"
    exit 0
    ;;
  *)
    printf 'Usage: %s [--dry-run] [--adopt-identical]\n' "$0" >&2
    exit 2
    ;;
  esac
  shift
done

log() { printf '[dotagents] %s\n' "$*"; }

ensure_directory() {
  local dir="$1"
  if [[ -L "$dir" && ! -e "$dir" ]]; then
    log "SKIP $dir is a broken symlink"
    return 1
  fi
  if [[ -e "$dir" && ! -d "$dir" ]]; then
    log "SKIP $dir exists but is not a directory"
    return 1
  fi
  if [[ ! -d "$dir" ]]; then
    if ((DRY_RUN)); then
      log "mkdir -p $dir"
    else
      mkdir -p "$dir"
    fi
  fi
}

link_file() {
  local src="$1" dest="$2" owned_prefix="$3" existing

  if [[ -L "$dest" ]]; then
    existing="$(readlink "$dest")"
    if [[ "$existing" == "$src" ]]; then
      log "OK $dest already linked"
      return 0
    fi
    case "$existing" in
    "$owned_prefix"*)
      if ((DRY_RUN)); then
        log "UPDATE link $dest -> $src"
      else
        rm -f -- "$dest"
        ln -s -- "$src" "$dest"
        log "Updated link $dest"
      fi
      return 0
      ;;
    *)
      log "SKIP $dest is a symlink not managed by dotagents"
      return 0
      ;;
    esac
  elif [[ -e "$dest" ]]; then
    if ((ADOPT_IDENTICAL)) && [[ -f "$dest" ]] && cmp -s -- "$src" "$dest"; then
      if ((DRY_RUN)); then
        log "ADOPT identical file $dest -> $src"
      else
        local tmp="${dest}.dotagents-tmp.$$"
        ln -s -- "$src" "$tmp"
        mv -Tf -- "$tmp" "$dest"
        log "Adopted identical file $dest"
      fi
      return 0
    fi
    log "SKIP $dest already exists as a file or directory"
    return 0
  fi

  if ((DRY_RUN)); then
    log "LINK $dest -> $src"
  else
    ln -s -- "$src" "$dest"
    log "Linked $dest"
  fi
}

migrate_legacy_payload() {
  local src dest item
  copy_if_missing() {
    src="$1"
    dest="$2"
    [[ -e "$src" ]] || return 0
    [[ -e "$dest" || -L "$dest" ]] && return 0
    if ((DRY_RUN)); then
      log "MIGRATE $src -> $dest"
    else
      mkdir -p "$(dirname "$dest")"
      cp -p -- "$src" "$dest"
    fi
  }

  copy_if_missing "$HOME/.claude/statusline.sh" "$AGENTS_HOME/statusline.sh"
  for item in "$HOME/.claude/output-styles"/*.md; do
    [[ -e "$item" ]] || continue
    copy_if_missing "$item" "$AGENTS_HOME/output-styles/$(basename "$item")"
  done
  for item in "$HOME/.pi/agent/ollama-cloud.json" "$HOME/.pi/agent/web-search.json"; do
    copy_if_missing "$item" "$AGENTS_HOME/pi/$(basename "$item")"
  done
  for item in "$HOME/.pi/agent/extensions"/*.ts; do
    [[ -e "$item" ]] || continue
    copy_if_missing "$item" "$AGENTS_HOME/pi/extensions/$(basename "$item")"
  done
}

link_payload() {
  local src rel dest parent
  while IFS= read -r -d '' src; do
    rel="${src#"$AGENTS_SOURCE"/}"
    dest="$AGENTS_HOME/$rel"
    parent="$(dirname "$dest")"
    if ensure_directory "$parent"; then
      link_file "$src" "$dest" "$REPO_ROOT/agents/"
    fi
  done < <(find "$AGENTS_SOURCE" -type f -print0 | sort -z)
}

link_into_tool() {
  local src="$1" dest="$2"
  if [[ ! -e "$src" ]]; then
    log "SKIP source missing: $src"
    return 0
  fi
  link_file "$src" "$dest" "$AGENTS_HOME/"
}

link_skills() {
  local skill target name
  local skills_dir="$AGENTS_HOME/skills"
  [[ -d "$skills_dir" ]] || return 0
  for skill in "$skills_dir"/*/; do
    [[ -d "$skill" ]] || continue
    name="$(basename "$skill")"
    for target in "$HOME/.claude/skills" "$HOME/.pi/agent/skills"; do
      if ensure_directory "$target"; then
        link_into_tool "$skill" "$target/$name"
      fi
    done
  done
}

link_claude() {
  local claude_dir="$HOME/.claude" style
  ensure_directory "$claude_dir" || return 0
  link_into_tool "$AGENTS_HOME/AGENTS.md" "$claude_dir/CLAUDE.md"
  link_into_tool "$AGENTS_HOME/statusline.sh" "$claude_dir/statusline.sh"
  for style in "$AGENTS_HOME"/output-styles/*.md; do
    [[ -e "$style" ]] || continue
    ensure_directory "$claude_dir/output-styles" || continue
    link_into_tool "$style" "$claude_dir/output-styles/$(basename "$style")"
  done
}

link_pi() {
  local pi_home="$HOME/.pi/agent" ext src agent is_omarchy=0
  if [[ -L "$HOME/.pi" && ! -e "$HOME/.pi" ]]; then
    log "SKIP $HOME/.pi is a broken symlink"
    return 0
  fi
  if [[ -e "$HOME/.pi" && ! -d "$HOME/.pi" ]]; then
    log "SKIP $HOME/.pi exists but is not a directory"
    return 0
  fi
  ensure_directory "$pi_home" || return 0

  link_into_tool "$AGENTS_HOME/AGENTS.md" "$pi_home/AGENTS.md"
  link_into_tool "$AGENTS_HOME/pi/ollama-cloud.json" "$pi_home/ollama-cloud.json"
  link_into_tool "$AGENTS_HOME/pi/web-search.json" "$pi_home/web-search.json"
  link_into_tool "$AGENTS_HOME/pi/sandbox.json" "$pi_home/sandbox.json"

  if ensure_directory "$pi_home/extensions"; then
    for ext in "$AGENTS_HOME"/pi/extensions/*.ts; do
      [[ -e "$ext" ]] || continue
      link_into_tool "$ext" "$pi_home/extensions/$(basename "$ext")"
    done
  fi

  if command -v omarchy >/dev/null 2>&1 || [[ -d "$HOME/.local/share/omarchy" ]]; then
    is_omarchy=1
  fi
  if ((is_omarchy)); then
    src="$AGENTS_HOME/pi/extensions/subagent"
    if [[ -d "$src" ]] && ensure_directory "$pi_home/extensions/subagent"; then
      link_into_tool "$src/index.ts" "$pi_home/extensions/subagent/index.ts"
      link_into_tool "$src/agents.ts" "$pi_home/extensions/subagent/agents.ts"
    fi
    if [[ -d "$AGENTS_HOME/pi/agents" ]] && ensure_directory "$pi_home/agents"; then
      for agent in "$AGENTS_HOME"/pi/agents/*.md; do
        [[ -e "$agent" ]] || continue
        link_into_tool "$agent" "$pi_home/agents/$(basename "$agent")"
      done
    fi
  else
    log "Skipping Omarchy-only Pi subagent links"
  fi
}

if ! ensure_directory "$AGENTS_HOME"; then
  log 'Cannot use ~/.agents; stopping.'
  exit 0
fi

if ((DRY_RUN)); then
  log 'Dry run: no files will be changed; settings merges and Pi package installs are not run.'
fi
migrate_legacy_payload
link_payload
link_claude
link_pi
link_skills

if ((DRY_RUN)); then
  exit 0
fi

"$REPO_ROOT/scripts/merge-claude-settings.sh"
"$REPO_ROOT/scripts/merge-pi-settings.sh"
"$REPO_ROOT/scripts/install-pi-extensions.sh"
log 'Installation complete.'
