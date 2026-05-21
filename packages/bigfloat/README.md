# @workbench/bigfloat

Arbitrary-precision binary floating-point substrate for the scientist-workbench.
Pure TypeScript on `BigInt` — no FFI, no subprocess, no platform-conditional
behaviour. The primary consumers are `tools/hypergeometric-pfq`,
`packages/meijer-core`, and `packages/quadrature`.

```ts
import {
  // types
  type BigFloat, type BigComplex,
  BigFloatInvariantError, decimalToBinaryPrecision,

  // construction / conversion
  fromInt, fromFloat64, fromString, toFloat64, toString,

  // comparison (exact — no prec argument)
  eq, lt, le, gt, ge, cmp, sgn, abs, neg, isZero,

  // core arithmetic (each takes explicit prec: number)
  add, sub, mul, div, sqrt, powInt,

  // transcendentals
  exp, expm1, log, log1p, pow,
  sin, cos, tan, asin, acos, atan, atan2,
  sinh, cosh, tanh, asinh, acosh, atanh,

  // constants (cached per precision)
  pi, e, ln2,

  // special functions (real)
  gamma, lgamma, digamma, trigamma, polygamma,
  bigErf,                              // real-axis error function (ADR-0040)
  bigIncompleteGammaUpper, bigIncompleteGammaLower,   // Gamma family (ADR-0042)
  bigGammaP, bigGammaQ, bigBeta, bigLogBeta,
  bigPochhammer, bigBarnesG,

  // BigComplex API
  cfromReal, cfromInts, cfromStrings, cre, cim, cconj, cisZero,
  cadd, csub, cmul, cdiv, cneg, cabs, carg, csqrt,
  cexp, clog, cpow, cgamma, clgamma, cdigamma,
  ctrigamma, cpolygamma,               // Gamma family complex (ADR-0042)
  cIncompleteGammaUpper, cIncompleteGammaLower, cBeta,

  // value-protocol encoding
  BIGFLOAT_TAG, BIGCOMPLEX_TAG,
  bigfloatToValue, valueToBigFloat,
  bigcomplexToValue, valueToBigComplex,
  bigfloatSchema, bigcomplexSchema,

  // internals (substrate-level consumers)
  bitLength, normalise, validate, bernoulliRational,
} from "@workbench/bigfloat";
```

## Determinism contract

`BigInt` arithmetic is bit-identical across every JavaScript runtime by
language specification. Because every mantissa in this package is a signed
`bigint`, every operation — including `div`, `sqrt`, `gamma`, `exp`, and
all complex analogs — produces **byte-identical output given fixed input
and fixed precision**, unconditionally on platform, OS, or runtime version.

This is the `arbprec: true` contract defined by ADR-0020. It is *stronger*
than the `numerical: true` (float64, platform-conditional) tier and parallel
to the symbolic majority. Any tool built exclusively on this package may
declare `arbprec: true` and inherit the unconditional bit-determinism
guarantee.

See: `docs/adr/0020-arbitrary-precision-tier.md`.

## Types

### `BigFloat`

```ts
interface BigFloat {
  readonly mantissa: bigint;   // signed; value = mantissa * 2^exponent
  readonly exponent: number;   // finite integer
  readonly precision: number;  // positive integer — bits in |mantissa|
}
```

The invariant is strict: for a non-zero `BigFloat`, `|mantissa|` has
*exactly* `precision` bits (high bit set). Zero is canonical
`{mantissa: 0n, exponent: 0, precision: <any>}`. NaN and ±∞ are not
representable; arithmetic at the boundary throws.

Per-value precision follows MPFR semantics — every operation takes an
explicit `prec: number` parameter (binary bits) and rounds the result
to that precision via round-half-to-even. Ambient precision (mpmath-style
`mp.prec`) was deliberately rejected; see ADR-0020 §"Why these choices".

The helper `decimalToBinaryPrecision(d)` converts a decimal-digit target
to binary bits via `ceil(d * log2(10)) + 30` (30-bit safety margin). The
user-facing dial on `arbprec: true` tools is decimal digits (`--precision=50`);
the substrate runs in bits.

### `BigComplex`

```ts
interface BigComplex {
  readonly re: BigFloat;
  readonly im: BigFloat;
}
```

Both components carry the same precision in practice — all complex operations
take a single `prec` argument and normalise both components to it. The complex
API mirrors the real API (`cadd / csub / cmul / cdiv / cneg / cabs / carg /
csqrt / cexp / clog / cpow`) plus special functions `cgamma / clgamma /
cdigamma`. These are the primary functions consumed by `packages/meijer-core`'s
contour driver and Slater residue sums.

## Operations

All precision-consuming operations take `(a, b?, prec: number)` and return
a value with `precision === prec`. Comparison and sign operations are exact
and take no precision argument.

```ts
// Example: Γ(1/2) = √π to 50 decimal digits
const p = decimalToBinaryPrecision(50);       // ≈ 196 bits
const x = fromString("0.5", p);
const r = gamma(x, p);
console.log(toString(r, 50));
// → "1.7724538509055160272981674833411451827975494561223873"
```

