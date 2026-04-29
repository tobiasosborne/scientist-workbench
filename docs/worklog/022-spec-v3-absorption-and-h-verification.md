# 022 — Sturm-TS v3 spec absorbed; §8.1 H-derivation verified buggy

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-4xk (closed); scientist-workbench-{1td, r40,
  4iw} (filed)

## Context

Phase 0 of the Sturm-TS port (shard 009) closed `principles.md` and
the three ADRs (0005, 0006, 0007) but left the spec body itself
"pending external paste." The v3 PRD lived in the user's session
transcript; `docs/sturm-ts/README.md` flagged this as remaining open
work. This shard records two pieces of that absorption:

1. **The spec under repo control.** Verbatim paste with an adapter
   preamble noting (a) this is v3, not v3.1 — the v3.1 amendment to
   P2 lives in `principles.md` and supersedes — and (b) five open
   adaptation items found during the read-through.

2. **The §8.1 library derivations verified numerically.** A reading
   of the spec's `H(q) := ry(π/2); ry(π)` and `not(QBool) := ry(π)`
   under `tools/sturm-execute`'s convention `Ry(θ) = exp(-iθ/2 Y)`
   suggested both were mis-derived. The user flagged that "everything
   is up to a phase" and that this kind of question has caught agents
   on `Sturm.jl` analogues before — needs a numerical run, not an
   armchair audit. The numerics confirmed the bug.

## What changed

`docs/sturm-ts/spec-v3.md` (new) — verbatim v3 spec body wrapped in a
top-of-file blockquote preamble. The preamble cross-references
`principles.md` (v3.1) and lists five open items: §8.1 library
verification (issue 4xk → 1td), tracer constraints inside `when`
(r40), `run()` ↔ workbench-pipeline bridge (4iw), Bennett-TS
dependency (captured in q0b's notes), and §12 Backend interface
out-of-scope for the workbench port. `docs/sturm-ts/README.md`
updated: spec-v3.md row goes from "pending external paste" to
"landed (v3 verbatim, with adapter preamble)."

`scripts/probe-h-equivalence.ts` (new, kept) — reproducible
verification driver. Two probes that distinguish real-H from the
`Ry(3π/2)` operator the spec's two-step `H` actually composes to:

```
Probe 1 (H·H = I):  prepare(0); ry(π/2); ry(π); ry(π/2); ry(π); observe
  real-H:    P(r=0) = 1   (H·H = I)
  Ry(3π/2):  P(r=1) = 1   (Ry(3π) = iY, |0⟩ → -|1⟩)

Probe 2 (H·Z·H = X):  prepare(0); H; rz(π); H; observe
  real-H:    P(r=1) = 1   (HZH = X, |0⟩ → |1⟩)
  Ry(3π/2):  P(r=0) = 1   (composes to ≈ -iZ, |0⟩ stays at |0⟩)
```

Numerical run via `spawnBun` against `tools/sturm-execute`:

```
Probe 1: r=1 prob 1.0    ← Ry(3π/2)² prediction
Probe 2: r=0 prob 1.0    ← Ry(3π/2)·Z·Ry(3π/2) prediction
```

Both predict opposite outcomes from real-H; both confirm the bug.

`scientist-workbench-4xk` closed; **`scientist-workbench-1td` filed**
(P2 bug) with a full audit:

| Library def | Status |
|---|---|
| `Z := rz(π)` | ✓ correct (off by global phase −i) |
| `S := rz(π/2)` | ✓ correct (off by global phase) |
| `T := rz(π/4)` | ✓ correct (off by global phase) |
| `not := ry(π)` | ⚠ off from X by Z (relative phase, not global) — indistinguishable on standard-basis input but coherently distinct |
| `H := ry(π/2); ry(π)` | ✗ composes to Ry(3π/2), provably ≠ H by any phase factor |
| `Y := rz(π); ry(π)` | ✗ composes to ≈ X (off by global phase), not Y |

1td carries two design options: **Option A** (ZYZ replacements like
`H := rz(π); ry(π/2)` — coherently correct, costs one extra op per
H/not/Y) vs **Option B** (keep ry-only forms with documented
"differs from X by Z" caveats; H still must change since it cannot
be written in the Ry-only family). Recommendation: A. Decision
deferred to the user.

Two more beads filed at preamble time:

- **r40** (P2) — q0b prerequisite. ADR-0006 admits `controls` only on
  `ry`/`rz`; the tracer must reject `observe`/`cases`/`discard`/
  `prepare` inside a `when` body. Includes defense-in-depth at
  `packages/sturm-ir/src/wellformed.ts`. Wired as `q0b depends on r40`.
- **4iw** (P3) — `run()` ↔ workbench-pipeline bridge. The spec's
  `RunResult<O>` shape predates ADR-0007's distribution-vs-sampling
  split. q0b only emits IR; reconstructing `RunResult<O>` is downstream.

q0b's notes were amended with the Bennett-TS dependency note (no
`@bennett/core` in the ecosystem yet → boundary-fail on user code
that calls `oracle()`).

## Why these choices

**Verbatim paste with preamble.** The spec is the primary design
artefact; editing the body to apply later amendments creates drift
between the spec-as-written and the spec-as-supplemented. Adapter
notes live in the preamble; design amendments live in adjacent
documents (`principles.md`, the ADRs) and beads issues. Pasting
verbatim preserves provenance from the source transcript so a future
reader can recover what the spec actually said.

