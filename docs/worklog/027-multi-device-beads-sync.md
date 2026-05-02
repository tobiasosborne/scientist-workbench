# 027 — Multi-device beads sync via tracked git hooks

**Date:** 2026-05-02
**Status:** complete
**Branches:** main
**Commits:** ef7dc19 (track beads state), 0cc0a16 (automate sync)
**Issues:** none filed (the work itself is infra; see Frictions for
the issue-tracker drift this fixed)

## Context

Worklogs 024 (TS-native frontend DSL → ADR-0009) and 025 (Grover
end-to-end) both shipped without beads tracking. Their footers said:

> none — beads db not initialised; the user warned against `bd init`
> because a previous agent had broken it

That warning was wrong-but-load-bearing. The DB on the primary
device was fine; the problem was that nothing under `.beads/` had
ever been committed to git, so a fresh agent on a second device saw
an empty directory, no remote, no metadata, no project_id. They
tried `bd init`, broke things, and the resulting "don't touch beads"
warning bled into every subsequent worklog. The user named this
exactly: *"important info FROM THIS device about beads was absent
or not findable."*

This shard documents the fix.

## What changed

**`.git/info/exclude`** — the `.beads/` line was deleted. That line
was added by `bd init --stealth` and was the actual structural
blocker: no matter what `.beads/.gitignore` said, the per-clone
exclude was a hard veto on every file under `.beads/` ever being
added to git. Confirmed via `git check-ignore -v`. Replaced with a
prose comment explaining the lift.

**`.beads/.gitignore`** — added `embeddeddolt/` to the list of
excluded subdirectories. The original list excluded `dolt/` (an
older directory name) but missed `embeddeddolt/` (the current
binary Dolt-DB internals). Without this, lifting the blanket
exclude would have made the binary `.darc` files trackable. Closes
the loophole.

**Five files added under `.beads/` and committed**: `issues.jsonl`
(60 issues + 1 memory, exported via `bd export`), `config.yaml`,
`metadata.json` (including `project_id` so the DB identity stays
stable across clones), `README.md`, `.gitignore`. Per-machine
runtime files (`embeddeddolt/`, `backup/`, `interactions.jsonl`,
`push-state.json`, `last-touched`, `.local_version`, locks) stay
gitignored.

**`.beads/config.yaml` flipped `no-git-ops: true` → `false`.**
Stealth-mode concerns were specifically about *push* semantics, not
about local hooks calling `bd export`. The `true` value was
preventing the bd-installed hooks from running their internal git
ops. With `false` they run; nothing gets pushed without `git push`.

**`.githooks/` (new tracked directory)** — five hook scripts
(`pre-commit`, `post-merge`, `pre-push`, `post-checkout`,
`prepare-commit-msg`). Two carry custom prelude/postlude wrappers:

- `pre-commit` runs `bd export -q -o .beads/issues.jsonl` and
  `git add .beads/issues.jsonl` *before* the bd shim, so every
  commit carries a current snapshot of issues + memories.
- `post-merge` runs `bd import .beads/issues.jsonl -q` *after* the
  bd shim, so a `git pull` brings the local DB up to date with
  whatever the other device just shipped.

Both wrappers no-op cleanly when the local DB or JSONL is missing
(fresh-clone safety) and use `2>/dev/null || true` so they never
fail a commit.

**`scripts/setup-device.sh` (new)** — one-shot per-device setup:

```sh
git config core.hooksPath .githooks
bd bootstrap --yes    # auto-imports .beads/issues.jsonl
```

`bd bootstrap` is the *non-destructive* sibling of `bd init`. The
docstring is explicit that it never deletes data — it auto-detects
`.beads/issues.jsonl`, imports it, and sets up the local Dolt DB.
This is the command that should have been documented before, and
its absence is what scared agents off touching beads at all.

**`CLAUDE.md` Rule 9** — extended with a "Multi-device sync"
subsection naming `bd bootstrap` (not `bd init --force`) as the
correct fresh-clone command, documenting the auto-export /
auto-import hooks, and pointing at `scripts/setup-device.sh` for
fresh-clone setup. The "don't run `bd init`" warning is now in the
canonical spot rather than passed by oral tradition through worklog
footers.

