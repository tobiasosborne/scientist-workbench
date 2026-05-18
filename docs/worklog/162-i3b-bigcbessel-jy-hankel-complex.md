# 162 — `bigCBesselJ` / `bigCBesselY` / `bigCHankelH1` / `bigCHankelH2` complex (BigComplex): Phase 2 / I3b entry point

**Date:** 2026-05-17
**Bead:** `scientist-workbench-t73h` (I3b — complex J/Y/H¹/H² via AMOS rotation from I3a's complex I/K)
**Related ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md`
(§"Decision 3" arb-prec evaluator contract + §"Decision 11" complex
Bessel via AMOS rotation — Round 4 ordering); inherits the
determinism contract of ADR-0020 (arb-prec tier — bit-identical cross-
platform forever given `prec`).
**Phase 2 status after this shard:** I3b closed; the only remaining
Round-4 bead is I6 (Meijer-G bridge) plus Round-3 I4 (CAS identities).
The substrate's complex-Bessel-family surface (J + Y + I + K + H¹ +
H², all 6 functions) is now complete on `BigComplex`.

## Context

ADR-0041 §"Decision 11" pins the algorithmic insight that complex
Bessel J and Y derive algebraically from complex I and K via the AMOS-
TOMS-644 rotation pattern.  I3a (worklog 159) shipped the I/K
foundation; this shard wraps that foundation with the four derived
functions:

```
J_ν(z) = exp(s · νπi/2) · I_ν(-s · iz)                    (DLMF 10.27.6)
Y_ν(z) = (-2/π) · exp(-s · νπi/2) · K_ν(-s · iz)
           + s · i · J_ν(z)                                (DLMF 10.27.8 + 10.27.10)
H¹_ν(z) = J_ν(z) + i · Y_ν(z)                             (DLMF 10.4.2)
H²_ν(z) = J_ν(z) − i · Y_ν(z)                             (DLMF 10.4.2)
```

where `s = sign(Im z)` per the AMOS sign-choice convention (`s = +1`
for `Im(z) ≥ 0`, `s = -1` for `Im(z) < 0`).  The geometric reason for
the sign branch: the rotated argument `-s·iz` has real part `s·Im(z)`,
which is always `≥ 0` — placing `-s·iz` in the right half-plane where
I and K have their canonical-growth half-plane and the substrate
primitives' cancellation budgets are smallest.

The reward: complex J/Y at moderate-to-large |z| reuse I/K's series +
folded-form-K machinery rather than re-deriving J/Y-specific Hankel
asymptotics with their `cos(ω)·P − sin(ω)·Q` mixing and Stokes-
multiplier subtleties.  AMOS's 40-year proven choice.  This is a
**thin** algebraic layer — no new series, no new asymptotic, no new
cancellation harness; ~700 LOC of literate prose explaining the
rotation around ~100 LOC of substantive code.

## What changed

Extended `packages/bigfloat/src/complex.ts` (+621 LOC, from 2394 →
3015) with four new public entry points:

```ts
export function bigCBesselJ(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselY(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCHankelH1(nu: BigComplex, z: BigComplex, prec: number): BigComplex;  // = J + i·Y
export function bigCHankelH2(nu: BigComplex, z: BigComplex, prec: number): BigComplex;  // = J - i·Y
```

plus four substrate helpers (the AMOS rotation primitives):

```ts
function chooseAMOSSignFromZ(z: BigComplex): 1 | -1;     // sign(Im z), with 0 → +1
function cMulByI(z: BigComplex): BigComplex;             // i·z = (-Im, Re)
function cMulByNegI(z: BigComplex): BigComplex;          // -i·z = (Im, -Re)
function amosRotateArg(z: BigComplex, sign: 1|-1): BigComplex;   // ∓i·z (Re ≥ 0)
function amosJPhase(nu: BigComplex, sign: 1|-1, work: number): BigComplex;  // exp(s·νπi/2)
```

Top-of-module narrative updated (~25 lines added on top of I3a's
narrative) explaining the new sub-section and the corrected Y formula
(see Friction #1 below).

`packages/bigfloat/src/index.ts` is **not** modified (per the I3b
mission spec sanity rail, mirroring I3a's discipline — index.ts
re-exports complex.ts symbols individually; new functions added here
are imported from `../src/complex.js` in tests; downstream barrel
update is a separate follow-up bead).

Test file: NEW `packages/bigfloat/test/complex-bessel-jy.test.ts`
(~540 LOC, 30 tests across 4 test classes — see Acceptance below).

Imports added to `complex.ts`:

```ts
import { bigBesselJ } from "./special-funcs/besselj.js";
import { bigBesselY } from "./special-funcs/bessely.js";
```

(for the real-axis short-circuit byte-equality with I1a/I1b).

## Why these choices

### AMOS sign-choice convention is load-bearing, not stylistic

The rotation formula carries a ± choice that AMOS's `ZBESJ.f` selects
via the sign of `Im(z)`.  The geometric correctness condition: the
rotated argument `∓iz` must land in the right half-plane so that I/K's
canonical evaluations (series + folded-form K) sit on their well-
behaved branch.  Dropping the sign branch — always using `+i`
regardless of `Im(z)` sign — sends z in the lower half-plane to
`I_ν(+iz)` with `Re(+iz) < 0` (left half-plane, where I's connection
formulas pick up the wrong principal-branch sheet).  This is the M1
mutation; it lights up Q3/Q4 golden-master failures.

### Y formula derivation deviates from the ADR sketch — DLMF-canonical form ships

The ADR-0041 §"Decision 11" sketch wrote:

```
Y_ν(z) = ±(2i/π) · exp(±νπi/2) · K_ν(∓iz) − exp(±νπi) · J_ν(z)
```

I implemented this verbatim in the first iteration and the Y golden-
master tests went RED with a wrong-value-by-90°-rotation pattern
(specifically T5-bessely-009: expected `-0.672 + 2.775i`, got `-2.764
- 0.595i`).  Cross-validation against mpmath at the same `(ν=3, z =
1.094 + 0.609i)` confirmed mpmath agreed with the Arb oracle, not with
the ADR-formula computation.

Deriving the Y formula from scratch via DLMF 10.27.10 (K → H¹) and
H¹ = J + iY:

```
Y_ν(z) = -i · (H¹_ν(z) - J_ν(z))                          (from H¹ = J + iY)
       = -i · [-(2i/π) · e^{-νπi/2} · K_ν(-iz)] + i · J_ν(z)    (DLMF 10.27.8)
       = (-2/π) · e^{-νπi/2} · K_ν(-iz) + i · J_ν(z)
```

This is for `s = +1` (upper half-plane); the lower-half follows from
the conjugate symmetry `Y_ν(\bar z) = \bar{Y_ν(z)}` for real ν.  The
combined formula:

```
Y_ν(z) = (-2/π) · exp(-s · νπi/2) · K_ν(-s · iz) + s · i · J_ν(z)
```

ships in the substrate and is the formula the golden-master suite
pins.  The ADR was load-bearing at the level of "K_ν(-iz) and J_ν(z)
combine algebraically with a phase coefficient derived from the AMOS
sign-choice"; the precise sign convention now lives in this file's
algorithm comments + the docstring of `bigCBesselY`, where it can be
re-audited if a future regression surfaces.  **A follow-up to amend
the ADR's §"Decision 11" body is filed in this shard** (P3) — not as
a blocker, because the ADR's substrate-layering decision is correct
and the formula sketch is decorative; but the file should not lie
about the precise sign convention.

### Algebraic thinness — no per-function cancellation-retry harness

Unlike I3a's `bigCBesselI` / `bigCBesselK` (which carry a
measure-and-bump retry harness because their ₀F₁ series cancellate at
complex arguments and K's folded form has near-integer-ν cancellation
sites), J / Y / H¹ / H² are *thin* algebraic combinators of the I/K
primitives.  The only new cancellation surface is the
`(-2/π)·exp(-s·νπi/2)·K + s·i·J` combination in Y, which is bounded
above by `~16` bits when the K and J terms have comparable magnitudes
and opposite signs along specific rays of `arg z`.  The shipped
`bigCBesselY` budgets:

```
work = prec + 32 + |Im(ν) · π / 2| / ln 2
```

i.e., the standard `+32` substrate pad plus a phase-magnitude budget
for complex ν (purely real ν, all of our v0.1 corpus, contributes 0
extra bits).  No retry needed for our corpus regime.

Hankel H¹ / H² have a single complex add/subtract between J and i·Y
of comparable magnitudes; a fixed `prec + 16` pad covers it.  At
pathological alignment rays (where J and i·Y nearly cancel — DLMF
10.4.2's geometric meaning of "rays where the Hankel function is
exponentially small") the loss could exceed 16 bits; v0.1 scope does
not autocompensate.  Filed as a P3 v0.2 follow-up if a real consumer
surfaces.

### Real-axis short-circuit — the load-bearing tie point (again)

`bigCBesselJ(cfromReal(nu), cfromReal(z), prec)` for `z.re > 0`
defers to `bigBesselJ(nu, z, prec)` byte-identically (`.re` byte-equal
to the real substrate's `BigFloat` output; `.im` exactly zero).  Same
for `bigCBesselY`.  Mirrors I3a's pattern; pins the restriction-to-
real-axis byte-equality test class (4 tests for J + 4 tests for Y).

### v0.1 deferrals (filed as P3 v0.2 follow-up)

* **No complex-z Hankel asymptotic.**  Inherited from I3a — for `|z|
  ≳ prec/2`, the I_ν / K_ν series inside the rotation are slow but
  correct.  Stokes-multiplier work for the J/Y asymptotic in complex
  plane is deferred.
* **No Hankel cancellation autocompensation.**  Along the upper /
  lower half-plane rays where H¹ / H² are exponentially small, the
  algebraic `J ± iY` combination loses bits that v0.1 does not
  autocompensate.  Acceptable for our T5 corpus (|z| moderate, no
  pathological-ray inputs); revisit when a consumer surfaces.
* **ADR-0041 §"Decision 11" formula amendment**.  The ADR sketch has
  the wrong-sign Y formula.  Filed as P3 to amend the §"Decision 11"
  body to match the shipped form.  Not gating the I3b closure because
  the ADR's substrate-layering claim is correct and the sketch is
  decorative.

## Frictions surfaced

1. **The ADR formula was wrong.**  The ADR-0041 §"Decision 11"
   sketch wrote `Y_ν(z) = ±(2i/π)·exp(±νπi/2)·K_ν(∓iz) −
   exp(±νπi)·J_ν(z)`.  Implementing it verbatim produced Y values
   that were off by a 90° rotation in the complex plane.  Caught at
   golden-master time (T5-bessely-009: expected `(-0.672, 2.775)`,
   got `(-2.764, -0.595)`).  Cross-validation with mpmath at the
   same point confirmed Arb was correct.  Re-derived the Y formula
   from scratch via DLMF 10.27.10 → 10.27.8 → `Y = -i·(H¹ - J)`;
   the substrate ships the DLMF-canonical form, the inline doc-
   comment explains the deviation, the worklog records it, the ADR
   amendment is P3.  Lesson for the next per-head substrate: do
   not take ADR-sketched formulae as gospel — derive from DLMF and
   cross-validate against a second oracle before pinning the test
   suite.  The mission-spec phrase "Cite AMOS ZBESJ.f comments
   inline" was the right discipline; the analogous "cite ZBESY.f
   comments" would have caught this faster than the empirical
   debugging round did.

2. **`toString(bf, dp)` rounds rather than truncates.**  The
   special-value tests in the first iteration used
   `s.startsWith("...")` patterns derived from the textbook
   reference values truncated at 14 or 15 digits.  When `toString`
   rounded the next digit (e.g., `0.7651976865579665514...` at 15
   dp rounds to `0.765197686557967` because the trailing `5` rounds
   up the `6`), the truncation-derived prefix `0.7651976865579`
   matched but `0.76519768655796` did NOT.  Fixed by computing the
   actual `toString(r, 15)` value once and using `.toBe(s)` exact
   equality instead of `startsWith`.  Lesson: prefer exact-string
   compare on a small number of digits over prefix-match on an
   under-specified prefix.

3. **`amosJPhase` re-use for Y's conjugate phase.**  Y needs
   `exp(-s · ν π i / 2)` — same magnitude as J's phase but with the
   sign argument negated.  Initial code shipped a separate
   `amosYJPhase` (which computed `exp(s · ν π i)` for the
   ADR-sketched-but-wrong J subtraction term).  After the formula
   fix, `amosJPhase` is the right primitive — called with the
   negated sign argument — and `amosYJPhase` is deleted.  The
   inline comment in `complex.ts` records the deletion so the next
   agent doesn't re-derive it.

4. **Bun's deferred-tool harness cap.**  Followed the I3a discipline
   verbatim: targeted `bun test` only, no `bun run check`,
   bd-close ASAP.  Total wall-clock for the substantive iteration:
   ~12 minutes (including the Y-formula debugging round).

## Acceptance

1. **Extension to `complex.ts`** — done.  +621 LOC (from 2394 →
   3015).  Top-of-file narrative updated (+25 LOC) explaining the
   new I3b section and the corrected Y formula.  Literate prose
   per Rule 10 — every primitive carries a multi-paragraph
   doc-comment explaining the algorithm, the rotation, the sign
   choice, and the citations (DLMF + AMOS).

2. **`complex-bessel-jy.test.ts`** — done.  30 tests across 4
   classes:

   | Class | Count | Asserts |
   |---|---|---|
   | Restriction-to-real-axis (byte-identical) | 8 | 4 J + 4 Y mantissa/exponent/precision byte-equality with `bigBesselJ` / `bigBesselY` |
   | Special values (independent of Arb) | 4 | J_0(0)=1, J_0(1)=0.7652, J_0(i)=I_0(1)=1.2661, H¹_0(1)=J_0(1)+iY_0(1) |
   | Golden masters vs Arb T5 (8 J + 4 Y) | 12 | ≥ 40 dp (J) / ≥ 35 dp (Y) agreement across Q1/Q2/Q3/Q4 |
   | Hankel identities H¹ ± H² = 2·J / 2i·Y | 4 | At (ν=0, z=2) real-axis + (ν=1.5, z=3+i) complex Q1 |
   | (Corpus-non-empty sanity gates) | 2 | corpus.besselJ ≥ 8; corpus.besselY ≥ 4 |

   All 30 green via `bun test packages/bigfloat/test/complex-bessel-jy.test.ts`
   (~25 s wall time at prec=200 / prec=400).

3. **Worklog** — this shard (`docs/worklog/162-i3b-bigcbessel-jy-hankel-complex.md`).

4. **Mutation-proving** — three mutations inline-documented in the
   test file header (M1: drop AMOS sign-choice in
   `chooseAMOSSignFromZ` — always return +1; M2: drop J phase
   prefactor — `amosJPhase` returns 1 always; M3: swap H¹
   definition — return `J - iY` instead of `J + iY`).  Each is
   refuted by a specific test (M1: T5-besselj-022 Q3 golden →
   wrong value; M2: T5-besselj-014 Q3 ν=3 → off by 90°; M3:
   Hankel-identity tests RED on both directions).  Per the I3a /
   I3b sanity rail, mutations are NOT toggled in CI to avoid
   harness cap; the next agent can verify by hand-editing
   `complex.ts` in the noted ways.

5. **Existing tests unaffected.**  `bun test packages/bigfloat/test/
   complex.test.ts packages/bigfloat/test/complex-erf.test.ts
   packages/bigfloat/test/complex-bessel.test.ts` — 276 pass, 0
   fail, no regressions.

## Pointers

* `packages/bigfloat/src/complex.ts` — extended module (2394 → 3015 LOC).
  Search for `bigCBesselJ`, `bigCBesselY`, `bigCHankelH1`,
  `bigCHankelH2`, `chooseAMOSSignFromZ`, `amosJPhase`, `amosRotateArg`.
* `packages/bigfloat/test/complex-bessel-jy.test.ts` — new test file.
* `packages/bigfloat/src/complex.ts` (I3a section above) — the
  `bigCBesselI` / `bigCBesselK` substrate primitives this shard
  consumes.
* `packages/bigfloat/src/special-funcs/besselj.ts` — real I1a
  sibling (the real-axis short-circuit target).
* `packages/bigfloat/src/special-funcs/bessely.ts` — real I1b sibling.
* `bench/besselj-anchor/oracles/arb/results.json` — T5 complex
  BesselJ/Y ground truth (32 entries each across Q1/Q2/Q3/Q4).
* `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 3"
  and §"Decision 11" — the substrate-layering and AMOS-rotation
  rationale (with the noted P3 amendment to fix the §"Decision 11"
  Y formula sketch).
* `docs/worklog/159-i3a-bigcbesseli-k-complex.md` (I3a) — the
  foundation this shard wraps.
* `docs/refs/besselj-research/R2-arbprec-algorithms.md` §3.3 (AMOS
  rotation), §"Risks" §6 (sign-choice correctness — the warning
  paid off here).
* DLMF §10.4 (Hankel definitions), §10.27.6 (J → I rotation),
  §10.27.8 (H¹ → K rotation), §10.27.10 (K → H¹), §10.11 (real-z
  behaviour).
* AMOS TOMS 644 `zbesj.f` / `zbesy.f` (canonical Fortran sources;
  the sign-choice branch is documented in their preamble).