**4xk filed as needs-verification, not assumed-bug.** The reading
of §8.1 looked unambiguous to me — `Ry(π) ≠ X up to global phase`
under the textbook convention; H cannot be written from Ry alone
since Hadamard's Bloch axis is `(X+Z)/√2`. But the user warned that
similar-looking analyses have caught agents on `Sturm.jl` before
("everything is up to a phase"). Filed as a verification task with
two distinguishing probes; left the bug-vs-not-bug decision to the
numerical run. Worth the extra step — the principle is "skepticism
over memory" (CLAUDE.md Rule 3).

**Probe design for byte-equal distinguishability.** Probes had to
exercise composition where the relative phase shows on standard-
basis measurement statistics — Bell-pair / GHZ goldens won't
distinguish (both circuits use only standard-basis prep + standard-
basis measurement, where the Ry(π) vs X relative phase is invisible).
The two probes use post-composition measurements: H·H is supposed to
be I on |0⟩ (so |0⟩ stays |0⟩); H·Z·H is supposed to be X on |0⟩ (so
|0⟩ → |1⟩). Both probes give opposite predictions between real-H
and Ry(3π/2), so one run resolves it.

**Two design options for 1td (not a unilateral fix).** Choosing
between "always coherent" (Option A) and "standard-basis OK with
documented caveat" (Option B) is a real design call about library
ergonomics, not a mathematical question. Filed both with
justifications; left the call to the user.

**Bennett-TS dependency in q0b notes (not a separate beads).** It's
a scope-clip on q0b, not its own work item. Capturing it as a note
on the parent issue is the right granularity.

## Frictions surfaced

- **The placeholder ID dance.** Wrote spec-v3.md preamble with
  `<follow-up id>` placeholders for the as-yet-unfiled 1td. Filed 1td
  after closing 4xk, then forgot to grep for the placeholder until
  the next edit cycle. Mechanical; lesson: file the issue first, then
  write the doc with the real ID inline (which is what I did for the
  other four IDs).

- **`spawnSync` from `node:child_process` failed silently.** First
  pass on `probe-h-equivalence.ts` used `spawnSync("bun", [path], {
  input, encoding: "utf8" })`; the call returned `status: undefined`
  with `stderr: null`. Switched to `spawnBun` from `@workbench/contract`
  (per ADR-0001, the resolver that handles snap-Bun's mount-namespace
  corner). Re-learned lesson from shard 002 — `spawnBun`, never
  `node:child_process`.

- **§8.1 audit found three issues, not just `H`.** The original 4xk
  framed only the H derivation as suspect. While walking the rest of
  the library to verify the audit was complete, `not` and `Y` also
  fell out as misderived (different ways): `not` is X·Z (off by
  relative phase Z; standard-basis bit-flip OK, coherently distinct
  from X), and `Y := rz(π); ry(π)` composes to ≈ X (state-app order
  ry·rz = -iY · -iZ = -YZ = -i·X), not Y. Fixed in the 1td issue body.

- **§13.4 phase-kickback comment is misleading regardless of fix
  path.** The example has `ry(q, π/2) // = H, via library`. Ry(π/2)
  is **not** H in general; what's true is `Ry(π/2)|0⟩ = |+⟩`, which
  is what the use-case wants. Should be reworded to "prepares |+⟩
  from |0⟩." Captured in 1td's pitfalls.

- **§5.2 `RunResult<O>` predates ADR-0007.** The monolithic `run()`
  shape returns `{output, measurements, shots}` — that's the v3
  PRD's pre-split design. The workbench factored it into
  sturm-execute (analytic distribution) and sturm-sample (samples
  given entropy). q0b only emits IR; reconstructing `RunResult<O>`
  is a wrapper-tool / runtime-package design. Filed as 4iw to surface
  before q0b implementation begins.

- **§12 Backend interface fundamentally mismatches the workbench
  substrate.** Spec has stateful `StateHandle`-lifecycle (alloc/free,
  async). Workbench is stateless tools. The "tracing" backend (§14)
  is the only slice relevant to q0b; `native()` / `density()` are
  out-of-scope. Captured in preamble item 5; not a beads (it's
  framing, not a work item).

## Acceptance

- `docs/sturm-ts/spec-v3.md` landed verbatim with preamble.
- `docs/sturm-ts/README.md` updated (row marked landed).
- `scripts/probe-h-equivalence.ts` retained as reproducible verification.
- 4xk closed with verification result attached.
- 1td filed (P2 bug) with both design options.
- r40 filed (P2, q0b prerequisite) and dep-wired.
- 4iw filed (P3, q0b-adjacent ergonomics).
- q0b notes amended with Bennett-TS dependency.
- `bun run check`: 29 phases green throughout (the spec/preamble
  changes don't touch tool code paths).

## Pointers

- `docs/sturm-ts/spec-v3.md` — verbatim spec + adapter preamble.
- `docs/sturm-ts/principles.md` — v3.1 amendment to P2 (supersedes spec §1).
- `docs/adr/0006-sturm-ir-as-value.md` — the IR encoding the spec §6 mirrors.
- `scripts/probe-h-equivalence.ts` — the verification driver.
- `tools/sturm-execute/tool.ts:408` — the `Ry(θ) = [[cos(θ/2), -sin(θ/2)], [sin(θ/2), cos(θ/2)]]` definition that the spec's library derivations don't survive.
- Issues: 4xk (closed), 1td (open, P2 bug), r40 (open, P2), 4iw (open, P3).
- Shard 023 — channel combinators landed in the same session, building on the IR substrate the spec §4.1 / §8.2 describe.
