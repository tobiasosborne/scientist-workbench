# Phase 2 implementation plans — world-class Erf substrate

> **Audience:** Opus subagents claiming Phase 2 beads (`I1` `q30j`,
> `I2` `g82u`, `I3` `wzzq`, `I4` `bfwt`, `I5` `xiry`, `I6` `tc2c`,
> `I6a` `m114`).
> **Authority:** ADR-0040 pins the substrate architecture and the
> per-axis package boundaries. The plans below specialise the ADR's
> decisions into per-bead implementation guidance. When the ADR and
> a plan disagree, the ADR wins.
> **Decision principle:** every choice is answered by *"what would a
> legendary TS senior SE demand"* — branded types, total functions,
> literate top-of-file algorithm narratives (CLAUDE.md Rule 10),
> property tests + mutation-proving (Rule 6), deterministic forever
> per the appropriate ADR-0015/ADR-0020 tier.

## Dependency DAG (claim order)

```
Tier A — no Phase 2 prerequisites; can claim in parallel:
  I6a (vocab amendment for Erfi)
  I5  (float64 SunPro port)
  I1  (bigErf real BigFloat)

Tier B — claim after Tier A:
  I2  (bigErfc + bigErfcx — depends on I1 patterns)
  I4  (cas-core Erf identities — depends on I6a for Erfi rules)
  I3  (complex bigErf via Faddeeva — depends on I1's substrate patterns
        + extends bigfloat/src/complex.ts which exists already)

Tier C — claim after Tier B:
  I6  (Meijer-G bridge — depends on I6a for Erfi vocab; benefits from
        I4 for cross-checking simplify→bridge round-trips)
```

Each claimant declares `bd update <id> --claim` at start; updates to
`in_progress`; appends progress notes; calls `bd close <id>` when the
acceptance checklist is green and the orchestrator has verified the
output.

## Common discipline (every bead)

1. **Literate top-of-file narrative.** First 30-80 lines explain *why*
   the algorithm is shaped the way it is: which DLMF / paper formulas
   are encoded, what regimes apply, which numerical traps motivated
   each defensive check. Cite by section or paper-equation reference.
   No terse `// add 1` comments — write prose or delete.
2. **Pure TS on Bun.** No FFI, no `node:child_process`, no Python
   subprocess. The substrate must satisfy ADR-0020 (arbprec) or
   ADR-0015 (numerical) cleanly.
3. **Branded types where they buy clarity.** E.g. `type Precision =
   number & { __brand: "Precision-in-bits" }`. Worth it for `prec`
   parameters that mix with `BigFloat`'s `.precision` and `Number`-typed
   exponents in `BigFloat` internals.
4. **Total functions, loud failure.** Non-finite input ⇒ `RangeError`
   with a `suggestion:` line in the message. Never silent NaN.
5. **Property tests AND golden masters.** Property tests assert
   non-trivial invariants (`erf(-z) = -erf(z)`, etc.); goldens
   byte-compare against the Phase 1 corpus (`bench/erf-anchor/oracles/
   <id>/results.json`). Mutation-prove that perturbing a coefficient
   makes tests fail RED, then restore.
6. **Cancellation-driven precision retry mirrors `clgammaReflect`**
   (worklog 117, bead `oj5j`): measure loss as `magBits(blowUp) -
   magBits(finalValue)`, bump `work = prec + 32 + lossBits`.

---

# I6a — ADR-0023 amendment: admit `Erfi` to `SPECIAL_FUNCTION_HEADS`

**Bead:** `scientist-workbench-m114`
**Discovered by:** R4 (Meijer-G bridge research). The canonical G-form
table requires `Erfi` as a first-class head; cas-core's vocabulary
table at `packages/cas-core/src/special-functions.ts:105` doesn't have
it.
**Tier:** A (no prerequisites; unblocks I4 + I6).
**LOC estimate:** ~20-30 in `packages/cas-core/src/special-functions.ts`
+ ~30 in tests + 1-line edit each to 3 README files.

## Files

| Path | Change |
|---|---|
| `packages/cas-core/src/special-functions.ts` | Append `"Erfi"` to `SPECIAL_FUNCTION_HEADS`; add `case "Erfi"` to `specialFunctionArity` (returns `{kind:"fixed", count:1}`); add `case "Erfi"` to `differentiateSpecialFunction` (returns the diff rule). |
| `packages/cas-core/test/special-functions.test.ts` | Per-head arity test + diff rule test + foreign-pass-through test. |
| `docs/adr/0023-cas-core-special-function-vocabulary.md` | Add one-paragraph amendment under §"Decision" noting the table grew 27 → 28 admitting `Erfi`. Reference ADR-0040 §"Decision 6". |
| `packages/cas-core/README.md` | Update the vocabulary count and add `Erfi` to the named-heads list. |
| `tools/cas-diff/README.md` | Update the differentiable-heads table to include `Erfi(z) → (2/√π)·exp(z²)`. |

## Diff rule

```ts
// In differentiateSpecialFunction, after the existing cases:
case "Erfi": {
  // d/dz Erfi(z) = (2/√π)·exp(z²) — DLMF §7.10.2.
  const [z] = args;
  if (!matchesSym(z, wrt)) return ZERO;
  // (2/√π) · exp(z²) — emit via the closed elementary vocabulary
  // so the result is itself differentiable.
  const twoOverSqrtPi = mkDiv(int(2n), mkPower(sym("pi"), rat(1n, 2n)));
  const expZSquared = expr("exp", [mkPower(z, int(2n))]);
  return mkTimes(twoOverSqrtPi, expZSquared);
}
```

Closes within the existing elementary vocabulary (`exp`, `^`, `*`,
`/`, `sqrt` via `^` and `1/2`). The output is differentiable
recursively — no new vocabulary heads introduced.

## Tests

```ts
test("specialFunctionArity Erfi", () => {
  expect(specialFunctionArity("Erfi")).toEqual({ kind: "fixed", count: 1 });
});

test("differentiate Erfi(z) wrt z = (2/√π)·exp(z²)", () => {
  const z = sym("z");
  const expected = mkTimes(
    mkDiv(int(2n), mkPower(sym("pi"), rat(1n, 2n))),
    expr("exp", [mkPower(z, int(2n))]),
  );
  const actual = differentiate(expr("Erfi", [z]), z);
  expect(canonicalize(actual)).toBe(canonicalize(expected));
});

test("differentiate Erfi(x) wrt y = 0 (different variable)", () => {
  const x = sym("x"), y = sym("y");
  const result = differentiate(expr("Erfi", [x]), y);
  expect(canonicalize(result)).toBe(canonicalize(ZERO));
});

test("Erfi survives foreign-pass-through in cas-simplify", () => {
  // ... pattern from existing special-functions.test.ts
});
```

