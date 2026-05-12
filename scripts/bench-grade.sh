#!/usr/bin/env bash
# Run a corpus-side bench grading from the workbench root.
#
# The bench corpora live in `scientist-workbench-corpus`, side-by-side with
# this repo (ADR-0028). This shim resolves the corpus root and invokes the
# corpus grader without requiring the developer to `cd` between repos.
#
# Usage: scripts/bench-grade.sh <tool>
# Example: scripts/bench-grade.sh linalg-eigh
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tool>" >&2
  exit 2
fi

CORPUS_ROOT="$(cd "$(dirname "$0")/../../scientist-workbench-corpus" && pwd)"
exec bun "$CORPUS_ROOT/src/cli.ts" grade scientist-workbench "$1"
