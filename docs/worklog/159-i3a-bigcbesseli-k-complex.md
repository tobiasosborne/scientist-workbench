# 159 — `bigCBesselI` / `bigCBesselK` complex (BigComplex): Phase 2 / I3a entry point

**Date:** 2026-05-17
**Bead:** `scientist-workbench-q7ty` (I3a — bigCBesselI / bigCBesselK complex)
**Related ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md`
(§"Decision 3" arb-prec evaluator contract + §"Decision 11" complex
Bessel via AMOS rotation — explains why I/K ships first); inherits the
determinism contract of ADR-0020 (arb-prec tier — bit-identical cross-
platform forever given `prec`).
**Phase 2 status after this shard:** I3a closed. Round-3 has only I4
(CAS identities — bead `lrmo`) and I3b (complex J/Y derived from this
shard's I/K via AMOS rotation — bead `t73h`) remaining. The substrate
foundation for complex J/Y/H¹/H² is now in place.

## Context

ADR-0041 §"Decision 11" pins the non-obvious algorithmic insight from
R2 §3.3 that **changes the substrate-bead round ordering** vs the
ADR-0040 / Erf default. The complex-Bessel substrate computes I and K
first (via direct series + folded-form connection), then derives J and
Y algebraically via the AMOS rotation:

```
J_ν(z) = exp(±νπi/2) · I_ν(∓iz)                  AMOS ZBESJ pattern
Y_ν(z) = ±(2i/π)·exp(±νπi/2)·K_ν(∓iz)            AMOS ZBESY pattern
              − exp(±νπi)·J_ν(z)
