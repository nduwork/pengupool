HARNESS ?= auto
CLAUDE_SETTINGS ?= $(HOME)/.claude/settings.json
STEP_STATUS_HOME ?= $(HOME)/.claude/step-status
BIN := $(STEP_STATUS_HOME)/bin
PI_AGENT ?= $(HOME)/.pi/agent
CLAUDE_SKILLS ?= $(HOME)/.claude/skills
TRACKER_CC := $(if $(filter pi,$(HARNESS)),,1)
TRACKER_PI := $(if $(filter pi both,$(HARNESS)),1,$(if $(filter auto,$(HARNESS)),$(shell command -v pi >/dev/null && echo 1)))
WT := skills/workflow-tracker/scripts
SCRIPTS := steps.sh statusline.sh capture_context.py hook_session_start.sh hook_prompt.sh wire_statusline.sh
WIRE_ENV := CLAUDE_SETTINGS="$(CLAUDE_SETTINGS)" STEP_STATUS_HOME="$(STEP_STATUS_HOME)"

EXT := extension
UV ?= uv
# Three-day dependency cooloff as an absolute RFC 3339 time: older uv releases reject relative durations.
EXCLUDE_NEWER := $(shell python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=3)).isoformat(timespec='seconds'))")
UV_INSTALL_FLAGS ?= --refresh --exclude-newer "$(EXCLUDE_NEWER)"
PENGUPOOL ?= pengupool
EDITOR_CLI ?=
EDITOR_RUN = EDITOR_CLI="$(EDITOR_CLI)" python3 scripts/editor_cli.py
VSIX ?= $(or $(TMPDIR),/tmp)/pengupool-local.vsix

.PHONY: install uninstall check-install install-all uninstall-all install-hooks uninstall-hooks install-tracker uninstall-tracker install-pool-groups uninstall-pool-groups install-skill-repo uninstall-skill-repo selfcheck test ext-deps ext-test ext-compile ext-package ext-install ext-uninstall

install:
	$(UV) tool install --force $(UV_INSTALL_FLAGS) .
	CLAUDE_SETTINGS="$(CLAUDE_SETTINGS)" "$(PENGUPOOL)" setup $(HARNESS)
	$(MAKE) install-tracker
	$(MAKE) install-pool-groups
	$(MAKE) install-skill-repo

check-install:
	CLAUDE_SETTINGS="$(CLAUDE_SETTINGS)" "$(PENGUPOOL)" setup --check $(HARNESS)

install-all:
	$(EDITOR_RUN) --check
	$(MAKE) install
	$(MAKE) ext-install

uninstall-all:
	$(MAKE) ext-uninstall
	$(MAKE) uninstall

install-hooks:
	CLAUDE_SETTINGS="$(CLAUDE_SETTINGS)" "$(PENGUPOOL)" install-hook

uninstall-hooks:
	CLAUDE_SETTINGS="$(CLAUDE_SETTINGS)" "$(PENGUPOOL)" uninstall-hook