**`README.md` "File layout"** — `scripts/setup-device.sh` and
`.githooks/` rows added (lockstep doc update per Law 2).

## Why these choices

**JSONL-via-git, not Dolt-remote-push.** Beads supports two
multi-device paths: (a) `bd dolt push` to a remote Dolt server,
which requires `git+ssh://` configured remote and a Dolt-aware
endpoint; (b) `bd export` to `.beads/issues.jsonl` tracked in git.
Path (a) needs DoltHub or self-hosted Dolt; path (b) needs nothing
beyond the existing GitHub remote. For a stealth-mode single-user
project, (b) is dramatically simpler. The `.beads/issues.jsonl`
filename is privileged — `bd import` defaults to it, the man page
calls it "the git-tracked export."

**`.githooks/` (tracked) over `.git/hooks/` (per-machine).** Hooks
under `.git/hooks/` are not committed; on a fresh clone the user
would have to re-install them. Tracked hooks under `.githooks/`
plus `git config core.hooksPath .githooks` make the entire
hook setup propagate via git. The `core.hooksPath` setting itself
is per-clone (git doesn't propagate config), but it's a single line
in `setup-device.sh`.

**Wrap the bd shims, don't replace them.** The bd-installed shims
do session-prime injection, agent identity trailers, and Bun-binary
resolution. We need that. We *also* need auto-export, which the
shims don't do today (verified: `bd hooks run pre-commit` returns
silently and the JSONL stays stale). The wrapper pattern keeps both:
custom prelude/postlude before/after the bd shim, with `|| true`
to ensure either side's failure doesn't block the commit.

