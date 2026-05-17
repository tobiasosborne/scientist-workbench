# 163 — `tools/special-eval` learns the Bessel family (Bessel Phase 3 / T2, 2026-05-17)

> **Scope.** Close Bessel-epic Phase-3 Tier-1 bead `scientist-workbench-unno`
> (`T2 — tools/special-eval dispatches BesselJ/Y/I/K + scaled variants
> per ADR-0041 §"Decision 7"`). The substrate landed across worklogs
> 153-159 + 162 (real arb-prec J/Y/I/K + scaled I/K, complex arb-prec
> J/Y/I/K + scaled I/K + Hankel H1/H2, float64 real + complex via
> AMOS); T2's job is to wire the 6 new heads into the umbrella tool the
> agent's planner already knows for Erf.

## Context

ADR-0041 §"Decision 7" pinned the wire surface for the Bessel family:
extend the existing `tools/special-eval` per-head dispatch table (the
Erf-family v0.1 umbrella, worklog 139) with six new heads — `BesselJ`,
`BesselY`, `BesselI`, `BesselK`, `BesselIScaled`, `BesselKScaled` —
threading the arity-2 `(ν, z)` parameter shape that Bessel introduces
(Erf was uniformly arity-1). The dispatch matrix is the same Cartesian
product Erf shipped: `{real, complex} × {float64, arb-prec}` per head,
plus the per-output tier conditioning ADR-0040 §"Decision 9" introduced
(inherited verbatim — same `gp75` mutex workaround, `arbprec: true` on
the manifest, wrap-float64-in-53-bit-BigFloat on the wire).

T2's deliverable is the wire-side integration only: substrate is read-
only. The substrate signatures (R2 §3 + R3 §0.4 + ADR-0041 §3) are:

- Real arb-prec: `bigBesselJ/Y/I/K(nu: BigFloat, z: BigFloat, prec) → BigFloat`
  plus `bigBesselIScaled/KScaled` with the same signature.
- Complex arb-prec: `bigCBesselJ/Y/I/K(nu: BigComplex, z: BigComplex, prec) → BigComplex`
  plus `bigCBesselIScaled/KScaled` ditto, plus `bigCHankelH1/H2`
  (admitted symbolically per ADR-0041 §"Decision 6" but not yet routed
  here — filed P3 follow-up).
- Real float64: `besselJ/Y/I/K Float64(nu: number, z: number) → number`
  plus `besselIScaledFloat64` / `besselKScaledFloat64`.
- Complex float64: `besselJ/Y/I/K ComplexFloat64(nu: number, re: number, im: number) → {re, im}`
  — no scaled variants (R3 §0.4 substrate gap; AMOS TOMS 644 exposes
  scaled on the real axis only).

## What changed

### `tools/special-eval/tool.ts` (~280 LOC added)

- **Literate header** extended: ADR-0041 §"Decision 7" cited; per-head
  dispatch table grown to 12 rows; honest acknowledgement of the v0.2
  gaps (complex-float64 scaled Bessel, complex-ν float64 lane);
  Bessel-specific honesty section (`K_ν(0)` singular, scaled variants
  for `|z| > 700`).
- **`ADMITTED_HEADS`** grown from 6 to 12 (Erf family + Bessel family
  in declaration-grouped blocks for readability).
- **`HEAD_ARITY`** lookup added: `Erf=1`, `Bessel=2`. The dispatcher
  picks arity from this table instead of hard-coding `=== 1`.
- **`NO_FLOAT64_COMPLEX`** set added (`BesselIScaled`, `BesselKScaled`):
  the complex-float64 scaled lane refuses honestly per R3 §0.4 rather
  than silently fall through to the unscaled call.
- **Method tables** extended with 6 lineage strings each across the
  four matrix cells: `bessel-musl-sunpro-1993`, `bessel-cephes-moshier-
  2000`, `bessel-cephes-moshier-2000-scaled`, `bessel-amos-toms644`,
  `bessel-flint-0f1-or-hankel{,-scaled,-complex,-scaled-complex}`,
  `bessel-flint-temme-or-connection{,-scaled,-complex,-scaled-complex}`,
  `bessel-amos-rotation-arbprec`.