# Copy the tracker scripts to a stable dir (the plugin cache dir changes on every update) and wire
# GLOBAL settings from there, so settings.json points at paths that survive updates. Running
# wire_statusline.sh FROM $(BIN) makes it register statusLine + SessionStart + UserPromptSubmit all
# pointing at $(BIN).
install-tracker:
	mkdir -p "$(BIN)"
	for f in $(SCRIPTS); do cp "$(WT)/$$f" "$(BIN)/$$f"; done
	chmod +x "$(BIN)"/*.sh
	$(if $(TRACKER_CC),$(WIRE_ENV) bash "$(BIN)/wire_statusline.sh")
	$(if $(TRACKER_PI),mkdir -p "$(PI_AGENT)/extensions" "$(PI_AGENT)/skills/workflow-tracker")
	$(if $(TRACKER_PI),sed 's|__STEP_STATUS_BIN__|$(BIN)|' skills/workflow-tracker/pi/workflow-tracker.ts > "$(PI_AGENT)/extensions/workflow-tracker.ts")
	$(if $(TRACKER_PI),cp skills/workflow-tracker/SKILL.md "$(PI_AGENT)/skills/workflow-tracker/SKILL.md")
	$(if $(TRACKER_PI),ln -sfn "$(BIN)" "$(PI_AGENT)/skills/workflow-tracker/scripts")
	$(if $(TRACKER_PI),@echo "workflow-tracker: pi extension + skill → $(PI_AGENT) (restart pi sessions to load)")

# The pool-groups skill is instructions only: the single write it makes (`ctl group-plan`) belongs to the
# backend, and applying a proposal stays the user's step.
install-pool-groups:
	$(if $(TRACKER_PI),mkdir -p "$(PI_AGENT)/skills/pool-groups")
	$(if $(TRACKER_PI),cp skills/pool-groups/SKILL.md "$(PI_AGENT)/skills/pool-groups/SKILL.md")
	$(if $(TRACKER_PI),@echo "pool-groups: skill → $(PI_AGENT) (restart pi sessions to load; ask for it by name)")

uninstall-pool-groups:
	rm -rf "$(PI_AGENT)/skills/pool-groups"

# The skill-repo skill ships its scaffold script and templates, so the whole directory is copied (replaced
# on update, so a removed template file does not linger). Only a copy carrying our .pengupool marker is
# replaced or removed: a user's own skill that happens to be called skill-repo is left alone.
OWN_SKILL_REPO = [ ! -e "$(1)" ] || [ -f "$(1)/.pengupool" ]
put_skill_repo = if $(OWN_SKILL_REPO); then rm -rf "$(1)" && mkdir -p "$(2)" && cp -R skills/skill-repo "$(1)" \
	&& touch "$(1)/.pengupool" && echo "skill-repo: installed in $(1) (ask for it by name, e.g. \"new skill repo\")"; \
	else echo "skill-repo: $(1) is not PenguPool's; left alone" >&2; fi

install-skill-repo:
	$(if $(TRACKER_CC),@$(call put_skill_repo,$(CLAUDE_SKILLS)/skill-repo,$(CLAUDE_SKILLS)))
	$(if $(TRACKER_PI),@$(call put_skill_repo,$(PI_AGENT)/skills/skill-repo,$(PI_AGENT)/skills))

uninstall-skill-repo:
	@for d in "$(CLAUDE_SKILLS)/skill-repo" "$(PI_AGENT)/skills/skill-repo"; do \
		if [ -f "$$d/.pengupool" ]; then rm -rf "$$d"; fi; done

# Unwires both harnesses whatever HARNESS is: removing only our own files and settings entries is safe.
uninstall-tracker:
	@if [ -f "$(BIN)/wire_statusline.sh" ]; then $(WIRE_ENV) bash "$(BIN)/wire_statusline.sh" --unwire; fi
	for f in $(SCRIPTS); do rm -f "$(BIN)/$$f"; done
	rm -f "$(PI_AGENT)/extensions/workflow-tracker.ts"
	rm -rf "$(PI_AGENT)/skills/workflow-tracker"

uninstall:
	$(MAKE) uninstall-tracker
	$(MAKE) uninstall-pool-groups
	$(MAKE) uninstall-skill-repo
	CLAUDE_SETTINGS="$(CLAUDE_SETTINGS)" "$(PENGUPOOL)" teardown both
	$(UV) tool uninstall pengupool

selfcheck:
	bash "$(WT)/wire_statusline.sh" --selfcheck
	bash "$(WT)/steps.sh" --selfcheck

# Both suites. A fresh clone or git worktree has no extension/node_modules, so run make ext-deps once.
test:
	uv run pytest -q
	$(MAKE) ext-test

# Dependency setup is explicit; routine rebuilds reuse the installed toolchain.
ext-deps:
	cd "$(EXT)" && npm ci

ext-compile:
	@test -f "$(EXT)/node_modules/typescript/bin/tsc" || { echo "Run make ext-deps first." >&2; exit 1; }
	cd "$(EXT)" && npm run compile

# The tests transpile TypeScript in-process, so they need node_modules exactly like the build does.
# Without them each file that imports the source dies as a module error, not as a test failure.
ext-test:
	@test -f "$(EXT)/node_modules/typescript/bin/tsc" || { echo "Run make ext-deps first." >&2; exit 1; }
	cd "$(EXT)" && npm test

ext-package: ext-compile
	cd "$(EXT)" && npm run package -- --out "$(VSIX)"

ext-install:
	$(EDITOR_RUN) --check
	@tmpdir=$$(mktemp -d); \
	  trap 'rm -f "$$tmpdir/pengupool-local.vsix"; rmdir "$$tmpdir"' EXIT; \
	  $(MAKE) ext-package VSIX="$$tmpdir/pengupool-local.vsix" && \
	  $(EDITOR_RUN) --install-extension "$$tmpdir/pengupool-local.vsix" --force
	@echo "Reload the editor window to activate the updated extension and backend."

ext-uninstall:
	$(EDITOR_RUN) --uninstall-extension nduwork.pengupool