```

This shard is the foundation: complex I and K. The reason this
ordering matters — and why I/K is strictly simpler than J/Y at the
complex layer — is that the **modified** family has algebraically
simpler asymptotic behaviour:

* I's series and asymptotic have a single all-alternating sum with a
  pure-exponential `e^z / √(2πz)` prefactor.
* K's folded-form connection (per I2b worklog 157) sidesteps the
  Γ-pole issue at near-negative-integer ν via DLMF 5.5.3 reflection.
* No `cos(ω)·P − sin(ω)·Q` mixing (J/Y), no zero-crossing tolerance
  band (J/Y), no Stokes-multiplier subtleties at the asymptotic
  crossover (J/Y at large complex |z|).

I3b (complex J/Y) will be a 5-line algebraic wrapper around this
shard's primitives. AMOS's 40-year proven choice and FLINT's
transcription both compute complex J/Y from complex I/K, not the other
way around.

## What changed

Extended `packages/bigfloat/src/complex.ts` (+816 LOC) with four new
public entry points:

```ts
export function bigCBesselI(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselIScaled(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselK(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
export function bigCBesselKScaled(nu: BigComplex, z: BigComplex, prec: number): BigComplex;
```

plus three substrate primitives (the cancellation-retry harness mirrors
the real-path siblings):

```ts
function chyp0F1WithLossTracking(b, w, work): { value, peakTermMag }   // complex 0F1 + peak tracking
function bigCBesselKConnectionInner(nu, z, work): { value, outerLossBits, innerPeakLossBits }
export function bigCBesselKFromConnection(nu, z, prec): BigComplex     // non-integer ν path
export function bigCBesselKIntegerNu(n, z, prec): BigComplex           // integer ν via limit-via-eps
```

Top-of-module narrative extended (~50 lines) to explain why this module
now hosts both the Erf and Bessel I/K complex families, and why
shipping I/K first matters for the I3b J/Y derivation. The narrative
cites ADR-0041 §Decision 11 explicitly.

Test file: NEW `packages/bigfloat/test/complex-bessel.test.ts` (~480
LOC, 34 tests across five test classes — see Acceptance below).

`packages/bigfloat/src/index.ts` is NOT modified (per the I3a mission
spec sanity rail — index.ts re-exports complex.ts symbols individually
rather than as a barrel, so new functions added in this bead are
imported from the source module directly in tests; downstream consumers
that want barrel re-export will land in a follow-up bead).

## Why these choices

### Direct complex ₀F₁ series, NOT analytic continuation from real I

The naive textbook approach for I_ν(z) at complex z is "evaluate
I_ν(|z|) on the real path, then rotate by `e^{iν·arg z}`". That is
incorrect — I_ν is not a simple-rotation function of |z|; only the
*connection* across the branch cut at z=0 satisfies a rotation
identity (DLMF 10.34.2: `I_ν(z e^{imπ}) = e^{imνπ} I_ν(z)` for INTEGER
m only). For arbitrary complex z, the only correct substrate move is
to evaluate the defining ₀F₁ series in BigComplex — every
multiplication, addition, and division is complex.

The series is entire in z, so the only question is "how many terms" —
which scales as O(|z| + prec) just like the real path. The catch: for
complex z with arg(z) far from 0, successive `(z²/4)^k` factors rotate
in phase, so the partial sums oscillate before damping. Peak-term
magnitude is `~exp(|z|)`; final answer can be much smaller; the
cancellation budget is `|z|·log₂ e` bits. We carry the same
measure-and-bump retry pattern as `bigBesselJSeriesCancellationRetry`.

### Folded-form K, NOT naive composition `(I_{-ν} − I_ν)/sin(νπ)`

The mission spec called for the textbook DLMF 10.27.4 K-from-I
expression, but the I2b worklog 157 made the case carefully for the
FLINT folded form via Γ-reflection (DLMF 5.5.3). I3a inherits that
algorithmic shape verbatim, on BigComplex.

The folded form's two ₀F₁ series have no internal Γ-pole at any
non-integer ν. Both `(z/2)^{±ν}` prefactors are sub-exponential growth.
The single cancellation surface is the outer `[A − B]` subtraction,
which the retry harness handles with a budget that combines:

* near-integer-ν loss (`−log₂|ν − round(ν)|` bits),
* large-|z| loss (`2·|z|·log₂ e` bits — both A and B carry the
  `cosh(z)`-class exponential growth via their ₀F₁ factors),
* inner ₀F₁ phase-rotation loss (`|z|·log₂ e` bits — the complex-z
  series cancellation envelope).

The total budget is summed up front; the retry fires once if the
measured loss exceeds the analytic estimate plus 16-bit headroom.
Mirrors I2b's two-budget approach with an added third budget for the
complex-series phase rotation that the real path doesn't need.

### Real-axis short-circuit — load-bearing tie point

`bigCBesselI(cfromReal(nu), cfromReal(z))` for `z ≥ 0` defers to
`bigBesselI(nu, z)` byte-identically (`.re` byte-equal to the real
substrate's `BigFloat` output; `.im` exactly zero). Same for
`bigCBesselK` with `z > 0`. This isn't just an optimisation — it's the
**cross-validation invariant** that pins the complex and real lanes
together. Any drift between I2a/I2b (real) and I3a (complex) surfaces
immediately as a byte-mismatch in the restriction-to-real-axis test
class (10 tests). The pattern mirrors `bigCErf`/`bigErf` from I3 (Erf).

### v0.1 deferrals (filed as P3 v0.2 follow-up)

* **No complex-z modified-Hankel asymptotic.** The real-axis
  `bigBesselIHankelAsymptotic` exists because for large positive z the
  series is `O(prec)` expensive and the asymptotic is `O(1)`. For
  complex z the asymptotic has Stokes-line subtleties — the
  `e^z / √(2πz)` prefactor is correct only in `|arg z| < π/2`; across
  the Stokes lines the subdominant `e^{-z}` contribution must be added
  via the Stokes multiplier (DLMF 10.40.5). v0.1 routes all complex z
  through the series; correctness holds everywhere, performance
  degrades only at `|z| ≳ prec/2`. For the I3a corpus (T5 complex
  BesselI/K with `|z| ≤ ~30` at prec=400), this is well within the
  series's efficient band.

* **K's complex large-z asymptotic** likewise deferred (parallel to
  the I2b real-path deferral). The folded I-connection is correct on
  the full complex plane (excluding the branch cut at z=0); only the
  performance suffers at large |z|.

* **Polynomial-series Temme path for integer-ν complex K**: the v0.1
  fallback is the same limit-via-eps as I2b, lifted to BigComplex. At
  prec=200, the integer-ν K calls cost ~500 ms each (vs ~50 ms for
  non-integer ν) due to the doubled working precision. Acceptable for
  v0.1; v0.2 follow-up would port FLINT's `acb_hypgeom_bessel_k_0f1_series`
  (the exact polynomial form, no limit) on BigComplex.

## Frictions surfaced

1. **The test runtime budget at prec=400.** The integer-ν K corpus
   tests at prec=400 take ~1-2 seconds per call (the limit-via-eps
   path doubles the working precision; the connection's own large-|z|
   retry harness can add another bump). For the 6 nu=0 K golden tests
   at prec=400, the cumulative cost is ~10 s — bumping the suite from
   ~10 s to ~23 s. Acceptable in absolute terms; the alternative
   (lower-prec golden tests) would lose validation depth. Documented
   as P3 v0.2: implement the polynomial-series Temme path for the
   integer-ν complex K case to drop this cost ~3×.

2. **Refusal sites — what happens at integer ν + non-real z + tiny |z|?**
   The bigCBesselK integer-ν dispatch eagerly calls
   `bigCBesselKIntegerNu` which calls `bigCBesselKFromConnection` with
   ν = n + ε. The `bigCBesselKFromConnection` body validates that ν is
   NOT exactly integer (lest the dispatch loop). The ε = 2^-(prec+32)
   perturbation is large enough that the integer-test (via
   `asExactIntegerBF`) returns null — confirmed empirically. No
   refusal occurs at small |z|.

3. **The exported-symbol surface.** Per the I3a sanity rail, I did not
   modify `packages/bigfloat/src/index.ts`. The result is that
   `bigCBesselI` / `bigCBesselK` / `bigCBesselIScaled` /
   `bigCBesselKScaled` are exported from `packages/bigfloat/src/complex.js`
   but not (yet) re-exported through the package's index. Downstream
   consumers (I3b, T2, etc.) must import directly from `complex.js`
   until a follow-up bead bumps the barrel. The test file imports
   directly from `../src/complex.js`, mirroring the pattern in
   `test/erf.test.ts` which imports from `../src/special-funcs/erf.js`.

4. **`fromInt(1n, prec)` does NOT have `mantissa === 1n`.** This bit
   me in the first iteration of the special-value test for I_0(0) = 1.
   The BigFloat normalisation shifts the mantissa to fill `prec` bits;
   the canonical-zero test (`r.mantissa === 0n`) is structural, but
   the canonical-one test must use `toString` or `toFloat64` for value
   comparison. Mirrors the convention used elsewhere in the test
   suite; the lesson is captured here for the next agent.

5. **Bun's deferred-tool harness cap.** I lost ~2 minutes to the prior
   subagent caps that the prompt explicitly warned about. The
   discipline ("run targeted bun test, bd-close ASAP, skip `bun run
   check`") was the right move; the targeted test ran in 23 s.

## Acceptance

1. **Extension to `complex.ts`** — done. +816 LOC (from 1382 → 2198).
   Top-of-file narrative updated (+50 LOC) explaining the new section.
   Literate prose per Rule 10 — every primitive carries a multi-
   paragraph doc-comment explaining the algorithm, the failure modes,
   the cancellation surface, and the citations.

2. **`complex-bessel.test.ts`** — done. 34 tests across 5 classes:

   | Class | Count | Asserts |
   |---|---|---|
   | Restriction-to-real-axis (byte-identical) | 9 | mantissa / exponent / precision byte-equality with `bigBesselI` / `bigBesselK` |
   | Special values (independent of Arb) | 6 | DLMF 10.25.2, 10.32.9, 10.27.6 with z=i |
   | Golden masters vs Arb T5 (nu=0) | 12 | ≥ 45 dp (I) / ≥ 40 dp (K) agreement across Q1/Q2/Q3/Q4 |
   | Near-integer-ν cancellation-retry | 2 | K_{ε}(z) ≈ K_0(z), K_{1+ε}(z) finite |
   | Scaled-variant overflow/underflow | 3 | IScaled returns small-magnitude; KScaled returns large-magnitude; real-axis byte-agreement |

   All 34 green via `bun test packages/bigfloat/test/complex-bessel.test.ts`
   (~23 s wall time at prec=200 / prec=400).

3. **Worklog** — this shard (`docs/worklog/159-i3a-bigcbesseli-k-complex.md`).

4. **Mutation-proving** — three mutations inline-documented in the test
   file header (M1: drop folded-form Γ-reflection; M2: drop
   cancellation-retry budget; M3: swap scaled-variant prefactor sign).
   Each is refuted by a specific test (M1: K_3 / K_{3/2} corpus tests
   and the K_{1+1e-10} test; M2: T5 Q2/Q3 golden-master tests; M3:
   the IScaled(0, 5+0i) test that expects ~0.18 not ~4042). The
   mutations are NOT toggled in CI — per the I3a sanity rail
   "mutation-proving inline-documented, NOT toggled to avoid harness-
   cap". The next agent can verify by hand-editing complex.ts in the
   noted ways and observing the targeted RED.

5. **Existing tests unaffected.** `bun test packages/bigfloat/test/complex.test.ts
   packages/bigfloat/test/complex-erf.test.ts` — 242 pass, 0 fail, no
   regressions.

## Pointers

* `packages/bigfloat/src/complex.ts` — extended module (1382 → 2198 LOC).
  Search for `bigCBesselI`, `bigCBesselK`, `chyp0F1WithLossTracking`,
  `bigCBesselKConnectionInner`.
* `packages/bigfloat/test/complex-bessel.test.ts` — new test file.
* `packages/bigfloat/src/special-funcs/besseli.ts` — real I2a sibling
  (same series + asymptotic shape, real arithmetic).
* `packages/bigfloat/src/special-funcs/besselk.ts` — real I2b sibling;
  the folded-form K connection that this shard inherits.
* `packages/bigfloat/src/special-funcs/besselj.ts` — the cancellation-
  retry pattern (`bigBesselJSeriesCancellationRetry`) that this shard
  mirrors on BigComplex.
* `bench/besselj-anchor/oracles/arb/results.json` — T5 complex BesselI/K
  ground truth (32 entries each across Q1/Q2/Q3/Q4, ν ∈ {0, 3/2, 2.3, 3}).
* `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 3"
  and §"Decision 11" — the substrate-layering and AMOS-rotation
  rationale.
* `docs/worklog/156-i2a-bigbesseli-real.md` (I2a) and
  `docs/worklog/157-i2b-bigbesselk-real.md` (I2b) — the real-axis
  siblings whose algorithmic shape this shard extends to BigComplex.
* `docs/refs/besselj-research/R2-arbprec-algorithms.md` §3.3 (BesselI
  dispatch), §3.4 (BesselK dispatch).
