SHELL_FILES := $(shell find install.sh scripts agents \( -name "*.sh" -o -name "*.bash" \) -type f 2>/dev/null | sort)
TS_FILES := $(shell find agents -name "*.ts" -not -path "*/extensions/subagent/*" 2>/dev/null | sort)

.DEFAULT_GOAL := help

.PHONY: help install dry-run shell-fmt shell-fmt-check shell-lint ts-fmt-check check

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-18s %s\n", $$1, $$2}'

install: ## Install agent configuration into the home directory
	./install.sh

dry-run: ## Preview install operations without changing files
	./install.sh --dry-run

shell-fmt: ## Format shell scripts (shfmt -w)
	shfmt -w $(SHELL_FILES)

shell-fmt-check: ## Check shell formatting without modifying (shfmt -d)
	shfmt -d $(SHELL_FILES)

shell-lint: ## Lint shell scripts (shellcheck)
	shellcheck --severity=warning $(SHELL_FILES)

ts-fmt-check: ## Check TypeScript formatting (Prettier)
	bunx --bun prettier@3.6.2 --check $(TS_FILES)

check: shell-fmt-check shell-lint ts-fmt-check ## Run shell and TypeScript checks