**Make `bd bootstrap`, not `bd init`, the canonical command.** The
user surfaced this directly: a previous agent broke `bd init` (or
believed it broke), the warning generalised to "don't use beads,"
and the project's tracker silently fell two worklogs behind. The
fix isn't just documentation — it's pointing at the *correct* tool.
`bd bootstrap` literally cannot delete data ("Unlike `bd init
--force`, bootstrap will never delete existing issues"). Making it
the named command in `setup-device.sh` and CLAUDE.md removes the
attractor that produced the original failure.

**Memory lives alongside issues in the same JSONL.** `bd export`
includes both. `bd remember` writes propagate cross-device. So a
session insight saved on device A becomes available to an agent on
device B after the next pull. This was tested end-to-end — the
"multi-device-beads" memory written during this session rode along
in the commit's `.beads/issues.jsonl` change.

## Frictions surfaced

**1. The blocker was per-clone, not per-tree.** First diagnosis
attempt looked at `.beads/.gitignore` and `git ls-files .beads/`,
saw "nothing under .beads/ is tracked," and assumed the issue was
just "nobody ran `git add`." Wrong. `git check-ignore -v
.beads/issues.jsonl` revealed the actual culprit:

```
.git/info/exclude:9:.beads/	.beads/issues.jsonl
```

`bd init --stealth` had set a blanket `.beads/` line in
`.git/info/exclude` — git's per-clone exclude file, separate from
any tracked `.gitignore`. No `git add` would have ever worked. *Lesson:*
when files mysteriously refuse to be tracked, `git check-ignore -v`
points at the actual rule, including `.git/info/exclude`. Don't stop
at the visible `.gitignore` files.

**2. `no-git-ops: true` was preventing the bd hooks from doing
anything.** After installing hooks via `bd hooks install`, the
pre-commit shim ran (`bd hooks run pre-commit` returned silently)
but the JSONL stayed stale. Smoke-tested by adding a memory,
running the hook, hashing the file before and after — identical.
Found the gating config in `.beads/config.yaml`. Even after flipping
it, the bd-managed shim still didn't auto-export — confirmed by
running `bd export` to a different path and diffing. The bd shims
do session-prime / identity / etc., not export. The custom wrapper
pattern is the necessary addition. *Lesson:* don't trust the
hook-installed message; smoke-test by mutating state and watching
for the diff.

**3. Bd-managed hooks have version markers ("BEGIN BEADS
INTEGRATION v1.0.0"). Custom edits between markers would be
overwritten on `bd hooks install`.** The wrapper pattern adds
custom blocks *outside* the markers (a SCIENTIST-WORKBENCH-prefixed
prelude/postlude with its own BEGIN/END markers). This survives bd
upgrades cleanly. Worth flagging because future agents might be
tempted to edit inside the bd markers and lose their changes
silently next time the bd version bumps and a `bd hooks install`
gets run.

**4. Dolt commit hash didn't tell the whole story.**
`.beads/push-state.json` recorded a successful Dolt push at
2026-04-29 12:30. That was technically true — the *last attempted
push* succeeded — but no further beads operations had happened on
this device since. So the apparent "successful sync" was
indistinguishable from "no work to sync." When the second device
had legitimate trouble syncing, this device's push-state file
suggested everything was fine. *Lesson:* push-state is a per-device
record of a single direction of sync; cross-device divergence isn't
visible from it.

**5. bd ID hash is not deterministic per-write.** During the
investigation I considered filing post-hoc beads issues on this
device for the worklog 024/025 work. Deferred because: bd issue IDs
are content-hashed, and the same logical issue filed on two devices
would produce two different IDs. With the JSONL sync now working,
either device can file an issue once and it propagates — no need to
double-file or reconcile. But this also means: don't pre-emptively
file the same issue on both devices in the future.

## Acceptance

- `git ls-files .beads/` lists exactly the five portable files
  (`.gitignore`, `README.md`, `config.yaml`, `issues.jsonl`,
  `metadata.json`). Binary Dolt internals are not tracked.
- `git check-ignore -v .beads/issues.jsonl` returns `exit 1` (not
  ignored).
- `git config core.hooksPath` returns `.githooks` on this device.
- `sh scripts/setup-device.sh` is idempotent — re-running it
  reports `✓ git core.hooksPath = .githooks` and `✓ bd: imported
  .beads/issues.jsonl into existing DB` without error.
- Pre-commit hook end-to-end: `bd remember "test"` → `git commit`
  produces a commit whose `.beads/issues.jsonl` file diff includes
  the new memory line, with no manual `git add`. Verified on
  commit 30193d1 (the code-health pass) — `git show --stat HEAD`
  lists `.beads/issues.jsonl` among the 11 changed files even
  though I only manually staged 10.
- Memory propagation: the multi-device-beads memory persists in
  `bd memories` after `bd export | bd import` round-trip.

## Pointers

- `.git/info/exclude:7-9` — the lift comment.
- `.beads/.gitignore:3` — `embeddeddolt/` exclusion.
- `.beads/config.yaml:1` — `no-git-ops: false`.
- `.githooks/pre-commit:2-12` — auto-export prelude.
- `.githooks/post-merge:23-32` — auto-import postlude.
- `scripts/setup-device.sh` — one-shot per-device setup.
- `CLAUDE.md` Rule 9 "Multi-device sync" subsection — the canonical
  agent-facing protocol.
- Beads memory `multi-device-beads-beads-issues-jsonl-is-tracked` —
  the cross-session reminder of the setup discipline.
- `bd bootstrap --help` — the non-destructive setup command, the
  one that should have been named in worklog 025's footer.

## Open questions

- **Should the `core.hooksPath` setting be auto-applied on first
  use?** Today it's a one-line setup-device.sh step, which means a
  fresh clone with `git pull` will *not* auto-import beads until
  setup-device.sh has been run. Possible: a `direnv`-style auto-init
  on `cd`, or a check in the bd-installed hooks themselves. Out of
  scope for this iteration.
- **Memory namespace conflicts across devices.** Two agents
  remembering different things under similar keys on different
  devices will round-trip-merge whichever was committed last. No
  conflict-detection logic. Probably fine in practice (single-user
  project, low write frequency) but worth flagging.
- **Worklog shards are committed normally and survive across
  devices unchanged. Beads issues filed for *new* work after this
  point will sync correctly, but issues 024/025 deserve don't have
  retrospective beads entries.** Filing them now would be
  cosmetic — the worklog shards already document the work — but
  the closed-issues view would tell a more complete story. Punted
  for the user to decide.
