# 164 — V1 verification gate: Phase 4 Bessel cross-cutting test suite + mutation-proving rollup (2026-05-17)

> **Scope.** Close Phase 4 bead `scientist-workbench-g5vo` (V1 — Phase
> 4 GATE) of the World-class Bessel reference-implementation epic
> (`zcam`). Ship the cross-cutting integration test layer that
> exercises 10 invariants ACROSS substrate axes (real arbprec ×
> complex arbprec × float64 × CAS simplify × Meijer-G bridge ×
> integrate-1d), consolidate per-bead mutation-proving evidence into
> a single audit roll-up
> (`docs/refs/besselj-research/V1-mutation-proving-rollup.md`), and
> file the substrate-bug findings the V1 layer discovered as P1
> follow-ups. With this shard closed, only D1 (epic close + docs
> lockstep finalisation) remains before the epic ships.

## Context

ADR-0041 pinned the per-head special-function substrate for the
Bessel family — prototype #2 of the per-head pattern Erf (ADR-0040)
established as prototype #1. By the time this bead was claimed, all
Phase 2 substrate beads (I1a/I1b/I2a/I2b/I3a/I3b/I4/I5a/I6 +
I6-prep/I6a/I6b) and all three Phase 3 tool-integration beads
(T1 integrate-1d, T2 tools/special-eval, T3 meijer-g-symbolic-only
closure validation) were closed across 12 worklog shards (143-145,
152-163). What was missing was (1) the *composition* layer: tests
that PROVE the substrates work TOGETHER through the wire surface
(`tools/special-eval`) and adjacent tools, AND (2) a single audit
artefact consolidating the 47+ mutation perturbations distributed
across the 12 shards.

ADR-0041 §"Acceptance" pinned 10 invariants:
- 8 inherited from Erf V1 (a-h): float64-lane parity, arbprec-lane
  parity, restriction-to-real, cas-simplify pipeline, Meijer-G
  round-trip, integrate-1d end-to-end, foreign pass-through,
  determinism.
- 2 Bessel-specific (i, j): Wronskian (`J_ν · Y_{ν+1} − J_{ν+1} · Y_ν
  = −2/(πz)`) and integer-ν parity (`J_{−n} = (−1)^n · J_n` and
  family analogues).

CLAUDE.md Rule 7 ("'runs without errors' is not a passing test")
governed the test design: every assertion pins a non-trivial
invariant. Rule 6 (port-and-verify + mutation-proving) governed the
audit: the rollup must reflect the literal RED-then-restored
evidence from each shard, not paraphrase or summarise.

The styling exemplar is shard 141 (the Erf V1 gate); the rollup
template is `docs/refs/erf-research/V1-mutation-proving-rollup.md`.

## What changed

### `tools/special-eval/bessel-cross-cutting.test.ts` (NEW, 240 tests / 532 expects)

