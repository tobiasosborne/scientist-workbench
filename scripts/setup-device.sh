#!/usr/bin/env sh
# scripts/setup-device.sh — one-shot setup for a fresh clone.
#
# Run this once after `git clone` on any device. Idempotent: re-running
# is a no-op if the device is already set up.
#
# What it does:
#   1. Points git at .githooks/ (tracked hooks for multi-device beads
#      auto-export-on-commit + auto-import-on-merge).
#   2. Bootstraps the local beads Dolt DB from .beads/issues.jsonl
#      (the git-tracked snapshot). Non-destructive — never deletes
#      data — unlike `bd init --force`.
#
# Beads multi-device discipline lives in CLAUDE.md.
set -eu

# 1. Tracked git hooks
git config core.hooksPath .githooks
echo "✓ git core.hooksPath = .githooks"

# 2. Local beads DB from the tracked JSONL
if command -v bd >/dev/null 2>&1; then
  if [ -d .beads/embeddeddolt ]; then
    bd import .beads/issues.jsonl >/dev/null 2>&1 && \
      echo "✓ bd: imported .beads/issues.jsonl into existing DB" || \
      echo "! bd import failed; check 'bd doctor'"
  else
    bd bootstrap --yes >/dev/null 2>&1 && \
      echo "✓ bd: bootstrapped DB from .beads/issues.jsonl" || \
      echo "! bd bootstrap failed; run manually: bd bootstrap --yes"
  fi
else
  echo "! bd not on PATH — install from https://github.com/steveyegge/beads"
fi

echo
echo "Setup complete. Try: bd ready"
