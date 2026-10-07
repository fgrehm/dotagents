# dotagents

Personal agent configuration for Fabio Rehm. This is personal software for my own workflow, not a general-purpose distribution.

The repo contains shared agent instructions, skills, Claude Code presentation files, and Pi settings/extensions. It is plain files plus a Bash installer; it does not require chezmoi or chezmoi-recipes.

## Install

Clone the repo and run:

```sh
./install.sh
```

Preview filesystem changes first with:

```sh
./install.sh --dry-run
```

The installer creates individual links into `~/.agents/`, `~/.claude/`, and `~/.pi/agent/`. It leaves existing real files and links it does not own untouched. To replace existing files only when they are byte-identical to the repo payload, opt in with `./install.sh --adopt-identical`. Existing settings remain machine-local: Claude settings are merged with the managed base, and only the managed presentation keys are upserted in Pi settings.

The installer also migrates legacy statusline, output-style, provider, and top-level Pi extension files into `~/.agents/` when those destinations are absent.

## Update

Pull the latest changes and run `./install.sh` again. The links point into this checkout, so keep the clone at a stable path.

## Checks

Run `make check` for shell and TypeScript checks. Use `make install` to install and `make dry-run` to preview.

## License

MIT. See [LICENSE](LICENSE).