The Phase 4 Bessel cross-cutting test suite, organised into 10
invariant groups matching the bead's a-j coverage matrix:

  | Group | Invariant tested                                                                                  | Pkg span                                  |
  |-------|---------------------------------------------------------------------------------------------------|-------------------------------------------|
  | (a)   | Float64 lane wire bytes ≡ direct `besselXFloat64` (I5a) — 4 heads × 3 ν-classes × 3 z-regions    | quadrature → special-eval                 |
  | (b)   | Arbprec lane wire bytes ≡ direct `bigBesselX` @ 200 bits (I1a/I1b/I2a/I2b) — 4 × 3 × 3 + K large-z | bigfloat → special-eval                   |
  | (c)   | Complex arbprec restriction-to-real: `bigCBesselX(x+0i).re ≈ bigBesselX(x)`; im = exact 0n        | bigfloat (complex.ts ↔ special-funcs/bessel*.ts) — all 4 heads |
  | (d)   | `casSimplify` cross-head identities: H¹/H² expand to J ± i·Y; half-integer closures fire end-to-end | cas-core (I4)                             |
  | (e)   | `headToMeijerGBessel(...).argsInverse()` recovers BOTH args byte-identically (2-arg test of the I6-prep rename) | meijer-core (I6)                          |
  | (f)   | `integrate-1d` Bessel integrals match DLMF §10.22 closed forms within 1e-9                        | quadrature → integrate-1d (T1)            |
  | (g)   | `casSimplify` preserves foreign subterms inside Bessel exprs byte-identically (PRD §2.3)          | cas-core (I4)                             |
  | (h)   | 5 repeat calls at fixed (input, precision) return byte-identical output (ADR-0020 arbprec contract) | special-eval                              |
  | (i)   | Wronskian J_ν·Y_{ν+1} − J_{ν+1}·Y_ν = −2/(πz) at ν ∈ {0, 1, 2.5} × z ∈ {1, 5, 10}                | quadrature (cross-substrate J + Y tie)    |
  | (j)   | Integer-ν parity J_{−n} = (−1)^n·J_n; Y same; I_{−n} = I_n; K_{−n} = K_n at n ∈ {1, 2, 3, 5}     | quadrature + bigfloat (float64 + arbprec) |

Plus the substrate-bug XFAIL block (9 tests, `test.skip`-ped with
prominent comments linking to the V1-finding beads).

