# dotagents

Project-specific instructions for AI assistants working in this repository.

## What This Is

This is Fabio Rehm's personal agent configuration. It is personal software, built for his own workflow rather than offered as a general-purpose product. The repository is licensed under MIT; see [LICENSE](LICENSE).

This repository is plain files plus a Bash installer. It does not use chezmoi. Keep it scoped to agent configuration rather than general host configuration.

## Layout and Workflow

- `agents/` contains the canonical shared payload. Keep additions there and expose tool-specific entries through `install.sh`.
- `config/` holds machine-local settings merge fragments.
- `scripts/` holds settings, extension, and vendor helpers.
- Run `./install.sh --dry-run` to preview link operations. Do not run the normal installer from this assistant, because it changes the user's home directory.
- Run `make check` for shell formatting, shellcheck, and TypeScript formatting.
- Do not commit or push unless Fabio explicitly asks.

## Installer Safety

- Preserve existing real files and links that dotagents does not own. `--adopt-identical` is an explicit opt-in to replace only files whose bytes match the repository payload.
- Link individual files and skill directories; never replace whole tool configuration directories.
- Preserve machine-local Pi packages/models and Claude settings while applying only the managed settings fragment.
- Migrate legacy agent payload into `~/.agents/` only when the destination is absent.
- Keep the Pi subagent example and `rpiv-ask-user-question` Omarchy-only. Container/VM hosts typically use bb, which provides its own agent tooling.
- Third-party vendored files must be refreshed through their vendor scripts, not edited by hand.

## Style

- Executed shell scripts use `#!/usr/bin/env bash`; sourced fragments have no shebang and declare `# shellcheck shell=bash`.
- Use 2-space indentation.
- Shell scripts must be idempotent and must not overwrite user-owned files.