## Acceptance

- [ ] `Erfi` added to `SPECIAL_FUNCTION_HEADS` (length 28).
- [ ] `specialFunctionArity("Erfi") === {kind: "fixed", count: 1}`.
- [ ] `differentiate(expr("Erfi", [sym("z")]), sym("z"))` returns the
  closed-form `(2/√π)·exp(z²)` per DLMF §7.10.2.
- [ ] ADR-0023 has a paragraph noting the amendment with date and
  ADR-0040 cross-reference.
- [ ] `packages/cas-core/README.md`, `tools/cas-diff/README.md`,
  main `README.md` catalog row updated.
- [ ] `bun run check` green.
- [ ] Worklog shard added (or extended) noting the vocab amendment.

---

# I1 — `bigErf` real (BigFloat)

**Bead:** `scientist-workbench-q30j`
**Tier:** A (no Phase 2 prerequisites). Entry point for the arb-prec
real lane.
**LOC estimate:** ~300-450 in `packages/bigfloat/src/special-funcs/erf.ts`
+ ~150 in tests.
**Algorithm:** Arb-style series/asymptotic dispatch on the derived
crossover `x_c(p) := √(p · ln 2)`. Series uses **DLMF 7.6.2 Borel
form** (all-positive terms, zero alternation); asymptotic uses DLMF
7.12.1 with optimal-truncation termination mirroring
`lgammaStirling` (`packages/bigfloat/src/special.ts:117`).

## Files

| Path | Change |
|---|---|
| `packages/bigfloat/src/special-funcs/erf.ts` | NEW. Real-axis `bigErf` (this bead). Exports `bigErf`, `bigErfSeries`, `bigErfcAsymptotic`, `bigErfcContinuedFraction` (the latter two are package-internal — I2 will hoist `bigErfc` on top of them). |
| `packages/bigfloat/src/index.ts` | Re-export `bigErf` from the new module. |
| `packages/bigfloat/test/erf.test.ts` | NEW. Golden-master tests against `bench/erf-anchor/oracles/{wolfram,mpmath,boost}/results.json` at 50, 100, 200 decimals; property tests; mutation-proving notes. |
| `packages/bigfloat/README.md` | Update to list the new exported functions in the special-functions section. |

## API signatures

```ts
import type { BigFloat } from "../types.js";

/**
 * Real-axis error function at user-controlled precision.
 *
 * `bigErf(x, prec) = (2/√π) ∫₀ˣ e^(-t²) dt`
 *
 * Algorithm split (R2 §2.1 + DLMF §7.6 + §7.12):
 *   |x| ≤ x_c(prec)  → bigErfSeries (DLMF 7.6.2 Borel form)
 *   |x| > x_c(prec)  → 1 - bigErfcAsymptotic(x)  (via Z2's `bigErfc`
 *                       direct path; in this bead, only the real-axis
 *                       erf dispatch lives here — erfc/erfcx ship in I2.)
 *
 * @throws RangeError on non-finite input.
 */
export function bigErf(x: BigFloat, prec: number): BigFloat;

// Package-internal — exposed for I2's reuse.
export function bigErfSeries(x: BigFloat, prec: number): BigFloat;
export function bigErfcAsymptotic(x: BigFloat, prec: number): BigFloat;
export function bigErfcContinuedFraction(x: BigFloat, prec: number): BigFloat;
```

## Algorithm — `bigErfSeries`

Borel form (DLMF 7.6.2):

```
erf(z) = (2/√π) · e^(-z²) · Σ_{n=0}^∞  (2z²)^n · n! / (2n+1)!
       = (2/√π) · z · e^(-z²) · Σ_{n=0}^∞  (2z²)^n / (1·3·5···(2n+1))
```

Single-step ratio recurrence: `term_{n+1} = term_n · 2z² / (2n+3)`.
All-positive terms (zero alternation). Convergence radius ∞;
truncate when next term is `< 2^-(prec + safety)`.

```ts
function bigErfSeries(x: BigFloat, prec: number): BigFloat {
  // Pseudocode — flesh out with proper BigFloat arithmetic & cancellation
  // tracking. See packages/bigfloat/src/special.ts:117 lgammaStirling
  // for the canonical idiom.
  const work = prec + 64;                     // 64-bit safety margin
  const zSquared = mul(x, x, work);
  const twoZSquared = mul(zSquared, fromInt(2n, work), work);
  const expNegZSquared = exp(neg(zSquared, work), work);
  let sum = fromInt(1n, work);                // first term: (2z²)^0 / 1 = 1
  let term = fromInt(1n, work);
  for (let n = 0; n < 10_000; n++) {
    const newTerm = div(mul(term, twoZSquared, work), fromInt(BigInt(2 * n + 3), work), work);
    sum = add(sum, newTerm, work);
    if (magBits(newTerm) < magBits(sum) - prec - 8) break;   // converged
    term = newTerm;
  }
  // Result: (2/√π) · x · e^(-z²) · sum
  const sqrtPi = sqrt(pi(work), work);
  const twoOverSqrtPi = div(fromInt(2n, work), sqrtPi, work);
  const result = mul(mul(twoOverSqrtPi, x, work), mul(expNegZSquared, sum, work), work);
  return normalise(result.mantissa, result.exponent, prec);
}
```

## Algorithm — `bigErfcAsymptotic` (used by I2, defined here)

DLMF 7.12.1 asymptotic expansion at infinity:

```
erfc(z) ~ (e^(-z²) / (√π · z)) · Σ_{m=0}^∞  (-1)^m · (2m-1)!! / (2z²)^m
```

The series diverges (asymptotic, not convergent). Truncate at the
smallest term: track `|term_m|`; when `|term_{m+1}| > |term_m|`, stop
adding and use the current sum. Same idiom as `lgammaStirling`'s
optimal-truncation loop.

## Algorithm — `bigErfcContinuedFraction` (used by I2)

Laplace continued fraction (DLMF 7.9.1):

```
√π · z · e^(z²) · erfc(z) = 1 / (z² + (1/2) / (1 + 1 / (z² + (3/2) / (1 + 2 / (z² + …)))))
```

Modified Lentz method to evaluate. Converges for `Re(z) > 0`; rate
~1/|z|² per cycle, so this lane is best at mid-to-large `|z|` where the
asymptotic is just starting to be valid.

## Crossover

```ts
function crossoverXc(prec: number): number {
  // x_c(prec) := √(prec · ln 2)  per R2 §"Crossover (real)".
  // For prec = 196 (50 dps): x_c ≈ 11.66. For prec = 53 (float64): ≈ 6.06.
  return Math.sqrt(prec * Math.LN2);
}
```

## Tests