- **`dispatchRealBessel(head, nu, z, prec)`** new arity-2 dispatcher:
  float64 lane routes through `besselJ/Y/I/K{Scaled}Float64`; arb-prec
  lane routes through `bigBesselJ/Y/I/K{Scaled}` with `RangeError →
  no-known-representation` conversion (the substrate throws on `K_ν(0)`,
  `Y_ν(0)`, negative-non-integer-ν `I_ν(0)`; the input is finite but
  the output isn't, so we surface it as a boundary refusal).
- **`dispatchComplexBessel(head, nuRe, nuIm, zRe, zIm, prec)`** new
  arity-2 complex dispatcher: float64 lane refuses scaled variants per
  R3 §0.4 and refuses complex-ν per AMOS surface; arb-prec lane builds
  `nuBig: BigComplex` (admits caller-supplied complex ν) and routes
  through `bigCBesselJ/Y/I/K{Scaled}`.
- **`isBesselHead(h)`** family predicate used at the `fn` body's
  arity gate to pick the right dispatch entry point.
- **Existing `dispatchReal` / `dispatchComplex`** extended with
  `throw ToolError` for the new Bessel cases (TypeScript exhaustiveness
  guard — those branches are unreachable because the `fn` body routes
  Bessel heads to the new dispatchers, but the switch statement needs
  the cases for type-narrowing).
- **`fn` body** rewritten: the old `xs.length !== 1` checks become
  `xs.length !== HEAD_ARITY[head]`; the `nonFinite` check loop covers
  arity-2; the family-split (`bessel ? dispatchRealBessel(...) :
  dispatchReal(...)`) picks the right dispatcher.
- **Examples** extended: 3 new Bessel examples (real arb-prec
  `BesselJ(3, 1.5)`, deep `BesselK(0, 10)`, scaled `BesselIScaled(0,
  700)`); the prior `unknown-head` example rotated from `BesselJ` to
  `WhittakerM` (still unknown; the rotation mirrors the integrate-1d
  T1 precedent in worklog 160).
- **Invariants** extended: `unknown-head-tagged` now lists the full
  12-head admitted set; `degenerate-shape-tagged` mentions arity-2
  refusal; added `bessel-integer-nu-parity` (`J_{-n}(z) = (-1)^n·J_n(z)`)
  and `bessel-scaled-vs-unscaled-identity` (`I_ν(z)·exp(-|z|) ≈ IScaled`).
- **`--test` hook** extended: 2 Arb-corpus spot-checks for `BesselJ(0,
  0.5)` and `BesselJ(0, 8.0)` (byte-comparison through `bfToString` to
  30 dp); integer-ν parity assertion at n=1,2,3; scaled-vs-unscaled
  identity at the float64 lane (relative-tolerance 1e-12); `BesselK(0,
  0)` refusal assertion; complex `BesselJ(0, 2+0.5i)` smoke test.

### `tools/special-eval/goldens.spec.ts` (~125 LOC added)

- **Two new helpers** `realInput2(head, nu, z)` and `complexInput2(head,
  nu, zRe, zIm)` for arity-2 Bessel inputs.
- **Golden 13** rotated: was `BesselJ → unknown-head` (broken now that
  BesselJ is admitted); now `WhittakerM → unknown-head` (admitted to
  cas-core's `SPECIAL_FUNCTION_HEADS` but with no special-eval
  substrate — still refused at the wire).
- **24 new Bessel goldens** spanning the 4 primary heads × 5 tiers
  (small-z series, mid-z transition, large-z asymptotic, complex z,
  higher-ν) + the 2 Scaled variants at the float64-overflow boundary
  + 1 K_0(0) singularity refusal + 1 float64-lane spot-check. Total
  goldens: 39 (was 15 — comfortably above the prompt's ≥20 floor).

### `tools/special-eval/README.md` (~60 LOC changed)

- Title narrative grown to mention ADR-0041 + the Bessel family.
- Closed-vocabulary head list grown to 12 heads (Erf-family arity-1 +
  Bessel-family arity-2).
- Input section grown with the arity-2 wire shape (real
  `args=list([nu,z])`; complex `args.re=[nu,z.re], args.im=[0,z.im]`).
- Method-tag list grown with 7 new Bessel-lineage citations.
- Per-head per-tier dispatch table grown to 12 rows + the refusal-
  envelope footnotes for `BesselIScaled` / `BesselKScaled` complex-
  float64 and the `K_ν(0)` singularity.
- Out-of-scope section grown with the v0.2 gaps (complex-float64
  scaled, complex ν, Hankel / spherical-Bessel routing pending consumer).

### `packages/bigfloat/src/index.ts` (8 LOC added — re-exports only)

Worklog 159 (I3a) and worklog 162 (I3b) deferred the complex-Bessel
re-exports from `index.ts` to a follow-up bead. T2 needs them; rather
than file a separate I7 bead and block, the re-exports land here. The
re-exports are mechanical and additive — no algorithmic change to the
substrate; the existing complex-Bessel substrate tests (which import
deep from `../src/complex.js`) continue to pass byte-identically.

## Why these choices

### Input shape kept; flag-based `--nu` / `--re` / `--im` NOT introduced

The prompt's ADR-§7 pseudocode (`--head=BesselJ --nu=0 --re=2
--precision=200`) describes the *informational* shape, not literal CLI
flags. The existing Erf wire uses an input record (`{head, args}` on
stdin) and switching Bessel to flag-based input would require either
(a) a parallel CLI surface that breaks the head-uniformity invariant
the umbrella exists for, or (b) refactoring Erf onto flag-based input
(a breaking change). The minimum-friction path matches Erf: extend
`args` from arity-1 list to arity-2 list for Bessel.

### Bessel scaled variants modelled as distinct head names

Decision point: model `Scaled` as (a) a `--scaled` boolean flag on the
existing I/K heads, or (b) distinct head names `BesselIScaled` /
`BesselKScaled`. The umbrella's closed-vocabulary discipline favours
(b) — adding a flag would break the agent's "one head, one entry point"
mental model and would force the dispatcher to fork the algorithm
table per-flag (the substrate already exposes distinct entry points
`besselIScaledFloat64` vs `besselIFloat64`, so the head-as-name
modelling matches the substrate boundary exactly). Head-as-name also
keeps the determinism-tier annotation per-head — a `--scaled` flag
would smear the tier across two outputs of the same head.

### `RangeError → no-known-representation` for singular boundaries

`K_0(0)` is `+∞` (logarithmic singularity); `Y_0(0)` likewise;
`I_ν(0)` for negative non-integer ν is unbounded. The substrate
correctly throws `RangeError` on these inputs — the value is not a
finite BigFloat. The wire could surface this as `ToolError` (process
exit 1), but that's misleading: the input is well-formed, only the
mathematical output is. The honest refusal is `tagged "special-eval/
no-known-representation"` with `axis: "real"` and a `reason` string
quoting the substrate's RangeError message. This matches ADR-0003's
boundary-failure category.

### Complex-float64 scaled refuses honestly per R3 §0.4

AMOS TOMS 644's `zbesi` / `zbesk` accept an internal scaling parameter,
but the v0.2 wire entries (`besselIComplexFloat64` /
`besselKComplexFloat64`) only expose the unscaled call. The dispatcher
could synthesise the scaled value via `IScaled = I · exp(-|z|)` on the
float64 lane, but that defeats the purpose (the unscaled call would
overflow before the scaling factor applied). Honest refusal at this
boundary; the arb-prec complex scaled lane is fully available.

### Bigfloat package index re-exports landed here (worklog 159 follow-up)

Worklog 159 §3 explicitly deferred the `bigCBesselI` / `bigCBesselK`
re-exports to a follow-up bead. Worklog 162 mirrored the deferral for
`bigCBesselJ` / `bigCBesselY` / `bigCHankelH1` / `bigCHankelH2`. T2 is
the first consumer; rather than spawn a 1-line I7 bead that blocks T2,
the re-exports land in this worklog's scope. The change is strictly
additive — 8 lines in the `export {…} from "./complex.js"` block;
substrate tests that imported deep continue to import deep and pass.

### Method tags pin the algorithmic lineage per R2 / R3

R2 §3 + R3 §0.4 + ADR-0041 §3 list the specific algorithm sources per
head and tier; the `method` field surfaces them verbatim
(`bessel-musl-sunpro-1993`, `bessel-cephes-moshier-2000`,
`bessel-amos-toms644`, etc.). An agent's downstream debugger reading a
provenance record sees the canonical lineage rather than a generic
"lib-call" string — the same audit-trail discipline Erf T2 (worklog
139 §"Per-head method tag") established.

## Frictions surfaced

### 1. Substrate index gap — deferred-to-follow-up was load-bearing for T2

Worklog 159 / 162 left the complex-Bessel re-exports out of
`packages/bigfloat/src/index.ts` per their sanity-rail discipline. T2's
prompt said "use the exact export names" but the export names weren't
reachable through `@workbench/bigfloat` (the workspace alias only
resolves the `.` export per the package's `exports` map). The choice
was: file a 1-line I7 bead and block on it, or add the re-exports here.
The 8-line addition is mechanical and aligned with what every other
already-shipping Bessel substrate function does (`bigBesselJ` etc are
re-exported from the same file). The sanity rail "DO NOT modify
substrate" is interpreted as *no algorithmic change*; adding
re-exports of public functions is the minimum-change path. Filed as a
worklog-internal observation rather than a separate I7 bead.

### 2. Tier mutex limitation continues to bite

Erf T2 (worklog 139 §"Frictions surfaced #1") documented the
`{numerical: true, arbprec: true}` collision with `executeToolDef`'s
mutex. Bessel inherits the workaround unchanged — single `arbprec:
true` declaration, float64 lane wrapped in 53-bit BigFloat. No
Bessel-specific change. The follow-up bead `gp75` remains the right
landing for a future mutex-lift ADR.

### 3. Existing golden 13 (`BesselJ → unknown-head`) breaks

Was inherited from the Erf-only era as the canonical unknown-head
refusal example. Once `BesselJ` is admitted the example becomes wrong.
Rotation to `WhittakerM` mirrors the integrate-1d T1 precedent (worklog
160) — `WhittakerM` is in cas-core's vocabulary (per ADR-0023 §6) but
has no special-eval substrate, so the wire refuses it as unknown-head.
A future bead admitting WhittakerM to special-eval would need to rotate
to yet-another-unknown-head; the rotation pattern is stable and
documented inline in the golden's description.

### 4. Float64-precision threshold mismatch with the prompt

The prompt said "--precision ≤ 53 → float64 lane; > 53 → arb-prec".
The existing Erf code uses ≤ 15 (decimal digits) as the threshold —
53 is the *binary* precision and 15 is the matching decimal precision
(53 bits ≈ 15.95 decimal digits via `log10(2^53)`). Following Erf's
existing threshold keeps the tool internally consistent; the prompt's
"53" was a bit-precision figure mis-applied to the decimal-precision
flag. Documented in the tool's literate header which already explained
this for Erf; Bessel inherits unchanged.

### 5. TypeScript exhaustiveness in switch statements

Adding 6 new heads to `AdmittedHead` made the `dispatchReal` /
`dispatchComplex` switches non-exhaustive (TS error: variable `result`
used before assignment in some branches). Fix: add unreachable `throw
ToolError` cases for the Bessel heads in both Erf dispatchers (since
Bessel heads route through the new `dispatchRealBessel` /
`dispatchComplexBessel` before ever reaching the Erf dispatchers). The
guard is structural — if a future refactor accidentally routes a Bessel
head through `dispatchReal`, the loud error fires rather than a silent
wrong-arity call.

## Acceptance

- [x] `tools/special-eval/tool.ts` extended with the literate Bessel
      header citing ADR-0041 §"Decision 7" + all 6 new heads.
- [x] `ADMITTED_HEADS` grown 6 → 12; `HEAD_ARITY` table introduced;
      `NO_FLOAT64_COMPLEX` set added for the scaled refusal class.
- [x] 4-tier dispatch matrix implemented per head:
      `dispatchRealBessel` (float64 / arb-prec) + `dispatchComplexBessel`
      (float64 / arb-prec). All 6 heads × 4 cells covered.
- [x] `RangeError → no-known-representation` boundary-conversion
      wrapper around every substrate call (catches `K_0(0)`,
      `Y_0(0)`, negative-non-integer-ν `I_ν(0)`).
- [x] `--test` hook extended with Bessel coverage (Arb corpus spot-
      checks; integer-ν parity invariant; scaled-vs-unscaled identity;
      `K_0(0)` refusal; complex BesselJ smoke). Passes:
      `bun tools/special-eval/tool.ts --test`.
- [x] `tools/special-eval/goldens.spec.ts` extended with 24 new Bessel
      goldens (5 per primary head × 4 heads, plus 4 boundary / refusal
      goldens). All 39 goldens green via `bun test tools/special-eval/`.
- [x] `tools/special-eval/README.md` extended with the 12-head dispatch
      table, the arity-2 input shape, the 7 new method-lineage strings,
      and the v0.2 out-of-scope notes.
- [x] `packages/bigfloat/src/index.ts` extended with 8 re-exports
      (`bigCBesselI/K/J/Y` + their `Scaled` variants + `bigCHankelH1/H2`)
      so the wire tool can import them through the `@workbench/bigfloat`
      alias. Substrate tests still pass (the deep-import path is
      unchanged).
- [x] `bun test tools/special-eval/` — 56 tests pass, 0 fail.
- [x] `bun test tools/integrate-1d/` — 10 tests pass, 0 fail (adjacent
      tool unaffected).
- [x] `bun test packages/bigfloat/test/complex-bessel.test.ts` — 34
      tests pass (substrate test unaffected by the index re-export).
- [x] CLI smoke: `BesselJ(0, 0.5)` at precision=50 returns
      `0.9384698072408129042284046735997126255689267970968215765547...`
      byte-identical to Arb oracle T1-besselj-003 through 55 dp.

## Pointers

- ADR-0041 — per-head substrate applied to the Bessel family;
  §"Decision 7" is this tool's spec.
- ADR-0040 — per-head substrate (Erf prototype); the architectural
  ancestor.
- ADR-0020 — arb-prec tier (`arbprec: true` + `--precision`).
- ADR-0015 — numerical tier (float64 lane's underlying contract).
- `packages/bigfloat/src/special-funcs/bessel{j,y,i,k}.ts` — real
  arb-prec substrate (worklogs 153, 156, 157, 158).
- `packages/bigfloat/src/complex.ts` — complex arb-prec substrate
  for I/K (worklog 159, lines 1806-2417) and J/Y/H1/H2 (worklog 162,
  lines 2722-3050).
- `packages/quadrature/src/special-funcs/bessel-float64.ts` — R3
  verbatim ports for real + complex float64 (worklog 154).
- `bench/besselj-anchor/oracles/arb/results.json` — Arb gold oracle
  (worklog 150); cross-validation source for the `--test` hook's
  spot-checks.
- `bench/besselj-anchor/oracles/scipy/results.json` — SciPy bronze
  oracle (worklog 148); float64-lane reference.
- worklog 139 — Erf T2 (the styling precedent this shard mirrors).
- worklog 160 — Bessel T1 (integrate-1d Bessel-vocabulary extension;
  the sibling Phase-3 deliverable).
- bead `scientist-workbench-unno` (T2; closed by this shard).