The test file lives at `tools/special-eval/bessel-cross-cutting.
test.ts` — sibling to the Erf `cross-cutting.test.ts` from shard 141,
no subdirectory (the `tsconfig.json` `include` glob is `tools/*/*.ts`,
so subdir files wouldn't be typechecked). Per worklog 141 §"Landing
site", following the established pattern. The `tools/special-eval/
package.json` already has `@workbench/cas-core` and `@workbench/
meijer-core` as devDependencies (added in worklog 141); no
package.json change needed.

Test result: **240 pass / 9 skip / 0 fail / 532 expect() calls**.
The 9 skips are documented xfails for two real substrate bugs the
V1 layer discovered (see §F1, §F2 below).

### `docs/refs/besselj-research/V1-mutation-proving-rollup.md` (NEW, ~250 lines)

The consolidated audit document. Structure:

- **Per-bead mutation summary table** — 18 rows covering 3 Phase 0
  beads (I6-prep / I6a / I6b — substrate-prep work), 6 Phase 1 beads
  (G2-G5, G7, G8 — oracle adapters; G6 deferred-not-installed per
  orchestrator decision), 6 Phase 2 substrate beads (I5a + I1a/I1b +
  I2a/I2b + I3a + I4 + I3b/I6 — note I3b ships J/Y complex separately
  from I3a's I/K complex), and 3 Phase 3 tool-integration beads (T1,
  T2, T3).
- **RED-confirmed-when** per bead — what the mutation actually broke
  (not paraphrased; lifted from the originating shard's mutation
  section).
- **Cross-bead findings** — 7 distinct surprises that surfaced
  through the mutation-proving discipline itself (R2 §3.3 ADR sketch
  deviation, I2a denominator load-bearing, I6b predicate asymmetry,
  I6-prep commit-time invariant, G7 install-instruction stale-doc fix,
  and **two new V1-cross-cutting findings**: Y half-integer sign
  bug + I negative-integer Infinity gap).
- **Total mutation-proving footprint:** **47 distinct perturbations**
  confirmed RED + restored across the epic. (Erf comparison: 23
  across 10 beads. Bessel's larger count reflects 4 heads × 2-arg
  surface + new vocab heads + AMOS complex coupling.)

### Filed P1 follow-up beads (V1 findings)

#### `scientist-workbench-i3la` (P1) — besselYFloat64 half-integer sign bug

The V1 Wronskian test (§(i)) caught a real substrate bug:
`besselYFloat64(nu, z)` returns the WRONG SIGN for half-integer ν ∈
{1.5, 3.5} across all sampled positive z (1, 2, 5, 8, 10, 15).
Magnitudes match arb-prec to ~14 dp; sign is flipped. ν ∈ {0.5, 2.5,
4.5} are correct — suggests an odd-half-integer sign branch error in
the substrate's general-ν Y path (likely in the `temme_jy` port at
`packages/quadrature/src/special-funcs/bessel-float64.ts`).

Reproducer:
```ts
import { besselYFloat64 } from "@workbench/quadrature";
console.log(besselYFloat64(3.5, 10)); // 0.24052386219565525 (WRONG sign)
// expected: -0.24052386219566083 (arb-prec at p=200)
```

This breaks the Wronskian invariant at every half-integer ν where
ν+1 lands on 1.5 or 3.5. The arb-prec substrate (I1b) is correct
— verified via the V1 test's arbprec spot-check at ν=2.5, z=5.
Blocked by `rkoo` (I5a substrate bead).

#### `scientist-workbench-tke9` (P1) — besselIFloat64 negative-integer Infinity gap

The V1 parity test (§(j)) caught a second real substrate bug:
`besselIFloat64(-n, z)` for integer n ≥ 2 returns ±Infinity. DLMF
§10.27.1 pins `I_{-n}(z) = I_n(z)` (no sign flip) — this is a
wrong-output substrate gap, not a numerical accuracy issue. n=1
works correctly; n ∈ {2, 3, 5} all return Infinity. The fix is a
top-of-function `if nu < 0 && is integer, use abs(nu)` branch
parallel to the J/Y substrate's parity handling. K substrate is
even in ν and works correctly; this is an I-specific gap. Blocked
by `rkoo`.

### `docs/worklog/README.md` (extend — shard 164 row added)

## Why these choices

### Landing site: `tools/special-eval/bessel-cross-cutting.test.ts`

The bead's prompt offered the choice between `packages/cas-core/test/
v1-bessel-cross-cutting.test.ts` and `tools/special-eval/v1-bessel-
cross-cutting.test.ts`. I chose `tools/special-eval/bessel-cross-
cutting.test.ts` (no `v1-` prefix; sibling to the existing Erf
`cross-cutting.test.ts`) for three reasons:

1. **Least-blast-radius**: `tools/special-eval` already imports
   `@workbench/cas-core` and `@workbench/meijer-core` as devDeps
   (added in worklog 141). Landing at `packages/cas-core/test/` would
   need new dep edges from cas-core to bigfloat/quadrature/special-
   eval, polluting the package import graph.
2. **Mirror the Erf precedent**: the Erf V1 test lives at the
   `tools/special-eval/` directory; an agent looking for "the V1
   cross-cutting test for X" will find both files at the same
   directory level.
3. **Test discovery**: `bun test tools/special-eval/bessel-cross-
   cutting.test.ts` is the natural invocation; the workspace `bun
   test` glob picks it up automatically.

The `v1-` prefix in the bead's filename suggestion was dropped to
match the Erf precedent (`cross-cutting.test.ts`, not `v1-cross-
cutting.test.ts`). The file's purpose is clear from the directory
context.

### XFAIL approach for substrate bugs (rather than silently passing or unconditionally failing)

The bead's "Sanity rails" said "If an invariant FAILS to hold (a real
bug surfaces in substrate), file as P1 follow-up bead with `blocked-
by` edge back to the originating substrate bead. Do NOT silently
skip." Two findings surfaced; I filed both (i3la + tke9). For the
tests themselves I chose `test.skip(...)` with a `XFAIL (sw-<id>): ...`
prefix in the test name and a header comment block explaining the
bug + the substrate bead to remove the skip when the fix lands.

Rationale:
- An unconditional fail breaks `bun test` for the whole project,
  blocking other agents' workflow.
- A silent `if (gotInfinity) return` would hide the bug from future
  readers (Rule 7 violation).
- A `test.skip` with an `XFAIL (sw-...)` prefix preserves the test
  body verbatim (so when the fix lands, the agent un-skipping it has
  the assertion ready) AND makes the bug discoverable via grep.

The arb-prec parity spot-checks (which DO pass) sit alongside the
XFAILs, proving that the bug is scoped to the float64 lane — not a
deeper algorithmic problem. This is the agent-honest separation.

### Per-test 30s/120s timeouts on the slow arbprec blocks

`bigBesselY` at integer ν is genuinely slow (~3s per call at p=200
bits — the FLINT-pattern `bigBesselYIntegerNu` uses K_n internally
which is expensive). The arbprec parity block at (b) takes up to
~12s per cell; the cross-head determinism block (h) does 5 repeats
× 4 heads at the same precision. The default Bun test timeout of
5s timed out 5 tests on the first run. Per-test 30s (for arbprec
single calls) and 120s (for the 5×4 repeat block) budgets cleared
the timeouts without hiding genuine slowness.

The slowness is a known characteristic of the integer-ν Y path
(documented in `bigBesselYIntegerNu`'s file-top) and is not a V1
finding — the substrate is correct, just not yet optimised.
Optimisation is a v0.2 work item (filed in the I1b shard as a
follow-up; not a V1 blocker).

### No new bd issues filed for documentation gaps

The mutation-proving rollup surfaced one Q3 documentation issue (the
I6-prep commit-time invariant — a mutation was committed before
being restored, breaking 15 Erf cross-cutting tests). Already
documented in worklog 143's frictions section AND already mitigated
by the post-mutation `git diff` sanity check Rule 2 adopted. No new
bd issue needed; the rollup cites the friction as historical
evidence.

## Frictions surfaced

### F1 — Y_{1.5, 3.5}(z) float64 sign bug surfaced via Wronskian test

The cross-cutting Wronskian test at ν=2.5 failed because it requires
Y_{3.5}, which has the wrong sign. Initial debugging suggested a
floating-point precision issue; cross-checking against
`bigBesselY(fromFloat64(3.5), fromFloat64(z), 200)` showed the
arb-prec substrate gives the correct (negative) sign. The pattern is
parity-driven (odd-half-integer ν → wrong sign; even-half-integer ν
→ correct). Filed as `scientist-workbench-i3la` (P1); see §"Filed P1
follow-up beads".

**This is the V1 layer's HIGHEST-VALUE finding** — a bug none of
the per-substrate tests caught because they exercise J and Y in
isolation but never compose them via the Wronskian. Per shard 141's
F1 lesson, "tests that span multiple substrates catch the bugs that
single-substrate tests miss" — confirmed empirically here.

### F2 — I_{-n}(z) for n≥2 returns Infinity (negative-integer-ν gap)

The cross-cutting parity test at I_{-n}(z) for n ≥ 2 failed
immediately on the first run with `Received: Infinity`. DLMF §10.27.1
specifies `I_{-n}(z) = I_n(z)` (no sign flip); the float64 substrate
handles n=1 correctly but not n ≥ 2. The fix is a one-line top-of-
function branch; filed as `scientist-workbench-tke9` (P1).

The arb-prec substrate handles negative-integer ν correctly (`bigBesselI(-2,
3, 200) ≡ bigBesselI(2, 3, 200)` byte-identically), so the bug is
scoped to the I5a lane.

### F3 — Bun test default timeout too tight for arbprec Bessel

Initial run timed out 5 arbprec tests at the default 5s budget.
`bigBesselY` at integer ν takes ~3s; the wire wraps add another
~0.5s; some tests do multiple calls in sequence. The fix was
per-test `30000` ms (arbprec single-call tests) and `120000` ms
(the 5-repeat × 4-head determinism block) timeout arguments to Bun's
`test()` (Bun supports `test(name, fn, timeoutMs)` natively).

Worth pinning as a future hallucination-risk callout: "Bun's default
5s test timeout is too tight for arb-prec Bessel substrate calls;
use the 3rd positional `timeoutMs` argument."

### F4 — Naïve canonicalize check in (d) missed that wrappings interleave

The first version of the (d) cross-head identity tests asserted
`canonicalize(simplified) === "<expected canonical>"`. RED because
`casSimplify` wraps subterms in `tagged "cas-simplify/out-of-scope"`
when the rational-function bridge can't fold them (Bessel is
"foreign" to the rat-fn simplifier by design — Class D's rewrites
produce `BesselJ + i·BesselY` shapes the rat-fn bridge declines).

Fixed by asserting on `.toContain("BesselJ")` / `.not.toContain("HankelH1")`
rather than full-canonical-match. The discriminator is preserved
(a rule that didn't fire would leave the original head in the
output, failing `.not.toContain("HankelH1")`); a rule that
mis-fires and emits a different head would fail one of the
`.toContain` checks.

## Acceptance

- [x] `tools/special-eval/bessel-cross-cutting.test.ts` shipped
  covering all 10 a-j invariant groups + the 4-head × 3-ν-class ×
  3-z-region matrix per ADR-0041 §"Acceptance".
- [x] **240 tests pass / 9 skip (documented xfails) / 0 fail / 532
  expect() calls** — well above the ≥80 tests floor + 200 expects
  target.
- [x] **`bun test tools/special-eval/bessel-cross-cutting.test.ts`**:
  240 pass, 9 skip, 0 fail (87.87s wall-clock; arbprec Bessel is
  intrinsically slow on integer-ν Y).
- [x] `docs/refs/besselj-research/V1-mutation-proving-rollup.md`
  shipped with per-bead notes (18 beads), per-bead mutation counts,
  7 cross-bead findings, total footprint **47 mutation perturbations
  confirmed RED across the epic**.
- [x] Rollup cites every Phase 0/2/3 worklog shard (143-145, 152-163)
  by number + path.
- [x] Two P1 follow-up beads filed for V1 cross-cutting findings:
  `scientist-workbench-i3la` (Y_{1.5, 3.5} sign bug) +
  `scientist-workbench-tke9` (I_{-n} Infinity gap). Both blocked by
  `rkoo` (I5a substrate bead).
- [x] Worklog shard added (this shard).
- [x] No premature `bun run check` — orchestrator runs it post-merge
  per the bead's "Critical discipline".

## Pointers

- ADR-0041: `docs/adr/0041-bessel-family-per-head-substrate.md`
- Bead: `scientist-workbench-g5vo` (V1 — Phase 4 GATE for Bessel)
- Epic: `scientist-workbench-zcam` (World-class Bessel)
- Cross-cutting tests: `tools/special-eval/bessel-cross-cutting.test.ts`
- Mutation rollup: `docs/refs/besselj-research/V1-mutation-proving-rollup.md`
- Sibling Erf V1 gate: `docs/worklog/141-v1-verification-gate.md`
  (the styling exemplar)
- Sibling Erf rollup: `docs/refs/erf-research/V1-mutation-proving-rollup.md`
- Phase 0 prep shards: 143 (I6-prep), 144 (I6a vocab), 145 (I6b primitives)
- Phase 1 oracle shards: 146-151
- Phase 2 substrate shards: 152 (I4), 153 (I1a), 154 (I5a), 155 (I6),
  156 (I2a), 157 (I2b), 158 (I1b), 159 (I3a), 162 (I3b)
- Phase 3 tool shards: 160 (T1), 161 (T3), 163 (T2)
- V1 follow-up beads: `scientist-workbench-i3la` (Y sign bug, P1) +
  `scientist-workbench-tke9` (I Infinity gap, P1)
- Next: D1 (epic close + docs lockstep finalisation) — the only Phase
  4 bead remaining open.