```ts
import { describe, test, expect } from "bun:test";
import { bigErf } from "../src/special-funcs/erf.js";
import { fromString, toFloat64 } from "../src/conversion.js";

const ORACLE_PATH = "../../bench/erf-anchor/oracles";

describe("bigErf — golden masters (gold tier: Wolfram + mpmath)", () => {
  // Load all corpus inputs where head === "Erf" and tier ∈ {T1, T2, T3}
  // (real-axis inputs). For each, compute bigErf at 200 prec bits; compare
  // against mpmath@55dp string output truncated to 50 decimals.
  const goldens = loadOracleResults("mpmath").filter(
    (r) => r.head === "Erf" && /^T[123]-/.test(r.input_id)
  );
  for (const g of goldens.slice(0, 20)) {   // representative sample at first
    test(`bigErf(${g.z}) matches mpmath to ≥48 decimals`, () => {
      const x = fromString(g.z, 200);
      const result = bigErf(x, 200);
      // Format result as decimal-string at 50 dp; byte-compare.
      // Use the same canonicalScientific shape G8 uses.
      // ...
    });
  }
});

describe("bigErf — properties", () => {
  test("Erf(0) = 0 at every precision", () => {
    for (const p of [53, 100, 200, 500]) {
      expect(toFloat64(bigErf(fromInt(0n, p), p)).value).toBe(0);
    }
  });

  test("Erf(-z) = -Erf(z) byte-identical", () => {
    for (const xs of ["0.1", "0.5", "1.0", "2.0", "5.0"]) {
      const x = fromString(xs, 200);
      const minusX = neg(x);
      const lhs = bigErf(minusX, 200);
      const rhs = neg(bigErf(x, 200));
      expect(eq(lhs, rhs)).toBe(true);   // byte-identical via BigFloat eq
    }
  });

  test("Erf(∞) = 1 (limit; document explicit input handling)", () => {
    // Non-finite handling: bigErf should throw RangeError per the
    // legendary-SE total-function discipline. Verify the throw.
    const inf = { mantissa: 0n, exponent: 1_000_000, precision: 200 };  // sentinel
    expect(() => bigErf(inf as any, 200)).toThrow(RangeError);
  });

  test("Determinism — same input + prec → byte-identical output across runs", () => {
    const x = fromString("0.5", 200);
    const a = bigErf(x, 200);
    const b = bigErf(x, 200);
    expect(a.mantissa).toBe(b.mantissa);
    expect(a.exponent).toBe(b.exponent);
    expect(a.precision).toBe(b.precision);
  });
});
```

## Mutation-proving

The implementer must demonstrate (in a note in the worklog shard or
commit message) that at least 3 distinct perturbations of the
algorithm cause the test suite to fail RED:

1. Change `(2n + 3)` → `(2n + 1)` in the series ratio recurrence;
   confirm series-tier tests fail.
2. Change `Math.LN2` → `Math.LN10` in `crossoverXc`; confirm
   crossover-boundary tests fail.
3. Drop the `e^(-z²)` prefactor in `bigErfSeries`; confirm large-z
   tests fail.

Restore the impl; tests green.

## Acceptance

- [ ] `packages/bigfloat/src/special-funcs/erf.ts` implemented per R2.
- [ ] 30-line top-of-file algorithm narrative (Borel form vs textbook
  Maclaurin trap; crossover derivation; cancellation-retry pattern).
- [ ] `bigErf` and the package-internal substrate primitives
  (`bigErfSeries`, `bigErfcAsymptotic`, `bigErfcContinuedFraction`)
  exported.
- [ ] Golden masters pass at 50, 100, 200 decimals against mpmath and
  Wolfram for the T1 / T2 / T3 input subset (with the Phase 1 G8 fix
  for Wolfram exponent-loss landed first).
- [ ] Property tests green (parity, zero, determinism).
- [ ] Mutation-proving documented in worklog shard.
- [ ] `bun run check` green.

---

# I2 — `bigErfc` + `bigErfcx` (real)

**Bead:** `scientist-workbench-g82u`
**Tier:** B (claim after I1 lands the substrate primitives).
**LOC estimate:** ~150-200 added to
`packages/bigfloat/src/special-funcs/erf.ts` + ~100 in tests.
**Algorithm:** R2's critical risk-mitigation: `bigErfc` MUST NOT be
`1 - bigErf(x)` for `|x| > x_c` (catastrophic cancellation costs
`x²·log₂e` bits — at `x = 20`, ~580 bits gone). Each function has its
own algorithmic path on its own input range. `bigErfcx(x) =
exp(x²)·erfc(x)` is computed DIRECTLY (mirrors
`SpecialFunctions.jl::_erfcx(::BigFloat)`); never via `exp(x²) ·
bigErfc(x)` round-trip.

## Files

| Path | Change |
|---|---|
| `packages/bigfloat/src/special-funcs/erf.ts` | EXTEND. Export `bigErfc`, `bigErfcx`. Use I1's `bigErfSeries`, `bigErfcAsymptotic`, `bigErfcContinuedFraction` substrate primitives. |
| `packages/bigfloat/src/index.ts` | Re-export. |
| `packages/bigfloat/test/erf.test.ts` | EXTEND. Add `bigErfc` + `bigErfcx` golden-masters + property tests. |

## API signatures

```ts
export function bigErfc(x: BigFloat, prec: number): BigFloat;
export function bigErfcx(x: BigFloat, prec: number): BigFloat;   // scaled = e^(x²) · erfc(x)
```

## Algorithm — `bigErfc`

```ts
export function bigErfc(x: BigFloat, prec: number): BigFloat {
  const xc = crossoverXc(prec);
  const absX = abs(x);
  if (cmp(absX, fromFloat(xc)) <= 0) {
    // Small x: erfc(x) = 1 - erf(x). For |x| ≤ x_c the cancellation
    // budget is healthy: erf(x) is at most ~tanh(x) which stays well
    // below 1, so 1 - erf(x) loses at most log₂(1 / (1 - tanh(x_c))) bits
    // — bounded by ~x_c²/2 in the worst case, which the 64-bit margin
    // absorbs at every prec we ship.
    const work = prec + 64;
    const erfX = bigErf(x, work);
    const one = fromInt(1n, work);
    return normaliseTo(sub(one, erfX, work), prec);
  }
  // Large positive x: use the direct asymptotic.
  if (sgn(x) > 0) {
    return bigErfcAsymptotic(x, prec);
  }
  // Large negative x: erfc(-x) = 2 - erfc(x), and the asymptotic gives
  // erfc(|x|) ≈ 0. So erfc(-large) ≈ 2.
  const work = prec + 64;
  const erfcAbsX = bigErfcAsymptotic(absX, work);
  const two = fromInt(2n, work);
  return normaliseTo(sub(two, erfcAbsX, work), prec);
}
```