The `bernoulliRational(n)` export is an internal helper (exact Bernoulli
numbers as `{num, den}` BigInt pairs) used by the Stirling-series
implementations of `lgamma`, `digamma`, and `polygamma`; not part of the
primary tool-author surface but exported for substrate-level consumers.

## Value-protocol encoding

`BigFloat` and `BigComplex` are encoded as `tagged` values — not new
primitive protocol kinds (PRD §2.2 stays at ten). The encoding is:

```
tagged("bigfloat", record({
  mantissa: integer(<decimal>),
  exponent: integer(<decimal>),
  precision: integer(<decimal>),
}))

tagged("bigcomplex", record({
  re: <bigfloat>,
  im: <bigfloat>,
}))
```

Tools that operate on bigfloat declare input/output schemas using
`bigfloatSchema` / `bigcomplexSchema`; tools that don't, see a `tagged`
value and round-trip it per the foreign-pass-through invariant (PRD §2.3).
`bigfloatToValue` / `valueToBigFloat` and their complex analogs cross the
boundary without loss.

## Consumers

- `tools/hypergeometric-pfq` — first `arbprec: true` tool; evaluates
  generalised hypergeometric series $_pF_q$ at arbitrary precision.
- `packages/meijer-core` — Slater residue path and contour driver; uses
  `BigComplex` arithmetic throughout; `cgamma` and `cdigamma` are the
  hot functions.
- `packages/quadrature` — `gaussKronrodAdaptiveBF` (G7K15 rule) and
  `tanhSinhAdaptiveBF` (tanh-sinh); both run entirely in `BigFloat`
  arithmetic with integrands taking `(x: BigFloat, prec: number)`.

## `div` precision floor (worklog 084)

The original `div(a, b, prec)` computed working bits as `prec + 32`
unconditionally. When `bitLength(a.mantissa) < bitLength(b.mantissa)` —
for example `fromInt(1n)` (53-bit mantissa) divided by a 200-bit divisor —
the integer quotient came out short and `normalise` zero-padded trailing bits
silently. The result carried `precision: prec` with correct mantissa width
but dishonest low bits.

The fix (bead `djp`) compensates:

```ts
const lengthCompensation = denBits > numBits ? denBits - numBits : 0;
const workingBits = prec + 32 + lengthCompensation;
```

Call sites where `numBits ≥ denBits` are unaffected (compensation is zero;
byte-identical to the original). As a stylistic recommendation, construct
BigFloat constants inside integrands at the working precision
(`fromInt(1n, p)`, not bare `fromInt(1n)`) — the substrate fix makes this
non-load-bearing, but explicit precision documents intent.

Source: `packages/bigfloat/src/arithmetic.ts:81-155`.

## Near-pole reflection precision (bead `oj5j`)

`clgamma` / `cdigamma` route `Re(z) < ½` through the reflection formulae
`log Γ(z) = log π − log sin(π z) − log Γ(1 − z)` and
`ψ(z) = ψ(1 − z) − π cot(π z)`. The original reflection branches formed
`π·z` at a fixed `work = prec + 32` *before* the `sin` / `cos` argument
reduction. When `z = m + ζ` sits ε-close to a Γ / ψ pole (a non-positive
integer `m`), the `π·ζ` information lives `≈ −log₂|ζ|` bits *below* `π·m`
— so it was truncated away inside the branch, and `sin`'s own reduction
then re-did the same large subtraction. The net loss was
`≈ (−log₁₀|ζ| − 9)` digits of the *requested* precision, no matter how
much precision the input `z` carried.

The fix reduces `z → ζ = z − m` **before** multiplying by π, so the one
unavoidable cancellation is localised to that single subtraction, and
`π·ζ` is then formed from a quantity that already has the right
magnitude. The integer shift is handled by periodicity —
`sin(π z) = (−1)ᵐ sin(π ζ)`, `cot(π z) = cot(π ζ)` — and the working
precision is bumped by the measured cancellation depth:

```ts
const lossBits = Math.max(0, magBits(z) - magBits(zeta0));
const work = prec + 32 + lossBits;
```

For `m = 0` (the region `Re(z) ∈ (−½, ½)`) there is no integer to peel
off: `ζ = z`, `lossBits = 0`, and the computation is byte-identical to
the pre-`oj5j` code. Only `Re(z) ≤ −½` arguments — where the genuine
cancellation lives — see new behaviour.

Source: `packages/bigfloat/src/complex.ts` (`clgammaReflect`,
`cdigammaReflect`); regression tests in `test/complex.test.ts`
(`describe("clgamma / cdigamma — near-pole reflection precision")`).
The real-argument reflection paths (`lgammaRealAbs`, `digamma` in
`special.ts`) carry the same latent cancellation — tracked separately.

## Erf family substrate (ADR-0040)

ADR-0040 pins a per-head special-function substrate architecture; Erf is
the v0.1 reference implementation. The real-axis arb-prec evaluator
`bigErf(x: BigFloat, prec: number): BigFloat` is the entry point and
lives in `src/special-funcs/erf.ts` alongside three package-internal
substrate primitives:

- `bigErfSeries`             — DLMF 7.6.2 Borel form (all-positive terms).
  The textbook Maclaurin (DLMF 7.6.1) is *not* used: its alternating
  signs discard `x² · log₂ e` bits to cancellation when `|x|² > p`. The
  Borel form has zero alternation and the same convergence rate.
- `bigErfcAsymptotic`        — DLMF 7.12.1 Poincaré asymptotic with the
  optimal-truncation idiom (mirrors `lgammaStirling` in `special.ts`).
- `bigErfcContinuedFraction` — DLMF 7.9.1 Laplace CF via modified Lentz.

The dispatch in `bigErf` is precision-aware: `|x| ≤ x_c(prec) := √(prec ·
ln 2)` routes to the Borel series; `|x| > x_c` routes to
`1 − bigErfcAsymptotic(|x|)` (the subtraction is cancellation-free
because by construction `erfcAsymptotic` is below `2^-prec` past the
crossover). At prec = 200 bits (≈ 60 dps), `x_c ≈ 11.78`.

The two `bigErfc*` primitives are exported from `erf.ts` but **not**
re-exported from the package's public surface — they are substrate
intended for I2's `bigErfc` / `bigErfcx` implementation to hoist on top
of.

Source: `packages/bigfloat/src/special-funcs/erf.ts`. Tests:
`packages/bigfloat/test/erf.test.ts` (golden masters vs Wolfram + mpmath
at 50, 100, 200 dp on the full T1/T2 real-Erf corpus subset).

## Gamma family substrate (ADR-0042)

ADR-0042 instantiates the per-head substrate for the canonical Gamma
family — the third prototype after Erf and Bessel. The Gamma substrate
is *part audit-and-uplift, part new-heads*: `lgamma`, `gamma`,
`digamma`, `trigamma`, `polygamma` already shipped in `src/special.ts`
and are exempt from relocation (ADR-0042 §"Decision 12" — the 12
`cgamma` import sites in `meijer-core` make a move a zero-benefit
bandaid). The Gamma epic lifted the existing functions
(`digamma`/`trigamma` negative-argument reflection per DLMF §5.5.4;
`polygamma` for m ≥ 2 via the Hurwitz-zeta route
`ψ^(m)(z) = (-1)^(m+1)·m!·ζ(m+1, z)`, DLMF §5.15.2) and added five
new per-head modules under `src/special-funcs/`:

- `incomplete-gamma.ts` — `bigIncompleteGammaUpper` / `Lower` (4-regime
  dispatch: DLMF §8.7.3 series, Lentz CF, Temme-stub→CF fallback,
  Poincaré asymptotic; verbatim Cephes `igam.c` rescaling guards) plus
  `bigGammaP` / `bigGammaQ` (regularised, computed cancellation-free by
  evaluating the smaller of P/Q directly).
- `beta.ts` — `bigBeta` / `bigLogBeta` via lgamma sum/difference with
  algebraic sign tracking; `B(½,½) = π` is a golden.
- `pochhammer.ts` — `bigPochhammer`, three-way pole dispatch (direct
  product below n ≈ 20, lgamma-ratio above; integer-pole truncation;
  non-integer-negative cancellation absorption).
- `barnes-g.ts` — `bigBarnesG`, three-regime dispatch (integer fast
  path; asymptotic for large z per DLMF §5.17.5 with a cached
  Glaisher-Kinkelin constant; functional-equation back-shift for small
  z).

Complex extensions land in-place in `src/complex.ts` per ADR-0042
§"Decision 2": `ctrigamma`, `cpolygamma` (m ≥ 2 Hurwitz),
`cIncompleteGammaUpper` / `Lower`, and `cBeta`, mirroring the
real-axis dispatch on `BigComplex`.

Sources: `packages/bigfloat/src/special-funcs/{incomplete-gamma,beta,pochhammer,barnes-g}.ts`
and `src/complex.ts`. Tests: `test/special-funcs/{incomplete-gamma,beta,pochhammer,barnes-g}.test.ts`
and `test/complex-gamma-extensions.test.ts` (golden masters vs Wolfram /
mpmath / Arb at 50 dp). See `docs/worklog/175-gamma-epic-close.md`.

## See also

- `docs/adr/0020-arbitrary-precision-tier.md` — design rationale, the
  `arbprec: true` flag, value-protocol encoding, `--precision` standard flag.
- `docs/worklog/069-bigfloat-and-pfq-shipped.md` — initial substrate ship;
  229-test suite; cross-validation against Wolfram at 50 dps.
- `docs/worklog/071-bigfloat-exp-false-alarm-and-hardening.md` — the
  `exp()` false-alarm investigation and principled hardening applied.
- `docs/worklog/084-bigfloat-div-precision-floor-fix.md` — `div` precision
  floor: diagnosis, fix, and downgrade of the integrand-contract from
  load-bearing invariant to stylistic recommendation.
- `docs/worklog/117-cgamma-near-pole-reflection-fix.md` — `clgamma` /
  `cdigamma` near-pole reflection: catastrophic-cancellation diagnosis,
  the reduce-z-before-π reformulation, adaptive working precision.
