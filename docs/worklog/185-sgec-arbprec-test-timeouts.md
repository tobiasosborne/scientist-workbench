# 185 — arb-prec test timeouts: barnes-g recurrence + complex-Y timeout bump (closes `sgec`)

**Date:** 2026-06-26.
**Bead:** `scientist-workbench-sgec` — *arb-prec test timeouts under
full-suite load: barnes-g functional-equation + bigCBesselY T5 golden brush
5000ms*.
**Ground truth:** `packages/bigfloat/src/special-funcs/barnes-g.ts`
(the back-shift loop), `packages/bigfloat/src/complex.ts` (the complex-Y
AMOS rotation), `docs/worklog/183-m9ty-bessely-integer-nu-perf.md` (the K
"load-bearing boost" finding this shard reuses).

## Context

A full `bun test packages/bigfloat/` run surfaced 3 timeouts, all in files
*other* than the `m9ty` real-`bessely` ones (worklog 183): two `barnes-g`
functional-equation tests (`G(0.7+1)` ≈ 10.8 s, `G(1.3+1)` ≈ 5.9 s) and one
complex golden, `bigCBesselY` T5-bessely-009 `Y_3(1.09+0.61i)` ≈ 5.0 s.
`barnes-g.test.ts` passed 24/24 in isolation (22.6 s), so these were
load-dependent — heavy arb-prec tests brushing the 5000 ms default under
23-file parallel contention. The bead offered the standard fork: speed up
the hot path, or (if the cost is irreducible) raise the per-test timeout.
Profiling showed the two functions need **different** answers.

## What changed

**1. `barnes-g.ts` back-shift loop — algorithmic (the speed-up).** For real
non-integer `z ∈ (0, z_shift]`, `bigBarnesG` shifts `z` up into the
Stirling-asymptotic regime and recovers `log G(z)` from `log G(z+N+1)` by
subtracting `Σ_{k=0}^{N} log Γ(z+k)`, where `N ≈ 0.17·prec` (= 34 at
prec=200). The loop computed **N+1 independent `lgamma` calls**. Profiling at
work = prec+64 = 264 bits:

| op | cost |
|---|---|
| 36 × `lgamma(·, 264)` | **1383 ms** |
| 36 × `log(·, 264)` | **23 ms** |

`lgamma` (a Stirling expansion with its own internal shift) is **~60× a
`log`**. So the sum dominated `bigBarnesG` (982 ms for z=0.7, of which
~860 ms was the loop). The fix walks the exact recurrence
`log Γ(w+1) = log Γ(w) + log w` along the integer ladder z, z+1, …, z+N:
evaluate `log Γ(z)` **once**, then accumulate `N` cheap `log` increments.
The recurrence is well-conditioned — every increment `log(z+k)` with
z+k ≥ 1 is positive, so there is no cancellation, only ~N·2^−work additive
rounding (far below the prec floor). Result: the sum is **~14× faster** and
**byte-identical to ≥ 60 dp** (validated prec=200), so every golden / gold
/ functional-equation test is unaffected.

**2. `complex-bessel-jy.test.ts` golden-master timeouts — bump (the honest
non-fix).** The complex `bigCBesselY` is *not* a removable double-count. For
complex z it uses the algebraic AMOS **K(iz)+J rotation**
(`complex.ts:2900`: `bigCBesselK` + `bigCBesselJ` at work = prec+32+phase) —
the very rotation the real-`Y` header defers to v0.2. Its integer-ν cost
lives inside complex-`K`'s limit-via-ε path, whose working-precision boost is
**load-bearing** — exactly the `m9ty` finding (K's folded connection has a
second, unmeasurable cancellation site; the boost is not redundant). At
`PREC_120DP = 400` bits, ν=3, the rotation is ~3–6 s/test — irreducible and
correct. So the two `bigCBesselJ`/`bigCBesselY` golden-master loops get a
per-test timeout bump (5000 → 30 000 ms) with a comment, mirroring the
`eoei` `beforeAll(…, 30_000)` warm-up precedent.

## Why these choices

**Two root causes, two fixes — don't reach for one hammer.** It would have
been easy to bump *all* four timing-tests' timeouts and move on. But
`barnes-g` had genuine redundant work (N expensive `lgamma` where 1 + N cheap
`log` suffice) — a senior-engineer fix in the spirit of `m9ty`, byte-identical
and ~9× on the test file. Conversely, the complex-`Y` cost is the *right*
algorithm doing irreducible work; "optimising" it would mean rewriting the
AMOS rotation, out of scope and unnecessary. A timeout bump is the honest tool
there, and the bead explicitly sanctions it.

**Reuse the `m9ty` proof rather than re-deriving it.** Before bumping, I
checked whether complex-`Y`'s integer-ν path had the same removable
double-count as real-`Y`. It does not — it routes through complex-`K`'s
limit, and `m9ty`'s red-team already proved K's boost is load-bearing. The
timeout comment cites that finding so the next reader does not re-attempt the
"obvious" optimisation.

## Frictions surfaced

- **The barnes-g comment already warned against the slow shape.** Line ~611
  noted an earlier draft's `+64 + 8·N` precision bump "ran 3× slower because
  the asymptotic-series loop *and* the `lgamma` shift loops both inflate with
  work" — yet the `lgamma`-per-step shift loop itself was never collapsed.
  The recurrence was hiding in plain sight in the module's own functional
  equation (`log G(z+1) = Γ(z)·G(z)` ⇒ the `log Γ` ladder telescopes).
- **`PREC_120DP = 400`, not 200.** The complex golden tests run at double the
  default substrate precision, so my first 200-bit profile (1.8 s) understated
  the real per-test cost (~5 s) — the timeout was being brushed in isolation,
  not only under load. Worth re-profiling at the test's actual precision
  before classifying a timeout as "load-only".

## Acceptance

- `bun test …/barnes-g.test.ts` (isolation): **22.6 s → 2.40 s**, 24/24 pass;
  `bigBarnesG(0.7)` 982 ms → 209 ms; `G(2.5)` byte-identical to the mpmath
  gold (`0.94757390108382577688415…`).
- **Mutation-proof**: replacing the ladder increment `log(zk)` with
  `log(zk+1)` (off-by-one) drove **4 of 5** functional-equation tests RED
  (the 5th is a large-z N=0 case where the loop never runs). Restored → GREEN.
- Full `bun test packages/bigfloat/` (under load): **1188 pass / 0 fail**
  (was 1185 / 3), and **168.7 s** (was 246.7 s — 32% faster overall, since
  the barnes-g speed-up also relieved the parallel contention that was
  pushing the complex-Y golden over the line). All 3 timeouts gone.
- `bun run check`: **109 passed / 7 skipped / 0 failed** (exit 0). The
  workspace `bun test` phase — which runs the full bigfloat suite — is now
  deterministically green; the intermittent timeout class `sgec` tracked is
  resolved.

## Pointers

- Speed-up: `packages/bigfloat/src/special-funcs/barnes-g.ts` (back-shift
  loop in `bigBarnesG` — the `lgamma`→recurrence collapse).
- Timeout bump: `packages/bigfloat/test/complex-bessel-jy.test.ts` (both
  golden-master loops, `}, 30_000)`).
- Irreducibility rationale: `complex.ts:2900` (the K(iz)+J rotation) +
  `docs/worklog/183-m9ty-bessely-integer-nu-perf.md` (K's load-bearing boost).
- The `eoei` timeout-bump precedent: `docs/worklog/178-gamma-v02-hardening.md`.