## Algorithm — `bigErfcx` (direct, never via `exp(x²)·erfc(x)`)

Asymptotic form for large `x`:

```
erfcx(x) ~ (1 / (√π · x)) · Σ_{m=0}^∞  (-1)^m · (2m-1)!! / (2x²)^m
```

(Same coefficient ring as `erfc`'s asymptotic, but WITHOUT the
`e^(-x²)` prefactor.) For small `x` (|x| < some threshold), compute as
`exp(x²) · erfc(x)` is still safe because both factors stay finite and
the product is bounded near `1`. Threshold is `|x| < ~3` for which
`exp(x²) < exp(9) ≈ 8100` — easily representable in `BigFloat`.

The Karbach-style erfcx asymptotic (R2 §"Risk 3" — mirrors
SpecialFunctions.jl `_erfcx(::BigFloat)` lines 27-40):

```ts
export function bigErfcx(x: BigFloat, prec: number): BigFloat {
  const absX = abs(x);
  if (cmp(absX, fromFloat(3.0)) < 0) {
    // Small-x lane: compose via erfc (numerically safe in this range).
    const work = prec + 32;
    const expXSquared = exp(mul(x, x, work), work);
    const erfcX = bigErfc(x, work);
    return normaliseTo(mul(expXSquared, erfcX, work), prec);
  }
  // Large-x lane: direct asymptotic series (no exp(x²) round-trip).
  // ... per R2 §"Risk 3" + SpecialFunctions.jl reference.
}
```

## Tests

* Golden masters against mpmath and Wolfram for T2 / T3 / T7 inputs
  (the Stokes-band tier especially — bead `ybrw` is the downstream
  consumer).
* Property: `bigErfc(x) + bigErf(x) == 1` byte-identically at every
  precision (the `+` is BigFloat addition; the test reads
  `eq(add(bigErfc(x, p), bigErf(x, p), p), fromInt(1n, p))`).
* Property: `bigErfcx(x) · exp(-x²) == bigErfc(x)` byte-identically.
* Property: `bigErfc(-x) == 2 - bigErfc(x)`.
* Edge: large positive x (x = 28 → erfc ≈ 6.56e-343 per Phase 1
  goldens). Result must round-trip against mpmath/Boost exactly.

## Mutation-proving

1. Replace the `xc` check with `|x| > 100`; confirm T2 tests fail
   (cancellation regime is entered prematurely).
2. Replace `bigErfcAsymptotic` with `sub(one, bigErf(x, work), work)`
   in the large-positive branch; confirm `bigErfc(20)` test fails
   (catastrophic cancellation).
3. Drop the `exp(x²)` factor in `bigErfcx`'s small-x lane; confirm
   `bigErfcx(1)` test fails.

## Acceptance

- [ ] `bigErfc` and `bigErfcx` shipped with direct asymptotic paths.
- [ ] Goldens green against mpmath at 50, 100, 200 dp for T2 / T3 / T7
  Erfc + Erfcx tiers.
- [ ] Property `erfc + erf = 1` byte-identical at 50, 100, 200 dp.
- [ ] Property `erfcx · exp(-x²) = erfc` byte-identical.
- [ ] `bigErfc(20)` returns the correct ~e-176 value (NOT a garbage
  value that would result from `1 - bigErf`).
- [ ] Mutation-proving documented.

---

# I3 — Complex `bigErf` via Faddeeva `w(z)` (BigComplex)

**Bead:** `scientist-workbench-wzzq`
**Tier:** B (depends on I1's substrate patterns + extends
`packages/bigfloat/src/complex.ts`).
**LOC estimate:** ~400-600 in `packages/bigfloat/src/complex.ts`
extensions + ~150 in tests.
**Algorithm:** R2's Faddeeva pick — **Karbach 2014 / Weideman-Fourier**.
Closed-form `(τ_m, N)` prec-scaling. Single complex primitive `bigW`;
derive `bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi` algebraically.

## Files

| Path | Change |
|---|---|
| `packages/bigfloat/src/complex.ts` | EXTEND. Add `bigW`, `bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi` (sister to existing `cgamma` / `clgamma` / `cdigamma`). |
| `packages/bigfloat/src/index.ts` | Re-export. |
| `packages/bigfloat/test/complex-erf.test.ts` | NEW. Goldens vs Wolfram + mpmath complex outputs from T4 / T5 / T7 tiers; property tests (conjugate-symmetry, parity, restriction-to-real-axis bit-equality with I1's `bigErf`). |

## API signatures

```ts
import type { BigComplex } from "./complex.js";

export function bigW(z: BigComplex, prec: number): BigComplex;
export function bigCErf(z: BigComplex, prec: number): BigComplex;
export function bigCErfc(z: BigComplex, prec: number): BigComplex;
export function bigCErfcx(z: BigComplex, prec: number): BigComplex;
export function bigCErfi(z: BigComplex, prec: number): BigComplex;
```

## Algorithm — `bigW` (Karbach-Weideman)

Weideman's Fourier series in Faddeeva-space:

```
w(z) ≈ (i/π) · Σ_{n=-N}^{N}  a_n · e^{i n π z / τ_m}   for |Im z| < τ_m
```

with coefficients `a_n = e^{-(n π / τ_m)²}`. Closed-form
prec-dependence:

```
τ_m(p) = √(4·(p·ln 2 − ln 4))
N(p)   = ⌈(τ_m / π) · √(p·ln 2)⌉
```

At p = 53: `(τ_m, N) = (12, 23)` (matches Karbach published numbers).
At p = 196: `(23.3, 87)`. At p = 1024: `(53.3, 480)`.

Coefficient precomputation: cache `(τ_m, N, a_n[])` keyed on `prec`
(mirror the `_piCache` / `_ln2Cache` pattern in
`packages/bigfloat/src/transcendental.ts:41-43`).

Stokes-line singularities at `z_n = ±n·π/τ_m`: Karbach §5 handles via
5-term Taylor expansion in tiny discs. Implement as a fallback branch
when `|Im z + n·π/τ_m| < radius(p)` for any small integer `n`.

## Algorithm — `bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi`

R2 §"Pick: Karbach-Weideman" identity table:

```
erfcx(z) = w(iz)
erf(z)   = 1 − exp(−z²) · w(iz)                  for Re(z) ≥ 0
erf(z)   = exp(−z²) · w(−iz) − 1                 for Re(z) < 0
erfc(z)  = exp(−z²) · w(iz)                      for Re(z) ≥ 0
erfc(z)  = 2 − exp(−z²) · w(−iz)                 for Re(z) < 0
erfi(z)  = −i · erf(i·z)
```

These all reduce to `bigW`. Each one is a 5-10-line function.

## Tests

* Goldens against Wolfram + mpmath complex outputs from T4 + T5 + T7
  tiers (at 50, 100, 200 dp).
* Property: `bigCErf(conjugate(z)) = conjugate(bigCErf(z))`
  byte-identical.
* Property: `bigCErf(-z) = -bigCErf(z)`.
* Property: restriction to real axis matches I1's `bigErf`
  byte-for-byte. (For `z = x + 0i`, `bigCErf(z, prec).re == bigErf(x,
  prec)` AND `bigCErf(z, prec).im == 0`.) This is the load-bearing
  cross-validation that ties the complex and real paths.
* Property: `bigCErfc(z) + bigCErf(z) = 1` (in BigComplex, both real
  AND imag parts).
* Stokes-band tier T7: must agree with Wolfram at 48 dp throughout.

## Mutation-proving

1. Swap `iz` ↔ `-iz` in the half-plane sign split; confirm Q3/Q4
   complex tests fail.
2. Drop the Stokes-line Taylor fallback; confirm `bigW(i·π/τ_m)` fails.
3. Substitute `4·(p·ln 2)` → `2·(p·ln 2)` in `τ_m`; confirm 100-dp
   tests start failing at the band edges.

## Acceptance

- [ ] `bigW` shipped; per-prec coefficient caching in place.
- [ ] `bigCErf`, `bigCErfc`, `bigCErfcx`, `bigCErfi` derived algebraically.
- [ ] Goldens green at 50, 100, 200 dp against Wolfram for T4 / T5 / T7.
- [ ] Restriction-to-real-axis property holds byte-identically.
- [ ] Stokes-band tests green.
- [ ] Mutation-proving documented.

---

# I4 — `cas-core` Erf identity table

**Bead:** `scientist-workbench-bfwt`
**Tier:** B (depends on I6a for `Erfi` vocab).
**LOC estimate:** ~200-300 in
`packages/cas-core/src/special-funcs/erf-identities.ts` + ~150 in
tests.

## Files

| Path | Change |
|---|---|
| `packages/cas-core/src/special-funcs/erf-identities.ts` | NEW. Identity table per R1's 22 v0.1-shippable rules. |
| `packages/cas-core/src/simplify.ts` | EXTEND. Hook erf-identities into the rewriter dispatch. |
| `packages/cas-core/test/erf-identities.test.ts` | NEW. Per-rule tests. |
| `packages/cas-core/README.md` | Updated to describe the new identity table. |
| `tools/cas-simplify/README.md` | Updated to list Erf identities. |

## Identity table (v0.1 — the 22 always-fires rules per R1)

```ts
// packages/cas-core/src/special-funcs/erf-identities.ts
import type { Value } from "@workbench/protocol";

interface ErfRule {
  readonly id: string;
  readonly source: string;
  readonly head: "Erf" | "Erfc" | "Erfi" | "InverseErf" | "InverseErfc";
  readonly match: (args: readonly Value[]) => boolean;
  readonly rewrite: (args: readonly Value[]) => Value;
}

export const ERF_RULES: readonly ErfRule[] = [
  // Special values — R1 §1
  { id: "erf-zero",         source: "DLMF 7.2.1",  head: "Erf",         match: (a) => isZero(a[0]),       rewrite: () => ZERO },
  { id: "erf-pos-infinity", source: "DLMF 7.2.4",  head: "Erf",         match: (a) => isPositiveInf(a[0]),rewrite: () => ONE },
  { id: "erf-neg-infinity", source: "DLMF 7.2.4",  head: "Erf",         match: (a) => isNegativeInf(a[0]),rewrite: () => mkNeg(ONE) },
  { id: "erfc-zero",        source: "DLMF 7.2.2",  head: "Erfc",        match: (a) => isZero(a[0]),       rewrite: () => ONE },
  // ... R1 §1 enumerates all the special-value cases ...

  // Parity / symmetry — R1 §2
  { id: "erf-neg",          source: "DLMF 7.4.1",  head: "Erf",         match: (a) => isNeg(a[0]),        rewrite: (a) => mkNeg(expr("Erf",  [stripNeg(a[0])])) },
  { id: "erfi-neg",         source: "SymPy:erfi", head: "Erfi",         match: (a) => isNeg(a[0]),        rewrite: (a) => mkNeg(expr("Erfi", [stripNeg(a[0])])) },
  { id: "erfi-i-times",     source: "SymPy:erfi", head: "Erfi",         match: (a) => isIMultiple(a[0]),  rewrite: (a) => mkNeg(mkTimes(I, expr("Erf", [stripI(a[0])]))) },
  // ... R1 §2 ...

  // Algebraic relations — R1 §3
  // Note: "erfc + erf = 1" is NOT a rule in the simplifier — it's a
  // cross-head identity that lives in cas-verify's territory.

  // (etc — R1 §11 has all 38 rules with TS-ready scaffolding)
];

export function tryErfSimplify(head: string, args: readonly Value[]): Value | null {
  for (const rule of ERF_RULES) {
    if (rule.head !== head) continue;
    if (rule.match(args)) return rule.rewrite(args);
  }
  return null;
}
```

The dispatcher hook in `simplify.ts` calls `tryErfSimplify` on every
recursive descent into an `expression` node whose head is in
`{Erf, Erfc, Erfi, InverseErf, InverseErfc}`. On hit, the rewriter
recurses on the result (because rewrites can cascade — e.g. `Erfi(z)`
rewrites to `-i·Erf(iz)`, and the result has an Erf head that may
itself be simplifiable).

## Tests

```ts
test("Erf(0) = 0", () => {
  expect(canonicalize(tryErfSimplify("Erf", [ZERO])!)).toBe(canonicalize(ZERO));
});

test("Erfi(z) = -i·Erf(iz) — canonicalisation collapses Erfi", () => {
  const z = sym("z");
  const result = tryErfSimplify("Erfi", [z]);
  const expected = mkNeg(mkTimes(I, expr("Erf", [mkTimes(I, z)])));
  expect(canonicalize(result!)).toBe(canonicalize(expected));
});

test("Erfc(z) + Erf(z) collapses in cas-simplify", () => {
  // This is an addition-rule simplification; tests the full simplify
  // pipeline, not just tryErfSimplify.
  const z = sym("z");
  const input = mkPlus(expr("Erfc", [z]), expr("Erf", [z]));
  const result = simplify(input);
  expect(canonicalize(result)).toBe(canonicalize(ONE));
});

test("Idempotence: simplify(simplify(v)) = simplify(v)", () => {
  for (const v of [/* test corpus */]) {
    const once = simplify(v);
    const twice = simplify(once);
    expect(canonicalize(once)).toBe(canonicalize(twice));
  }
});
```

## Acceptance

- [ ] 22+ rules from R1 §11 implemented as `ERF_RULES`.
- [ ] `tryErfSimplify` integrated into `simplify.ts`'s dispatcher.
- [ ] Per-rule tests (one per rule).
- [ ] `Erfc(z) + Erf(z) → 1` collapse works end-to-end.
- [ ] Idempotence property holds.
- [ ] Foreign-pass-through preserved (unknown args round-trip).

---

# I5 — Float64 Erf dispatcher (SunPro 1993 port)

**Bead:** `scientist-workbench-xiry`
**Tier:** A (no prereqs; independent of arb-prec lane).
**LOC estimate:** ~600-900 in
`packages/quadrature/src/special-funcs/erf-float64.ts` (the SunPro
port is the bulk; Cody coefficient tables are ~200 numbers verbatim) +
~100 in dispatcher hook + ~150 in tests.
**Algorithm:** R3 — port Sun Microsystems 1993 `s_erf.c` verbatim
(musl / glibc / FreeBSD lineage; ≤ 1 ULP `erf`, ≤ 2 ULP `erfc`).
Complex via Faddeeva-Johnson 2012 MIT (Stephen Johnson's `Faddeeva.cc`
verbatim port). Inverses via Blair-Edwards-Johnson 1976 rational
approximants.

## Files

| Path | Change |
|---|---|
| `packages/quadrature/src/special-funcs/erf-float64.ts` | NEW. SunPro 1993 verbatim port for real; Faddeeva-Johnson for complex; Blair-Edwards-Johnson for inverses. |
| `packages/quadrature/src/eval-numeric-expr.ts` | NEW. Wraps `eval-expr.ts` with `applySpecial(head, args, env)` dispatch. |
| `packages/quadrature/src/index.ts` | Re-export the new module + dispatcher. |
| `packages/quadrature/test/erf-float64.test.ts` | NEW. ULP-distance comparison against SciPy bronze tier; edge tests. |
| `packages/quadrature/README.md` | Updated to describe the special-function extension. |

## Critical impl detail: the `SET_LOW_WORD` mantissa-truncation helper

R3 §1 highlighted this as THE load-bearing numerical trick: in the
asymptotic branches, `exp(-x²)` is split as
`exp(-s²-0.5625) · exp((s-x)(s+x) + R/S)` with `s = x` having its
mantissa truncated by zeroing the low 32 bits.

```ts
/**
 * Truncate the low 32 bits of a float64's mantissa, returning the
 * resulting float64. JS port of SunPro `s_erf.c`'s SET_LOW_WORD(s, 0).
 */
function maskLowWord(x: number): number {
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const u = new Uint32Array(buf);
  f[0] = x;
  // IEEE-754 double: u[0] = low word, u[1] = high word (little-endian
  // platforms only — V8 / Bun is little-endian on every platform we
  // ship). Document the endianness assumption with a runtime check at
  // module load: throw RangeError if (new Uint8Array(buf))[0] === 0
  // after setting f[0] = 1.0 (i.e. big-endian).
  u[0] = 0;
  return f[0];
}
```

Runtime endianness check at module load: assert
little-endian once, throw RangeError if violated. Bun targets V8 which
is little-endian on every supported platform.

## Algorithm — `erfFloat64` (the canonical real lane)

```ts
export function erfFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  const ax = Math.abs(x);
  // Branch by |x| per R3 §1 table.
  if (ax < 0x1p-28) { return /* linear underflow-safe */ x + EFX8 * x / 8; }
  if (ax < 0.84375) { return /* odd rational pp/qq */ x + x * polyEval(PP, x*x) / polyEval(QQ, x*x); }
  if (ax < 1.25)    { return /* erfc = (1-erx) - P1/Q1 piece */ /* sign-handled */ }
  if (ax < 1/0.35)  { return /* asymptotic R1/S1 piece */ }
  if (ax < 28)      { return /* asymptotic R2/S2 piece */ }
  return x > 0 ? 1 - 0x1p-1022 : -(1 - 0x1p-1022);   // saturation
}
```

The coefficient arrays `PP`, `QQ`, `P1`, `Q1`, `R1`, `S1`, `R2`, `S2`,
`EFX`, `EFX8`, `ERX` are the literal Cody Chebyshev coefficients from
SunPro `s_erf.c`. Emit as `const PP = [1.28379167095512558561e-01,
-3.25042107247001499370e-01, ...]` — shortest-round-trip 17-digit
literals (V8 parses these bit-exactly per ECMAScript 11.1.3.3).

Copy directly from `https://git.musl-libc.org/cgit/musl/tree/src/math/erf.c`
or `https://github.com/freebsd/freebsd-src/blob/main/lib/msun/src/s_erf.c`
(both BSD-licensed). Document the source file commit hash + license
header in the top-of-file narrative.

## Algorithm — `erfComplexFloat64` (Faddeeva-Johnson port)

Port Stephen G. Johnson's `Faddeeva.cc`
(<https://github.com/stevengj/Faddeeva>, MIT-licensed) to TS. The C++
is ~2500 LOC; the TS port should be comparable. Three regions:

* **Large `|z|`**: Poppe-Wijers 1990 continued fraction; term count
  `nu = ⌈3 + 1442 / (26ρ + 77)⌉` with `ρ = √((x/6.3)² + (y/4.4)²)`.
* **Bulk**: Zaghloul-Ali Algorithm 916 (ACM TOMS 38(2), 2011); series
  in `exp(-a²n²)` with `a = π / √(-log(ε/2))`.
* **Bad band** `6 < x < 28, y < 0.1`: Algorithm 916 (continued
  fraction loses 5 bits in Re w here).
* **Real axis**: 100-panel Chebyshev `erfcx_y100` / `w_im_y100`
  lookup; Dawson function.
* **Small |z| `erf`**: 5-term Taylor to avoid `1 - exp(-z²)·w(iz)`
  cancellation.

## Algorithm — inverses (Blair-Edwards-Johnson 1976)

Port verbatim from SpecialFunctions.jl `_erfinv(::Float64)` /
`_erfcinv(::Float64)`. Three tables per inverse function (`|x| ≤
0.75`, `0.75 < |x| ≤ 0.9375`, `|x| > 0.9375` for erfinv; analogous for
erfcinv).

## Dispatcher hook

```ts
// packages/quadrature/src/eval-numeric-expr.ts
import { evalNumericExpr as evalBase, ADMITTED_HEADS as ADMITTED_ELEM } from "./eval-expr.js";
import { erfFloat64, erfcFloat64, erfcxFloat64, erfiFloat64, erfInvFloat64, erfcInvFloat64 } from "./special-funcs/erf-float64.js";

export const ADMITTED_HEADS = [
  ...ADMITTED_ELEM,
  "Erf", "Erfc", "Erfcx", "Erfi", "InverseErf", "InverseErfc",
];

const SPECIAL_DISPATCH = new Map<string, (args: number[]) => number>([
  ["Erf",         (a) => erfFloat64(a[0])],
  ["Erfc",        (a) => erfcFloat64(a[0])],
  ["Erfcx",       (a) => erfcxFloat64(a[0])],
  ["Erfi",        (a) => erfiFloat64(a[0])],
  ["InverseErf",  (a) => erfInvFloat64(a[0])],
  ["InverseErfc", (a) => erfcInvFloat64(a[0])],
]);

export function evalNumericExpr(e: Value, env: Map<string, number>): number {
  // Recursive evaluation: first walk the AST with `evalBase`, but
  // intercept special-function heads. The cleanest shape is to extend
  // the existing `applyHead` dispatch in eval-expr.ts to call out to
  // SPECIAL_DISPATCH when the head matches; see the existing case
  // statements in eval-expr.ts:186-243 for the pattern.
  return evalBase(e, env, { onSpecialHead: (head, args) => {
    const fn = SPECIAL_DISPATCH.get(head);
    return fn ? fn(args) : null;   // null ⇒ unknown head ⇒ throw UnknownVocabularyError
  }});
}
```

The exact integration shape depends on how `eval-expr.ts` is
currently structured. The implementer must adapt without breaking
existing call sites; the literate prose at the top documents the
extension point.

## Tests

* ULP-distance ≤ 2 against SciPy bronze tier (`bench/erf-anchor/
  oracles/scipy/results.json`) for every real T1-T3 input.
* ULP-distance ≤ 2 against SciPy complex outputs for T4 / T5 / T7
  (`scipy.special.wofz` reference + Karbach derivation).
* Edge cases: ±0 → 0, ±∞ → ±1, NaN → NaN, subnormal min → 0, denormal
  extreme handled.
* Property: `erfFloat64(-x) === -erfFloat64(x)` exactly (sign-symmetric).
* Property: `erfFloat64(x) + erfcFloat64(x) === 1` (with float64
  caveat: for `|x|` near 0 this is exact; for `|x|` large it's exact
  too because erfc collapses to <ULP).
* Cross-check with `bigErf(fromFloat(x, 53), 53)`: float64 result must
  match the 53-bit BigFloat result bit-for-bit (this is the
  numerical-vs-arbprec contract).

## Mutation-proving

1. Replace one coefficient in `PP` with a small perturbation; confirm
   T1 tests fail.
2. Drop the `SET_LOW_WORD` mantissa-mask; confirm T3 erfc tests fail
   (cancellation in `exp(-x²)` split).
3. Swap the Faddeeva region boundary `|y| > 7`; confirm T7 Stokes-band
   tests fail.

## Acceptance

- [ ] SunPro `s_erf.c` ported verbatim with literate top-of-file
  citation (source URL + commit hash + BSD license header).
- [ ] Faddeeva-Johnson `Faddeeva.cc` ported with MIT license header
  cited.
- [ ] Blair-Edwards-Johnson 1976 inverse rational approximants per
  SpecialFunctions.jl.
- [ ] `applySpecial` dispatcher hooked into `eval-numeric-expr.ts`.
- [ ] Goldens green: ULP ≤ 2 vs SciPy on every real T1-T3 and complex
  T4 / T5 / T7 input.
- [ ] Bit-equal round-trip with `bigErf` at prec=53.
- [ ] `bun run check` green.
- [ ] Mutation-proving documented.

---

# I6 — Meijer-G bridge for Erf

**Bead:** `scientist-workbench-tc2c`
**Tier:** C (depends on I6a Erfi vocab; benefits from I4 cas-core
identities).
**LOC estimate:** ~200-300 in
`packages/meijer-core/src/bridges/erf.ts` + ~50 in tests +
extension to `packages/meijer-core/src/dispatch-types.ts` for the
`zMatch?` predicate.

## Files

| Path | Change |
|---|---|
| `packages/meijer-core/src/bridges/types.ts` | NEW. `MeijerGForm` + `ForwardBridge` + bridge-API types. |
| `packages/meijer-core/src/bridges/erf.ts` | NEW. `headToMeijerG('Erf'|'Erfc'|'Erfi', [z])` + `meijerGToHead(form)` per R4 §1-§2. |
| `packages/meijer-core/src/dispatch-types.ts` | EXTEND. Add optional `zMatch?: (z: Value) => "yes"|"no"|"unknown"` to `PatternSpec` for the Erf-Erfi parameter-tuple disambiguator. |
| `packages/meijer-core/src/dispatch-rules/erf-forward-form-a.ts` | NEW. Form A.Erf forward dispatch rule per R4 §1. |
| `packages/meijer-core/src/dispatch-rules/erfc-forward.ts` | NEW. Erfc forward rule. |
| `packages/meijer-core/src/dispatch-rules/erfi-forward.ts` | NEW. Erfi forward rule (requires `zMatch` extension). |
| `packages/meijer-core/src/index.ts` | Re-export. |
| `packages/meijer-core/test/bridges-erf.test.ts` | NEW. Round-trip property + per-form tests. |

## API per R4 §3

```ts
// packages/meijer-core/src/bridges/types.ts
export interface MeijerGForm {
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
}

export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;        // applies prefactor
  readonly zInverse: () => readonly Value[];      // recovers original args byte-identically
}

export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null;

export function meijerGToHead(
  form: MeijerGForm,
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null;
```

## Canonical G-form table per R4 §1

(Wolfram-convention MeijerG[{{a_top},{a_bot}}, {{b_top},{b_bot}}, z])

| Head | `(m,n,p,q)` | `an` | `ap` | `bm` | `bq` | z-sub | prefactor |
|---|---|---|---|---|---|---|---|
| `Erf(z)`  | `(1,1,1,2)` | `[1/2]` | `[]` | `[0]` | `[-1/2]` | `z²` | `z/√π` |
| `Erfc(z)` | `(2,0,1,2)` | `[]` | `[1]` | `[0, 1/2]` | `[]` | `z²` | `1/√π` |
| `Erfi(z)` | `(1,1,1,2)` | `[1/2]` | `[]` | `[0]` | `[-1/2]` | `-z²` | `z/√π` |
| `Erf⁻¹`, `Erfc⁻¹` | NONE | — | — | — | — | — | — |

Note: Erf and Erfi share an identical parameter tuple; the z-sub
sign is the only discriminator. The `zMatch` predicate extension is
required for the backward bridge to disambiguate.

## `zInverse` closure trick (R4 §3)

Forward records the original `args` in a closure on the
`ForwardBridge` record; backward calls `zInverse()` to recover them
byte-identically. Avoids the multi-valued `√(z²)` problem.

```ts
export function headToMeijerG(head: string, args: readonly Value[]): ForwardBridge | null {
  switch (head) {
    case "Erf": {
      const [z] = args;
      const zSquared = mkPower(z, int(2n));
      const gForm: MeijerGForm = {
        an: [rat(1n, 2n)], ap: [], bm: [int(0n)], bq: [rat(-1n, 2n)], z: zSquared,
      };
      const wrap = (g: Value) => mkTimes(mkDiv(z, mkPower(sym("pi"), rat(1n, 2n))), g);
      const zInverse = () => [z] as const;
      return { gForm, wrap, zInverse };
    }
    case "Erfc": { /* ... */ }
    case "Erfi": { /* ... */ }
    case "InverseErf":
    case "InverseErfc":
      return null;                                  // honest refusal per R4 §1
    default:
      return null;                                  // not in this bridge's scope
  }
}
```

Backward bridge: pattern-match the G-form against each canonical
shape; on hit, return `{head, args}` using the original args
recovered via the matched rule's logic (NOT via `√(g.z)`).

## `PatternSpec` extension for Erf/Erfi disambiguation

```ts
// packages/meijer-core/src/dispatch-types.ts
export interface PatternSpec {
  // ... existing fields ...
  /**
   * Optional predicate to disambiguate G-forms with identical
   * (an, ap, bm, bq) tuples but distinct z-argument shapes.
   * "yes" → match accepted. "no" → match rejected (next rule tried).
   * "unknown" → fall through with current behavior.
   *
   * Introduced for the Erf vs Erfi tuple collision (R4 §2.5.1):
   * both heads share an=[1/2], ap=[], bm=[0], bq=[-1/2]; the
   * difference is whether the z-arg is z² (Erf) or -z² (Erfi).
   */
  readonly zMatch?: (z: Value) => "yes" | "no" | "unknown";
}
```

Erf's rule sets `zMatch: zIsNonNegativeSquare`; Erfi's sets
`zMatch: zIsNegativeSquare`. Defaults preserve current behaviour
(additive change).

## Tests

```ts
test("Erf round-trip: headToMeijerG + meijerGToHead byte-identical", () => {
  for (const xs of ["1", "0.5", "2", "1.23"]) {
    const z = fromString(xs);
    const fwd = headToMeijerG("Erf", [z])!;
    const bwd = meijerGToHead(fwd.gForm)!;
    expect(bwd.head).toBe("Erf");
    expect(canonicalize(bwd.args[0])).toBe(canonicalize(z));
  }
});

test("Erfc round-trip", () => { /* analogous */ });
test("Erfi round-trip", () => { /* analogous */ });

test("Erf and Erfi disambiguated by z-arg sign", () => {
  const z = sym("z");
  const erfBridge = headToMeijerG("Erf", [z])!;
  const erfiBridge = headToMeijerG("Erfi", [z])!;
  // Both have identical (an, ap, bm, bq) but different z slots.
  expect(canonicalize(erfBridge.gForm.an[0])).toBe(canonicalize(erfiBridge.gForm.an[0]));
  expect(canonicalize(erfBridge.gForm.z)).not.toBe(canonicalize(erfiBridge.gForm.z));
});

test("InverseErf refuses both directions", () => {
  expect(headToMeijerG("InverseErf", [sym("y")])).toBeNull();
});

test("Existing dlmf-16-18-erf rule still fires after I6", () => {
  // Form B is the existing backward rule; I6 must not break it.
});

test("Numerical agreement: bigErf(z) ≡ wrap(meijerg(gForm)) at 50 dp", () => {
  // Once both bigErf (I3) and the per-head arbprec meijerg evaluator
  // (bead d6s) are ready, this test closes the loop.
  // Until then: skip-with-message.
});
```

## Mutation-proving

1. Swap `bm` ↔ `bq` in the Erf forward G-form; confirm round-trip
   fails.
2. Drop the `zMatch` predicate from the Erfi rule; confirm Erf inputs
   misroute to Erfi.
3. Replace the `zInverse` closure with `[mkPower(g.z, rat(1n, 2n))]`
   (i.e. naive √); confirm round-trip for `Erf(-1)` fails (multi-valued
   root surface bug).

## Acceptance

- [ ] `MeijerGForm` + `ForwardBridge` types in
  `bridges/types.ts`.
- [ ] `headToMeijerG` + `meijerGToHead` for `Erf`, `Erfc`, `Erfi`.
- [ ] `null` return for `InverseErf` / `InverseErfc` (honest refusal).
- [ ] `PatternSpec.zMatch?` extension landed without breaking any
  existing dispatch-rule test.
- [ ] Round-trip property byte-identical for Erf, Erfc, Erfi across a
  representative sample.
- [ ] Existing `dlmf-16-18-erf` rule still fires (regression check).
- [ ] `bun run check` green.

---

# Phase 2 — orchestration discipline (for me, the orchestrator)

## Dispatch order

Once Phase 1 GATE passes (after G2a Wolfram fix re-runs G8 with
findings < 50):

1. **Round 1 (parallel)**: dispatch I6a + I5 + I1 subagents.
2. **Round 2 (parallel)**: when Round 1 returns, dispatch I2 + I3 + I4.
3. **Round 3**: when Round 2 returns, dispatch I6.

Each subagent gets the bead ID, this plan's relevant section, the
ADR-0040 reference, the relevant R-research artefact paths, and the
golden corpus path. They write code; I monitor; I file follow-up
beads for surprises; I validate output and close beads.

## Per-bead orchestrator checklist

For each bead claimed:

1. Before dispatch: `bd update <id> --claim` + change status to
   `in_progress`.
2. Dispatch subagent with self-contained prompt.
3. On return: verify deliverables exist; run `bun run check:quick`
   (or per-package tests); confirm acceptance checklist.
4. If acceptance met: append summary notes to bead; `bd close <id>`.
5. If a finding surfaced (substrate gap, oracle bug, regime
   surprise): file a new bead with `--deps blocked-by:<id>` linking
   back to the source bead.
6. Commit with the bead ID in the commit message; push.

## Findings expected (per the orchestration-expansion discussion)

Reasonable estimates of new beads Phase 2 will file:

* **I1**: 1-3 new beads for substrate-extension surprises (e.g. a
  faster `exp(-z²)` primitive for x near x_c boundary).
* **I3**: 2-4 new beads (coefficient caching infrastructure;
  Stokes-line singularity handling fission).
* **I6**: 3-5 new beads (PatternSpec `zMatch?` extension might fission
  into dispatch-types refactor + Erf rule + Erfi rule + tests).
* **V1 (Phase 4)**: 1-3 new beads from mutation-proving surfacing new
  invariants.

Bead count projected: 33 (current) → ~45-50 by epic close.

## Phase 2 GATE

`bun run check` green + golden-master suite green against Phase 1
corpus + property tests + mutation-proving documented for each bead.
Then Phase 3 (tool integration) unlocks.
