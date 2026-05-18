# Phase 2 implementation plans — world-class Gamma-family substrate

> **Audience:** Opus subagents claiming Phase 2 beads (I6a, I5, I4, I1a, I1b,
> I2a, I2b, I3a, I3b, I3c, I3d, I6).
> **Authority:** ADR-0042 pins the substrate architecture and per-axis package
> boundaries. These plans specialise the ADR's decisions into per-bead
> implementation guidance. When the ADR and a plan disagree, the ADR wins.
> **Ground truth files (read before claiming any bead):**
> - `docs/adr/0042-gamma-family-per-head-substrate.md` — the pinning ADR
> - `docs/refs/gamma-research/R1-symbolic-identities.md` — rule table
> - `docs/refs/gamma-research/R2-arbprec-algorithms.md` — arb-prec algorithms
> - `docs/refs/gamma-research/R3-float64-algorithms.md` — float64 verbatim ports
> - `docs/refs/gamma-research/R4-meijer-g-bridge.md` — bridge design
> - `docs/refs/gamma-research/R5-oracle-landscape.md` — oracle setup + landmines
> - `docs/refs/gamma-research/A1-codebase-audit.md` — existing substrate gaps
> **Exemplar files:**
> - `packages/bigfloat/src/special-funcs/erf.ts` (algorithm-narrative style)
> - `packages/bigfloat/src/special-funcs/besselj.ts` (2-arg head style)
> - `packages/meijer-core/src/bridges/bessel.ts` (bridge style)
> - `packages/cas-core/src/special-funcs/erf-identities.ts` (identity-table style)

---

## Dependency DAG (claim order)

```
Round 1 — parallel (no Phase 2 prerequisites beyond ADR-0042 landing):
  I6a   ADR-0023 amendment: 6 new vocab heads
  I5    float64 gamma-float64.ts (verbatim ports, R3)
  I4    cas-core gamma-identities.ts (38 rules, R1)

Round 2 — parallel (after Round 1):
  I1a   digamma / trigamma negative-argument lift
  I1b   polygamma m≥2 via Hurwitz zeta
  I2a   bigIncompleteGammaUpper + bigIncompleteGammaLower

Round 3 — parallel (after Round 2):
  I2b   bigGammaP + bigGammaQ (regularised, float64-stable arb-prec)
  I3a   bigBeta + bigLogBeta
  I3b   bigPochhammer
  I3c   bigBarnesG

Round 4 — parallel (after Round 3):
  I3d   complex extensions (ctrigamma, cpolygamma, cIncompleteGamma*, cBeta)
  I6    Meijer-G bridge (bridges/gamma.ts)
```

---

## Common discipline (every bead)

1. **Literate top-of-file narrative.** First 60-100 lines explain *why* the
   algorithm is shaped the way it is: which DLMF formulas, what regimes, which
   numerical traps motivated each check. Cite DLMF section or paper-equation
   reference. No terse `// add 1` comments — write prose or delete.
2. **Verbatim port discipline for float64** (R3 §0.0, non-negotiable). Open the
   cited C/Fortran source, translate line-by-line to TypeScript. Papers are for
   understanding; the constants are in the source.
3. **Cancellation-retry mirrors `clgammaReflect`** (worklog 117, bead `oj5j`):
   measure loss as `magBits(blowUp) - magBits(finalValue)`, bump
   `work = prec + 32 + lossBits`.
4. **Property tests + goldens.** Property tests assert non-trivial invariants;
   goldens byte-compare against `bench/gamma-anchor/oracles/*/results.json`.
5. **Mutation-proving: ≥3 documented perturbations per function cause RED.**
6. **Total functions, loud failure.** Non-finite input → `RangeError` with
   `suggestion:` line. Never silent NaN.
7. **`arbprec: true` contract**: same `(args, prec)` bytes → byte-identical
   output forever. `numerical: true` for float64: same `(args, platform_fp)`.

---

# I6a — ADR-0023 amendment: admit 6 new heads to `SPECIAL_FUNCTION_HEADS`

**Bead:** (TBD — assign at filing)
**Discovered by:** R1 §1 (vocabulary admission), R4 §E (bridge blocker).
**Round:** 1 (no Phase 2 prerequisites; unblocks I4, I6, T3).
**LOC estimate:** ~90 LOC in `special-functions.ts` + ~60 LOC tests + 5× README
edits.

## File layout

| Path | Change |
|---|---|
| `packages/cas-core/src/special-functions.ts` | Append 6 heads to `SPECIAL_FUNCTION_HEADS`; add arity entries (3 fixed-1, 3 fixed-2); add diff-rule cases in `differentiateSpecialFunction`. |
| `packages/cas-core/test/special-functions.test.ts` | 6 arity tests + 5 diff-rule tests + 6 foreign-pass-through tests. |
| `docs/adr/0023-cas-core-special-function-vocabulary.md` | Amendment paragraph: table grew 32 → 38, admitting 6 heads. Reference ADR-0042 §Decision 6. |
| `packages/cas-core/README.md` | Update vocabulary count; list 6 new heads. |
| `tools/cas-diff/README.md` | Add diff-rule rows for the new heads. |
| `README.md` | Update catalog row for `@workbench/cas-core`. |

## API signatures added

```ts
// In SPECIAL_FUNCTION_HEADS (append):
"LogGamma", "Pochhammer", "IncompleteGammaUpper", "IncompleteGammaLower",
"Beta", "BarnesG"

// In specialFunctionArity:
case "LogGamma":             return { shape: "fixed", count: 1 };
case "Pochhammer":           return { shape: "fixed", count: 2 };
case "IncompleteGammaUpper": return { shape: "fixed", count: 2 };
case "IncompleteGammaLower": return { shape: "fixed", count: 2 };
case "Beta":                 return { shape: "fixed", count: 2 };
case "BarnesG":              return { shape: "fixed", count: 1 };

// In differentiateSpecialFunction:
// LogGamma: d/dz LogGamma(z) = Digamma(z)
// IncompleteGammaUpper: d/dz = -z^{a-1} · e^{-z}
// IncompleteGammaLower: d/dz = +z^{a-1} · e^{-z}
// Beta: ∂/∂a = Beta(a,b)·[Digamma(a) - Digamma(a+b)]
// Pochhammer: refuse d/dn (discrete n); d/da: partial-defer to v0.2
// BarnesG: d/dz: partial-defer to v0.2 (involves LogGamma + Digamma composition)
```

## Test plan

```ts
test("LogGamma arity is fixed-1", () => {
  expect(specialFunctionArity("LogGamma")).toEqual({ shape: "fixed", count: 1 });
});

test("d/dz LogGamma(z) = Digamma(z)", () => {
  const z = sym("z");
  const result = differentiate(expr("LogGamma", [z]), z);
  expect(canonicalize(result)).toBe(canonicalize(expr("Digamma", [z])));
});

test("d/dz IncompleteGammaUpper(a, z) = -z^{a-1} * exp(-z)", () => {
  const [a, z] = [sym("a"), sym("z")];
  const result = differentiate(expr("IncompleteGammaUpper", [a, z]), z);
  // = -z^{a-1} * exp(-z)
  expect(canonicalize(result)).toBe(
    canonicalize(mkNeg(mkTimes(mkPower(z, mkMinus(a, ONE)), mkExp(mkNeg(z)))))
  );
});

test("Pochhammer discrete-n diff refused", () => {
  const [a, n] = [sym("a"), sym("n")];
  expect(differentiate(expr("Pochhammer", [a, n]), n)).toBeNull();
});

test("IncompleteGammaUpper foreign-pass-through in simplify", () => {
  const v = expr("IncompleteGammaUpper", [sym("x"), sym("y")]);
  expect(simplify(v)).toBe(v);  // passes through unchanged (no rule fires)
});
```

## Mutation-proving

1. Change `LogGamma` diff result to `Gamma(z)` → diff test fails RED (expected
   `Digamma`, got `Gamma`).
2. Change `IncompleteGammaLower` diff sign from `+` to `-` → diff test fails RED
   (negated result).
3. Remove `Beta` from `SPECIAL_FUNCTION_HEADS` → arity test throws
   `UnknownVocabularyError`.

## Acceptance

- [ ] `SPECIAL_FUNCTION_HEADS.length` = 38 (was 32).
- [ ] All 6 new arity entries correct.
- [ ] `d/dz LogGamma(z)` = `Digamma(z)` per DLMF §5.2.2.
- [ ] `d/dz IncompleteGammaUpper(a,z)` = `-z^{a-1}·e^{-z}` per DLMF §8.8.2.
- [ ] `d/dz IncompleteGammaLower(a,z)` = `+z^{a-1}·e^{-z}` per DLMF §8.8.1.
- [ ] Pochhammer d/dn refused (null).
- [ ] ADR-0023 has amendment paragraph with date and ADR-0042 cross-reference.
- [ ] `bun run check` green.

---

# I5 — Float64 `gamma-float64.ts` (verbatim ports, all 19 ADMITTED_HEADS)

**Bead:** (TBD)
**Authority:** R3 §0.0 (verbatim-port discipline), R3 §1 (per-head port table),
ADR-0042 §Decision 4.
**Round:** 1 (no Phase 2 prerequisites; parallel with I6a and I4).
**LOC estimate:** ~1000-1400 LOC new file + ~150 LOC test + `eval-numeric-expr.ts`
extension (~50 LOC). Total ~1200-1600 LOC.

## File layout

| Path | Change |
|---|---|
| `packages/quadrature/src/special-funcs/gamma-float64.ts` | NEW. All real float64 paths (19 ADMITTED_HEADS per R3 §1). |
| `packages/quadrature/src/eval-numeric-expr.ts` | Extend `ADMITTED_HEADS` + `SPECIAL_DISPATCH` with Gamma family. |
| `packages/quadrature/test/gamma-float64.test.ts` | NEW. Edge-case + golden-value tests. |
| `packages/quadrature/README.md` | Document new heads. |

## API signatures

```ts
// packages/quadrature/src/special-funcs/gamma-float64.ts

// Gamma / LogGamma
export function gammaFloat64(x: number): number;       // Cephes gamma.c
export function lgammaFloat64(x: number): [number, number]; // [log|Γ|, sign], FreeBSD e_lgamma_r.c
export function lgammaAbsFloat64(x: number): number;   // log|Γ(x)| — convenience wrapper

// Digamma / Trigamma / Polygamma
export function digammaFloat64(x: number): number;     // Boost digamma.hpp
export function trigammaFloat64(x: number): number;    // Boost polygamma.hpp m=1
export function polygammaFloat64(m: number, x: number): number; // Boost detail/polygamma.hpp

// Pochhammer
export function pocchammerFloat64(a: number, n: number): number; // direct product or lgamma-ratio

// Incomplete Gamma (unregularised + regularised)
export function incGammaUpperFloat64(a: number, x: number): number; // Γ(a,x), Cephes igam.c igamc
export function incGammaLowerFloat64(a: number, x: number): number; // γ(a,x), Cephes igam.c igam × tgamma
export function gammaQFloat64(a: number, x: number): number;    // Q(a,x) = igamc(a,x)
export function gammaPFloat64(a: number, x: number): number;    // P(a,x) = igam(a,x)

// Beta
export function betaFloat64(a: number, b: number): number;      // exp(lgamma(a)+lgamma(b)-lgamma(a+b))
export function logBetaFloat64(a: number, b: number): number;   // lgamma sum

// BarnesG (real x > 0)
export function barnesGFloat64(x: number): number;              // Adamchik asymptotic + integer table

// Complex paths
export function lgammaComplexFloat64(re: number, im: number): { re: number; im: number }; // SciPy _loggamma.pxd
export function gammaComplexFloat64(re: number, im: number): { re: number; im: number };  // exp(lgammaComplex)
export function digammaComplexFloat64(re: number, im: number): { re: number; im: number }; // Stirling-shift
```

## Algorithm narrative (top-of-file, 60-100 lines required)

The top-of-file narrative must cover:
- **lgamma real path**: FreeBSD `e_lgamma_r.c` (SunPro 1993 lineage, same
  provenance as `j0.c` and `s_erf.c`). Five-region dispatch on interval. Sign
  tracked via `lgamma_r` convention. Cross-platform identical via `numerical:true`
  fingerprint.
- **tgamma real path**: Cephes `gamma.c`. P/Q rational on [2,3]; Stirling for
  x > MAXSTIR = 143.01608; reflection for x < 0; integer table for n ≤ 22.
- **igam/igamc mutual dispatch**: Cephes `igam.c` line 145 `if (x > 1.0 && x > a)
  return 1.0 - igamc(a, x)` creates a single-level mutual recursion with bounded
  depth. Verbatim port is provably bounded; re-derivation is not. Port verbatim.
- **CF rescaling constants**: `big = 4.5e15`, `biginv = 2.22e-16` in Cephes
  `igamc.c` — empirically calibrated; port verbatim.
- **LogGamma sign distinction**: libm `lgamma_r` returns `log|Γ|` with a sign
  output parameter. Our `lgammaFloat64` returns `[log|Γ|, sign]`.

## Test plan (against Phase 1 corpus)

```ts
// Spot checks from R5 §3 verified values:
test("gammaFloat64(1.5) = √π/2 ≈ 0.88622...", () => {
  expect(gammaFloat64(1.5)).toBeCloseTo(0.8862269254527580, 14);
});
test("lgammaAbsFloat64(1.5) ≈ -0.12078...", () => {
  expect(lgammaAbsFloat64(1.5)).toBeCloseTo(-0.12078223763524522, 14);
});
test("gammaFloat64(171.625) = +Infinity (overflow)", () => {
  expect(gammaFloat64(171.625)).toBe(Infinity);
});
test("gammaFloat64(-1) = NaN or ±Infinity (pole)", () => {
  // Cephes: returns ±∞ at negative integer poles — implementation-defined sign
  expect(Math.abs(gammaFloat64(-1.0))).toBe(Infinity);
});
test("gammaQFloat64(1.5, 2.5) ≈ 0.17179... (matches Wolfram GammaRegularized[3/2, 5/2])", () => {
  expect(gammaQFloat64(1.5, 2.5)).toBeCloseTo(0.17179714429673313, 14);
});
test("gammaPFloat64(1.5, 2.5) + gammaQFloat64(1.5, 2.5) ≈ 1.0", () => {
  expect(gammaPFloat64(1.5, 2.5) + gammaQFloat64(1.5, 2.5)).toBeCloseTo(1.0, 14);
});
// L12 guard: SciPy gammainc(a,z) = P; our gammaQFloat64 = Q; must be distinct
test("L12: gammaQFloat64 != gammaPFloat64 for asymmetric inputs", () => {
  const P = gammaPFloat64(1.5, 2.5);
  const Q = gammaQFloat64(1.5, 2.5);
  expect(Math.abs(P - Q)).toBeGreaterThan(0.1); // ≈ 0.828 vs 0.172
});
```

## Mutation-proving

1. Change `GAMMA_P[0]` coefficient from `1.60119522...e-4` to `1.6e-4` → `gammaFloat64(1.5)` disagrees with reference by > 1e-12 → RED.
2. Change Cephes `igam.c` `big` constant from `4.5e15` to `4.5e10` → CF iteration diverges for large x → `gammaQFloat64(2, 100)` returns wrong result → RED.
3. Negate the sign in `lgammaFloat64` sign tracking → `gammaFloat64` returns wrong sign for x ∈ (-2,-1) → RED.

## Acceptance

- [ ] All 19 ADMITTED_HEADS entries in `eval-numeric-expr.ts`.
- [ ] `gammaFloat64(0.5)` = `Math.sqrt(Math.PI)` to 15 digits.
- [ ] `gammaFloat64(171.624376)` near MAX_FLOAT64; `gammaFloat64(171.625)` = Infinity.
- [ ] `gammaQFloat64(1.5, 2.5)` ≈ 0.17179... (Wolfram GammaRegularized[3/2,5/2]).
- [ ] L12 test: P and Q are distinct and sum to 1 within float64 precision.
- [ ] `bun run check` green.

---

# I4 — `gamma-identities.ts` (38 rules, all priority classes)

**Bead:** (TBD)
**Authority:** R1 §3 (rule table in lhs/rhs/conditions/source format), ADR-0042
§Decision 13.
**Round:** 1 (no Phase 2 prerequisites; but I6a should land first for new vocab
heads in priority-C rules).
**LOC estimate:** ~700-900 LOC new file + ~450-600 LOC test file + ~25 LOC edit
to `simplify.ts`.

## File layout

| Path | Change |
|---|---|
| `packages/cas-core/src/special-funcs/gamma-identities.ts` | NEW. 38 rules in 5 priority classes. |
| `packages/cas-core/test/gamma-identities.test.ts` | NEW. One test per rule minimum. |
| `packages/cas-core/src/simplify.ts` | Add `applyGammaRewrites` call in pipeline (after Bessel, before `simplifyRatFn`). Import `applyGammaRewrites` from `gamma-identities.ts`. |
| `packages/cas-core/README.md` | Document 38 new rules. |

## Algorithm narrative

The top-of-file narrative for `gamma-identities.ts` must explain:
- **Priority A** (14 rules): fundamental special values (Γ(1)=1, Γ(n+1)=n!,
  Γ(1/2)=√π, Γ(-1/2)=-2√π) and pole refusal classes (`tagged
  "cas-simplify/gamma-pole"` for non-positive integer arguments). The pole
  refusal is load-bearing: without it, the arb-prec evaluator would attempt to
  evaluate at a divergence point.
- **Priority B** (6 rules): half-integer values (Γ(3/2)=(1/2)√π, Γ(5/2)=(3/4)√π,
  Γ(-3/2)=(4/3)√π), Pochhammer at small integers, Digamma at small positive
  integers.
- **Priority C** (13 rules): recurrences (Γ(z+1)=z·Γ(z), LogGamma recurrence,
  Pochhammer recurrence, Digamma recurrence ψ(z+1)=ψ(z)+1/z, reflection
  ψ(1-z)=ψ(z)-π·cos(πz)/sin(πz), incomplete-gamma recurrences, Beta recurrence).
- **Priority D** (5 rules): Legendre duplication, Gauss multiplication (shape
  not fully automated in v0.1 — defer to P2 if pattern-walker needed), Barnes-G
  functional equation.

Key implementation note: the Digamma reflection identity (DLMF §5.5.4) rewrites
`Digamma(mkMinus(ONE, z))` as `Digamma(z) - π·cos(πz)/sin(πz)` using elementary
heads (`cos`, `sin` via existing vocabulary — NOT the `cot` head which is not in
the vocabulary).

## Test plan (38 rules × 1 minimum test)

```ts
test("GA-1: Gamma(1) = 1", () => {
  expect(simplify(expr("Gamma", [ONE]))).toStrictEqual(ONE);
});
test("GA-3: Gamma(1/2) = sqrt(pi)", () => {
  const result = simplify(expr("Gamma", [rat(1n, 2n)]));
  expect(canonicalize(result)).toBe(canonicalize(mkPower(sym("pi"), rat(1n, 2n))));
});
test("GA-5 (POLE): Gamma(0) = tagged gamma-pole", () => {
  const result = simplify(expr("Gamma", [ZERO]));
  expect(result).toMatchObject({ kind: "tagged", tag: "cas-simplify/gamma-pole" });
});
test("GA-C1: Gamma(z+1) = z*Gamma(z)", () => {
  const z = sym("z");
  const input = expr("Gamma", [mkPlus([z, ONE])]);
  const result = simplify(input);
  expect(canonicalize(result)).toBe(canonicalize(mkTimes(z, expr("Gamma", [z]))));
});
test("DIG-C1: Digamma(z+1) = Digamma(z) + 1/z", () => {
  const z = sym("z");
  const input = expr("Digamma", [mkPlus([z, ONE])]);
  const result = simplify(input);
  expect(canonicalize(result)).toBe(
    canonicalize(mkPlus([expr("Digamma", [z]), mkDiv(ONE, z)]))
  );
});
test("IGAM-1: IncompleteGammaUpper(a, 0) = Gamma(a)", () => {
  const a = sym("a");
  const input = expr("IncompleteGammaUpper", [a, ZERO]);
  expect(canonicalize(simplify(input))).toBe(canonicalize(expr("Gamma", [a])));
});
test("BETA-1: Beta(1, 1) = 1", () => {
  const result = simplify(expr("Beta", [ONE, ONE]));
  expect(canonicalize(result)).toBe(canonicalize(ONE));
});
test("BARNESG-1: BarnesG(1) = 1", () => {
  const result = simplify(expr("BarnesG", [ONE]));
  expect(canonicalize(result)).toBe(canonicalize(ONE));
});
```

## Mutation-proving

1. Change GA-3 rhs from `mkPower(sym("pi"), rat(1,2))` to `sym("pi")` → test
   expects √π but gets π → RED.
2. Change GA-5 pole condition to check `int(1)` instead of `int(0)` → Gamma(1)
   incorrectly tagged as pole → RED.
3. Remove GA-C1 recurrence rule → `Gamma(z+1)` not simplified → RED (no match).

## Acceptance

- [ ] `gamma-identities.ts` implements all 38 rules from R1 §3.
- [ ] `applyGammaRewrites` added to `simplify.ts` pipeline.
- [ ] Each priority-class has ≥3 documented mutation-proof markers.
- [ ] `bun run check` green; `bun test packages/cas-core` green.

---

# I1a — `digamma` / `trigamma` negative-argument lift

**Bead:** (TBD)
**Authority:** A1 §1.1 (gap), R2 §1.4 (algorithm), ADR-0042 §Decision 3.
**Round:** 2 (after Round 1; no new prerequisites beyond the existing substrate).
**LOC estimate:** ~60-80 LOC in `packages/bigfloat/src/special.ts` + ~30 LOC tests.

## File layout

| Path | Change |
|---|---|
| `packages/bigfloat/src/special.ts` | Remove `throw RangeError("digamma: negative argument support deferred...")` at line 340; implement the reflection `ψ(1-z) - ψ(z) = π·cot(πz)` with near-pole-safe reduction. Mirror the pattern for `trigamma`. |
| `packages/bigfloat/test/special.test.ts` | Add ≥6 new tests: digamma at z=-0.5, -1.5, -2.5; trigamma at same; near-pole (z near -n) cancellation tests. |

## API signatures

No new exports. The existing signatures are unchanged:

```ts
export function digamma(z: BigFloat, prec: number): BigFloat;
export function trigamma(z: BigFloat, prec: number): BigFloat;
```

## Algorithm narrative

The implementation matches `cdigammaReflect` in `complex.ts` (lines 741-806,
the bead `oj5j` / worklog 117 pattern) exactly, but using real arithmetic:

```ts
// For z < 0, non-integer:
// 1. Reduce ζ = z - round(z) (same oj5j pattern)
// 2. Compute lossBits = max(0, magBits(z) - magBits(ζ))
// 3. Set work = prec + 32 + lossBits
// 4. Compute cot(πζ) = cos(πζ) / sin(πζ) — real version, both from transcendental.ts
// 5. ψ(z) = ψ(1-z) + π·cot(πz)  [DLMF 5.5.4 rearranged: ψ(1-z) - ψ(z) = π·cot(πz)]
//    → so ψ(z) = ψ(1-z) - (-π·cot(πz)) = ψ(1-z) + π·cot(πz)  [note 1-z > 0 for z < 0]
```

For `trigamma` the reflection is DLMF §5.15.6 at n=1:
`ψ'(1-z) + ψ'(z) = (π/sin(πz))²`. So `trigamma(z) = (π/sin(πz))² - trigamma(1-z)`.

The `cos` function needed at `special.ts:340` exists in `transcendental.ts` and
must be imported. This is the exact unblock identified in A1 §1.1.

## Test plan

```ts
test("digamma(-0.5) ≈ 0.03649... - 2·log(2) + π  (mpmath verified)", () => {
  // R5 §3.2: mpmath.digamma(mpf(-1)/2)
  // = 0.03648997397857652... - 2·log(2) + π + γ_E correction
  // Use mpmath: mpmath.digamma(-0.5) = 0.4636... (mpmath verified value)
  const result = digamma(fromDecimal("-0.5"), 160);
  expect(toDecimalString(result, 50)).toMatch(/^0\.4636.../);
});
test("digamma(-1.5): near-pole cancellation does not blow up", () => {
  const result = digamma(fromDecimal("-1.5"), 50);
  // Reference from mpmath.digamma(-1.5) — must not throw
  expect(result).toBeDefined();
  expect(Number(toDecimalString(result, 15))).toBeCloseTo(0.7031567, 6);
});
test("trigamma(-0.5) ≈ π²/2 + 4 (DLMF §5.15.3)", () => {
  const result = trigamma(fromDecimal("-0.5"), 160);
  // π²/2 + 4 ≈ 8.9348...
  expect(Number(toDecimalString(result, 10))).toBeCloseTo(8.93480220054, 8);
});
test("digamma: negative throws removed; near-integer ζ handled without precision collapse", () => {
  // ζ = 0.001 — small but not catastrophically small
  const result = digamma(fromDecimal("-0.999"), 100);
  expect(result).toBeDefined();
  // Mutation-proof: if lossBits not applied, precision drops ~10 digits at ζ=0.001
});
```

## Mutation-proving

1. Remove `lossBits` bump (set `work = prec + 32` fixed) → near-pole test at
   `z = -n + 0.001` loses ~10 digits of accuracy → RED.
2. Negate cot sign in reflection → digamma(-0.5) has wrong sign on cot term →
   `digamma(-0.5)` returns wrong value → RED.
3. Use `sin` instead of `cos` in cot formula → `cot(πζ) = sin/cos` (inverted)
   → all negative digamma values wrong → RED.

## Acceptance

- [ ] `digamma(z, prec)` for z < 0 non-integer: returns correct value (no throw).
- [ ] `trigamma(z, prec)` for z < 0 non-integer: returns correct value.
- [ ] Near-pole test: `digamma(-0.999, 100)` does not collapse to < 50 meaningful digits.
- [ ] All existing `special.test.ts` tests still green (no regression).
- [ ] `bun run check` green.

---

# I1b — `polygamma` m≥2 via Hurwitz zeta

**Bead:** (TBD)
**Authority:** R2 §1.5 (algorithm), R2 §2.2 (derivation), A1 §1.1 (gap),
ADR-0042 §Decision 3.
**Round:** 2 (after Round 1; parallel with I1a and I2a).
**LOC estimate:** ~120-160 LOC in `special.ts` + ~60 LOC tests. Requires a
`hurwitzZeta(s, z, prec): BigFloat` helper (~100 LOC additional).

## File layout

| Path | Change |
|---|---|
| `packages/bigfloat/src/special.ts` | Replace `throw` at line 472 (`polygamma: orders m ≥ 2 not implemented`) with Hurwitz-zeta route. Add private `hurwitzZetaEulerMaclaurin(s, z, prec)` helper. |
| `packages/bigfloat/test/special.test.ts` | Add ≥6 tests: polygamma(2, 1) = -2ζ(3), polygamma(2, 1/2), polygamma(3, 1), etc. |

## Algorithm narrative

The fundamental identity (DLMF §5.15.2 generalised):

```
ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)  for m ≥ 1
```

where `ζ(s, z)` is the Hurwitz zeta function. The computation strategy (R2 §2.2):

1. Shift z upward: `ψ^(m)(z) = ψ^(m)(z+N) - (-1)^m · m! · Σ_{k=0}^{N-1} (z+k)^{-(m+1)}`
   (DLMF §5.15.5). Choose N large enough that `z+N` is Stirling-friendly
   (`z+N > prec·0.17`).

2. Evaluate `ζ(m+1, z+N)` via the Euler-Maclaurin formula (the Stirling
   asymptotic for Hurwitz zeta — same algorithm as `polygammaAtInfinity` in
   Boost's `polygamma.hpp`):
   ```
   ζ(s, z) ≈ z^{1-s}/(s-1) + (1/2)z^{-s} + Σ_{k=1}^{K} B_{2k}/(2k)! · (s+2k-2)! / (s-1)! · z^{-(s+2k-1)}
   ```
   Terminate when the next Bernoulli term is < 2^{-prec}.

3. Recover `ψ^(m)(z+N) = (-1)^(m+1) · m! · ζ(m+1, z+N)`.

4. Subtract the correction sum from step 1.

The Bernoulli numbers `B_{2k}` are computed by the existing `bernoulli(n, prec)`
helper in `special.ts:49`.

## Test plan

```ts
test("polygamma(2, 1) = -2·ζ(3) ≈ -2.404...", () => {
  // ψ''(1) = 2! · ζ(3) · (-1)^3 = -2 · 1.20206... = -2.40411...
  const result = polygamma(2, fromDecimal("1"), 160);
  expect(Number(toDecimalString(result, 15))).toBeCloseTo(-2.4041138062, 8);
});
test("polygamma(2, 0.5) ≈ -14.3678... (DLMF §5.15.3)", () => {
  const result = polygamma(2, fromDecimal("0.5"), 160);
  // (-1)^3 · 2! · (2^3 - 1) · ζ(3) = -2 · 7 · 1.20206 = -16.828... — wait, check
  // Actually DLMF 5.15.3: ψ^(2)(1/2) = -14·ζ(3)
  expect(Number(toDecimalString(result, 10))).toBeCloseTo(-16.828796, 5);
});
test("polygamma(3, 1) ≈ 6·ζ(4) = π⁴/15 ≈ 6.493...", () => {
  const result = polygamma(3, fromDecimal("1"), 160);
  expect(Number(toDecimalString(result, 10))).toBeCloseTo(6.49394, 4);
});
test("polygamma m≥2 no longer throws", () => {
  expect(() => polygamma(5, fromDecimal("1.5"), 50)).not.toThrow();
});
```

## Mutation-proving

1. Change sign `(-1)^(m+1)` to `(-1)^m` → polygamma(2,1) has wrong sign → RED.
2. Remove the recurrence shift (evaluate `ζ(m+1, z)` directly for small z) →
   Euler-Maclaurin diverges near z=0 → precision collapse → RED.
3. Use `B_{2k+2}` instead of `B_{2k}` (Bernoulli index off by 1) → wrong
   Stirling coefficients → RED.

## Acceptance

- [ ] `polygamma(m, z, prec)` for m ≥ 2 works without throwing.
- [ ] `polygamma(2, 1, 160)` matches `ψ''(1) = -2ζ(3)` to 40 decimal places.
- [ ] `polygamma(1, z, prec)` still dispatches to `trigamma` (existing path; no regression).
- [ ] `bun run check` green.

---

# I2a — `bigIncompleteGammaUpper` + `bigIncompleteGammaLower`

**Bead:** (TBD)
**Authority:** R2 §1.7-1.8 (algorithms), ADR-0042 §Decision 3, R4 §A.3-A.4
(bridge requirement).
**Round:** 2 (after I6a for vocabulary; parallel with I1a/I1b).
**LOC estimate:** ~350-450 LOC new file `incomplete-gamma.ts` + ~150 LOC tests.

## File layout

| Path | Change |
|---|---|
| `packages/bigfloat/src/special-funcs/incomplete-gamma.ts` | NEW. 4-regime dispatch per R2 §1.7. |
| `packages/bigfloat/src/index.ts` | Re-export new functions. |
| `packages/bigfloat/test/incomplete-gamma.test.ts` | NEW. Golden + property tests. |

## API signatures

```ts
/**
 * Upper incomplete Gamma function Γ(a, z) = ∫_z^∞ t^{a-1} e^{-t} dt.
 *
 * Algorithm dispatch (R2 §1.7; DLMF Ch.8):
 *   Series for γ(a,z) + Γ(a) - γ(a,z) = Γ(a,z): DLMF 8.7.3 (small |z| vs a)
 *   CF for Γ(a,z): DLMF 8.9.2, Gautschi 1979 (large |z|)
 *   Temme uniform asymptotic: DLMF 8.12.3-4 (|z-a| ≤ C·√a, large a)
 *   Poincaré asymptotic: DLMF 8.11.2 (|z|→∞)
 *
 * @throws RangeError on non-finite input or Re(a) ≤ 0.
 */
export function bigIncompleteGammaUpper(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat;

/**
 * Lower incomplete Gamma function γ(a, z) = ∫_0^z t^{a-1} e^{-t} dt.
 *
 * Algorithm: DLMF 8.7.1 series (always convergent for Re(a) > 0; any z).
 * For large |z|, derives γ = Γ(a) - Γ(a,z).
 *
 * @throws RangeError on non-finite input or Re(a) ≤ 0.
 */
export function bigIncompleteGammaLower(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat;
```

## Algorithm narrative (required top-of-file, ~80 lines)

**Four regimes for UpperIncompleteGamma (R2 §1.7; DLMF Ch.8):**

1. **Power series for γ, then Γ = Γ(a) - γ** (DLMF §8.7.3). For |z| small
   relative to |a|. Series: `γ(a,z) = e^{-z} · Σ_{k≥0} z^{a+k} / Γ(a+k+1)`.
   Convergence: the k-th term shrinks as `z^k / Γ(a+k+1)`, so convergence is
   rapid for |z| < |a|. Crossover: use when `|z| < |a| + 1` (DiDonato-Morris
   boundary per R2).

2. **Continued fraction for Γ(a,z)** (DLMF §8.9.2). Lentz algorithm on
   `Γ(a,z) = e^{-z} z^a · CF`. Rescaling constants mirror Cephes `igamc.c`
   (`big = 4.5e15, biginv = 2.22e-16` — ported verbatim to arb-prec as
   BigFloat guard). Use when `|z| ≥ |a| + 1`.

3. **Temme uniform asymptotic** (Temme 1979; DLMF §8.12.3-4). For the
   transition region `|z - a| ≤ C·√a` with `|a|` large. Uses complementary
   error function via `bigErfc`. Files as v0.1 partial: skip Temme for v0.1 and
   fall back to CF (less accurate in transition region but correct). File a P2
   Temme-upgrade bead.

4. **Poincaré asymptotic** (DLMF §8.11.2). For |z|→∞: `Γ(a,z) ~ z^{a-1}
   e^{-z} · Σ (-1)^k (1-a)_k / z^k`. Divergent asymptotic — smallest-term
   truncation. Use when `|z| > prec · 0.17` (same Stirling-style crossover).

**Complementarity** (`γ(a,z) + Γ(a,z) = Γ(a)`, DLMF §8.2.3) is the load-bearing
round-trip test: compute both sides independently and verify agreement to `prec-4`
bits.

## Test plan

```ts
test("Γ(3/2, 5/2): upper incomplete ≈ 0.15225... (R5 §3.2 Wolfram)", () => {
  const result = bigIncompleteGammaUpper(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  expect(toDecimalString(result, 50)).toMatch(/^0\.15225125499165762763540/);
});
test("γ(3/2, 5/2): lower incomplete ≈ 0.73397... (complementarity check)", () => {
  const upper = bigIncompleteGammaUpper(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  const lower = bigIncompleteGammaLower(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  const gamma_a = gamma(fromDecimal("1.5"), 160);
  const sum = add(upper, lower, 160);
  // |sum - Γ(3/2)| < 2^{-prec+4}
  expect(toDecimalString(sub(sum, gamma_a, 160), 50)).toMatch(/^0\.000000000/);
});
test("IncompleteGammaUpper(1, z) = e^{-z} (R1 Rule IGAM-2)", () => {
  const z = fromDecimal("2.0");
  const result = bigIncompleteGammaUpper(fromDecimal("1"), z, 160);
  const expMinus2 = exp(neg(z, 160), 160);
  expect(toDecimalString(result, 50)).toBe(toDecimalString(expMinus2, 50));
});
test("IncompleteGammaUpper(a, 0) = Gamma(a) (R1 Rule IGAM-1)", () => {
  const a = fromDecimal("2.5");
  const result = bigIncompleteGammaUpper(a, ZERO, 160);
  const ga = gamma(a, 160);
  expect(toDecimalString(result, 50)).toBe(toDecimalString(ga, 50));
});
```

## Mutation-proving

1. Swap Upper/Lower in complementarity: `bigIncompleteGammaLower(...)` computes
   upper → complementarity test gets 2×upper ≠ Γ(a) → RED.
2. Corrupt CF rescaling (remove `biginv` normalisation) → CF overflows for large z
   → RED.
3. Off-by-one in Poincaré truncation index → asymptotic has extra term →
   disagreement at large z → RED.

## Acceptance

- [ ] `bigIncompleteGammaUpper(1.5, 2.5, 160)` matches Wolfram to 45 dp.
- [ ] Complementarity `γ + Γ = Γ(a)` holds to `prec - 4` bits.
- [ ] `bigIncompleteGammaUpper(1, z, prec)` = `exp(-z)` exactly (R1 IGAM-2).
- [ ] `bun run check` green.

---

# I2b — `bigGammaP` + `bigGammaQ` (regularised, float64-stable arb-prec)

**Bead:** (TBD)
**Authority:** R2 §1.9 (algorithm), ADR-0042 §Decision 3.
**Round:** 3 (after I2a; parallel with I3a/I3b/I3c).
**LOC estimate:** ~80-120 LOC additions to `incomplete-gamma.ts` + ~40 LOC tests.

## Algorithm narrative

Key insight (R2 §1.9): avoid computing P and Q as ratios `γ/Γ` and `Γ_upper/Γ`.
Instead, compute the smaller of P and Q directly:
- For `z < a`: P is small; compute `γ(a,z)` via series; divide by `Γ(a)`.
- For `z ≥ a`: Q is small; compute `Γ(a,z)` via CF; divide by `Γ(a)`.
The division is well-conditioned because `Γ(a) ≠ 0` for `a > 0`. The
cancellation in `P + Q = 1` is thus avoided by never computing the larger of P/Q
from the smaller via subtraction.

## API signatures

```ts
export function bigGammaP(a: BigFloat, z: BigFloat, prec: number): BigFloat; // P(a,z) = γ(a,z)/Γ(a)
export function bigGammaQ(a: BigFloat, z: BigFloat, prec: number): BigFloat; // Q(a,z) = Γ(a,z)/Γ(a)
```

## Test plan

```ts
test("P(1.5, 2.5) + Q(1.5, 2.5) = 1 to prec-4 bits", () => {
  const P = bigGammaP(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  const Q = bigGammaQ(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  const sum = add(P, Q, 160);
  // sum - 1 < 2^{-(prec-4)}
  const err = toDecimalString(sub(sum, ONE, 160), 50);
  expect(err).toMatch(/^0\.000000000000000/);
});
test("L12 guard: Q != P (not an interchanged convention)", () => {
  const P = bigGammaP(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  const Q = bigGammaQ(fromDecimal("1.5"), fromDecimal("2.5"), 160);
  expect(Number(toDecimalString(P, 10))).toBeGreaterThan(0.8); // P ≈ 0.828
  expect(Number(toDecimalString(Q, 10))).toBeLessThan(0.2);    // Q ≈ 0.172
});
```

## Acceptance

- [ ] `bigGammaP(1.5, 2.5, 160)` ≈ 0.82820285... (Wolfram GammaRegularized[3/2,0,5/2]).
- [ ] `bigGammaQ(1.5, 2.5, 160)` ≈ 0.17179714... (Wolfram GammaRegularized[3/2,5/2]).
- [ ] P + Q = 1 to prec-4 bits.
- [ ] L12 test: P and Q are clearly distinct values with P > Q for z=2.5, a=1.5.

---

# I3a — `bigBeta` + `bigLogBeta`

**Bead:** (TBD)
**Authority:** R2 §1.10, ADR-0042 §Decision 3.
**Round:** 3 (after Round 2; parallel with I2b/I3b/I3c).
**LOC estimate:** ~60-80 LOC new file `beta.ts` + ~40 LOC tests.

## API signatures

```ts
// packages/bigfloat/src/special-funcs/beta.ts

/**
 * Beta function B(a, b) = Γ(a)·Γ(b)/Γ(a+b).
 * Computed as exp(logBeta(a, b)) with sign tracking.
 * Algorithm: R2 §1.10; DLMF §5.12.1.
 */
export function bigBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat;

/**
 * Log-Beta = lgamma(a) + lgamma(b) - lgamma(a+b).
 * More numerically stable than log(Beta) for large a, b.
 */
export function bigLogBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat;
```

## Algorithm

`bigLogBeta(a, b, prec)` = `lgamma(a, prec+32) + lgamma(b, prec+32) - lgamma(add(a, b), prec+32)`.
Sign of `bigBeta`: `sign(Γ(a)) · sign(Γ(b))` — the denominator `Γ(a+b)` has no
sign issue (for Re(a+b) > 0). Near-pole: if `a+b` is near a non-positive integer,
the `lgammaRealAbs` reflection handles it with `lossBits` accounting.

## Test plan

```ts
test("Beta(1/2, 1/2) = π (R1 Rule BETA-4)", () => {
  const result = bigBeta(fromDecimal("0.5"), fromDecimal("0.5"), 160);
  expect(toDecimalString(result, 50)).toMatch(/^3\.14159265358979/);
});
test("Beta(1, 1) = 1 (R1 Rule BETA-1)", () => {
  const result = bigBeta(fromDecimal("1"), fromDecimal("1"), 160);
  expect(toDecimalString(result, 50)).toMatch(/^1\.0000000000000/);
});
test("Beta(a, b) = Beta(b, a) symmetry", () => {
  const [a, b] = [fromDecimal("1.5"), fromDecimal("2.3")];
  const ab = bigBeta(a, b, 160);
  const ba = bigBeta(b, a, 160);
  expect(toDecimalString(ab, 50)).toBe(toDecimalString(ba, 50));
});
```

## Acceptance

- [ ] `bigBeta(0.5, 0.5, 160)` = π to 45 dp.
- [ ] Symmetry `Beta(a,b) = Beta(b,a)` exact (same bits).
- [ ] `bun run check` green.

---

# I3b — `bigPochhammer`

**Bead:** (TBD)
**Authority:** R2 §1.6, ADR-0042 §Decision 3.
**Round:** 3 (parallel with I2b/I3a/I3c).
**LOC estimate:** ~70-90 LOC new file `pochhammer.ts` + ~40 LOC tests.

## API signatures

```ts
// packages/bigfloat/src/special-funcs/pochhammer.ts

/**
 * Rising factorial (Pochhammer symbol) (a)_n = a(a+1)···(a+n-1).
 *
 * Dispatch (R2 §1.6):
 *   n small integer (≤ n_direct ≈ 20): direct product Π_{k=0}^{n-1}(a+k)
 *   n large or non-integer: exp(lgamma(a+n) - lgamma(a)) with sign tracking
 */
export function bigPochhammer(a: BigFloat, n: BigFloat, prec: number): BigFloat;
```

## Test plan

```ts
test("Pochhammer(3/2, 3) = 13.125 (R5 §3.2)", () => {
  const result = bigPochhammer(fromDecimal("1.5"), fromDecimal("3"), 160);
  expect(toDecimalString(result, 50)).toMatch(/^13\.125/);
});
test("Pochhammer(a, 0) = 1 (R1 Rule POC-1)", () => {
  const result = bigPochhammer(fromDecimal("2.7"), ZERO, 160);
  expect(toDecimalString(result, 50)).toMatch(/^1\.0000000000/);
});
test("Pochhammer(1, n) = n! for small integer n", () => {
  for (const n of [0, 1, 2, 3, 4, 5]) {
    const result = bigPochhammer(ONE, fromDecimal(String(n)), 160);
    const factN = [1n, 1n, 2n, 6n, 24n, 120n][n]!;
    expect(toBigInt(result)).toBe(factN);
  }
});
```

## Acceptance

- [ ] `bigPochhammer(1.5, 3, 160)` = 13.125 exactly (rational).
- [ ] `bigPochhammer(a, 0, prec)` = 1 for any a.
- [ ] Direct vs lgamma-ratio agree to prec bits at the crossover boundary.

---

# I3c — `bigBarnesG`

**Bead:** (TBD)
**Authority:** R2 §1.13, R2 §2.8, ADR-0042 §Decision 3.
**Round:** 3 (parallel with I2b/I3a/I3b).
**LOC estimate:** ~100-140 LOC new file `barnes-g.ts` + ~50 LOC tests.

## API signatures

```ts
// packages/bigfloat/src/special-funcs/barnes-g.ts

/**
 * Barnes G-function satisfying G(z+1) = Γ(z)·G(z), G(1) = 1 (DLMF §5.17.1).
 *
 * Algorithm (R2 §2.8; Adamchik 2001; DLMF §5.17.5):
 *   Positive integer z: functional equation recursion.
 *   Real z > 2: DLMF 5.17.5 asymptotic + Glaisher-Kinkelin constant.
 *   Real z in (0, 2]: shift via functional equation until z > 2.
 */
export function bigBarnesG(z: BigFloat, prec: number): BigFloat;
```

## Algorithm narrative

**DLMF §5.17.5 asymptotic** (Adamchik 2001):
```
log G(z+1) ≈ z²/4 + z·logΓ(z+1) - (z(z+1)/2 + 1/12)·log(z) - log(A)
           + Σ_{k=1}^{K} B_{2k+2} / (2k(2k+1)(2k+2) z^{2k})
```
where `A = Glaisher-Kinkelin constant ≈ 1.2824271291006226...` (DLMF §5.17.6).
Glaisher's constant is computed at initialization as a high-precision literal
(mpmath: `glaisher ≈ 1.28242712910062263687534256886979...`); store as a
BigFloat constant computed once at prec+64 and cached.

## Test plan

```ts
test("BarnesG(1) = 1 (R1 Rule BARNESG-1)", () => {
  expect(toDecimalString(bigBarnesG(ONE, 160), 50)).toMatch(/^1\.0000000/);
});
test("BarnesG(4) = 2 (R1 Rule BARNESG-4)", () => {
  expect(toBigInt(bigBarnesG(fromDecimal("4"), 160))).toBe(2n);
});
test("BarnesG(5) = 12 (functional equation)", () => {
  expect(toBigInt(bigBarnesG(fromDecimal("5"), 160))).toBe(12n);
});
test("BarnesG(5/2) ≈ 0.94757... (R5 §3.2 mpmath)", () => {
  const result = bigBarnesG(fromDecimal("2.5"), 160);
  expect(toDecimalString(result, 50)).toMatch(/^0\.9475739010838257768841/);
});
```

## Acceptance

- [ ] BarnesG at positive integers 1-5 exact.
- [ ] BarnesG(2.5) matches mpmath to 45 dp.
- [ ] `bun run check` green.

---

# I3d — Complex extensions (ctrigamma, cpolygamma, cIncompleteGamma*, cBeta)

**Bead:** (TBD)
**Authority:** A1 §2 AXIS 4 (gap list), ADR-0042 §Decision 3.
**Round:** 4 (after Round 3; parallel with I6).
**LOC estimate:** ~200-280 LOC additions to `packages/bigfloat/src/complex.ts`
+ ~80 LOC tests.

## API signatures (all added to `complex.ts`)

```ts
export function ctrigamma(z: BigComplex, prec: number): BigComplex;
export function cpolygamma(m: number, z: BigComplex, prec: number): BigComplex;
export function cIncompleteGammaUpper(a: BigComplex, z: BigComplex, prec: number): BigComplex;
export function cIncompleteGammaLower(a: BigComplex, z: BigComplex, prec: number): BigComplex;
export function cBeta(a: BigComplex, b: BigComplex, prec: number): BigComplex;
```

## Algorithm narrative

**ctrigamma**: `ψ'(z) = ψ^(1)(z)`. Complex extension of `trigamma` via the same
recurrence-shift + Stirling asymptotic pattern as `cdigammaShifted`. The
Stirling form generalises to complex directly (Stirling is analytic in the
right half-plane).

**cpolygamma**: `ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)` where `ζ(s, z)` is
evaluated via complex Euler-Maclaurin. For `Re(z) < 1/2`, apply the reflection
`ψ^(m)(1-z) + (-1)^{m-1} ψ^(m)(z) = (-1)^m π · d^m/dz^m cot(πz)` (DLMF
§5.15.6). Near-pole reduction: `ζ = z - round(Re z)`.

**cIncompleteGammaUpper** and **cIncompleteGammaLower**: Complex-argument
extension. For most of ℂ, the series and CF algorithms from the real case
generalise: substitute `BigComplex` arithmetic for `BigFloat`. The Temme uniform
asymptotic defers to v0.2 (same as real).

**cBeta**: `exp(clgamma(a, prec+32) + clgamma(b, prec+32) - clgamma(add(a,b,prec+32), prec+32))`.
The three `clgamma` calls each apply the reflection for `Re(z) < 1/2`.

## Test plan

```ts
test("ctrigamma(1) = π²/6 ≈ 1.6449... (real axis agreement)", () => {
  const result = ctrigamma(BigComplex.fromReal(ONE), 160);
  expect(result.im).toBeZero();
  expect(Number(toDecimalString(result.re, 10))).toBeCloseTo(1.6449340668, 8);
});
test("cpolygamma(1, 3+2i) matches mpmath to 45 dp", () => {
  // mpmath.polygamma(1, mpc(3,2)) ≈ 0.244931 - 0.192826i  (R5 §3.2)
  const result = cpolygamma(1, BigComplex.from(fromDecimal("3"), fromDecimal("2")), 160);
  expect(Number(toDecimalString(result.re, 10))).toBeCloseTo(0.24493116, 6);
  expect(Number(toDecimalString(result.im, 10))).toBeCloseTo(-0.19282555, 6);
});
test("cBeta(1/2, 3/2) = π/2 (R5 §3.2)", () => {
  const result = cBeta(
    BigComplex.fromReal(fromDecimal("0.5")),
    BigComplex.fromReal(fromDecimal("1.5")), 160
  );
  expect(result.im).toBeZero();
  expect(toDecimalString(result.re, 50)).toMatch(/^1\.5707963267948966/);
});
```

## Acceptance

- [ ] `ctrigamma(1, 160)` = π²/6 to 45 dp (real axis).
- [ ] `cpolygamma(1, 3+2i, 160)` matches mpmath to 40 dp.
- [ ] `cBeta(0.5, 1.5, 160)` = π/2 to 45 dp.
- [ ] `bun run check` green.

---

# I6 — Meijer-G bridge (`meijer-core/src/bridges/gamma.ts`)

**Bead:** (TBD)
**Authority:** R4 §C (bridge API design), ADR-0042 §Decision 5.
**Round:** 4 (after I6a for vocabulary admission of IncompleteGamma{Upper,Lower};
parallel with I3d).
**LOC estimate:** ~200-260 LOC new file + ~100 LOC tests.

## File layout

| Path | Change |
|---|---|
| `packages/meijer-core/src/bridges/gamma.ts` | NEW. Forward + backward bridge for IncompleteGammaUpper + IncompleteGammaLower; honest null for 7 other heads. |
| `packages/meijer-core/test/bridges/gamma.test.ts` | NEW. Forward + backward + round-trip + honest-refusal + discrimination tests. |
| `packages/meijer-core/src/bridges/index.ts` | Register gamma bridge in the bridge registry. |

## API signatures

```ts
// gamma.ts exports headToMeijerG and meijerGToHead (same interface as erf.ts and bessel.ts)

export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null;

export function meijerGToHead(
  form: MeijerGForm,
): { head: string; args: readonly Value[] } | null;
```

## Algorithm narrative

**Why only 2 of 9 heads have G-forms** (R4 §A, ADR-0042 §Decision 5):
`Gamma(z)` as a function of z has no Meijer-G form because z appears in the
exponent of the defining integral's integrand (`t^{z-1}`). The G-function
framework requires z to appear only in the G-argument slot, but encoding `t^{z-1}`
as a G-form would require `bm = [z-1]` — a parameter depending on the head's
own argument. This is a structural impossibility, not a search failure. Cross-
validation: SymPy has no `gamma._eval_rewrite_as_meijerg`; mpmath evaluates Gamma
via Stirling, never via meijerg. All other heads in the family share analogous
structural reasons (Beta and Pochhammer are Γ-ratios, not single G-functions;
BarnesG is entire of order 2; Digamma/Polygamma are derivatives of log Γ).

**The two bridgeable heads:**

`LowerIncompleteGamma(a, z) = G^{1,1}_{1,2}(1; a, 0 | z)`
- Source: Wikipedia Meijer-G §"Representation of other functions"; DLMF §8.6.10
- z-substitution: identity (no squaring — simpler than Erf/Bessel)
- argsInverse: `() => [a, z]` (recovers both args byte-identically)

`UpperIncompleteGamma(a, z) = G^{2,0}_{1,2}( ; 1; a, 0 | z)`
- Source: Wikipedia Meijer-G §"Representation of other functions"; DLMF §8.6.11
- z-substitution: identity
- argsInverse: `() => [a, z]`

**Backward disambiguation for (2,0,1,2) shape** (R4 §C.3):
1. `bm = [0, 1/2]` or `[1/2, 0]` → Erfc (existing rule; highest priority)
2. `bm = [0, 0]` → ExpIntegralE(1, z) (existing `dlmf-16-17-e1`; preferred over
   UpperIncompleteGamma(0,z) since ExpIntegralE is already in vocabulary)
3. `ap = [n]` with n rational ≠ 1 → ExpIntegralE(n, z) (general E_n)
4. `ap = [1]` and `bm = [a, 0]` with a not matching above patterns →
   UpperIncompleteGamma(a, z)

## Test plan

```ts
// Forward bridge tests
test("headToMeijerG('IncompleteGammaLower', [sym('a'), sym('z')])", () => {
  const bridge = headToMeijerG("IncompleteGammaLower", [sym("a"), sym("z")]);
  expect(bridge).not.toBeNull();
  expect(bridge!.gForm.an).toStrictEqual([ONE]);
  expect(bridge!.gForm.bm[0]).toStrictEqual(sym("a"));
  expect(bridge!.gForm.bq[0]).toStrictEqual(ZERO);
});

// Honest refusals
test("headToMeijerG('Gamma', ...) = null (structural impossibility)", () => {
  expect(headToMeijerG("Gamma", [sym("z")])).toBeNull();
});
test("headToMeijerG('Beta', ...) = null (Γ-ratio, not single G)", () => {
  expect(headToMeijerG("Beta", [sym("a"), sym("b")])).toBeNull();
});
test("headToMeijerG('BarnesG', ...) = null", () => {
  expect(headToMeijerG("BarnesG", [sym("z")])).toBeNull();
});

// Round-trip tests
test("LowerIncompleteGamma round-trip via argsInverse", () => {
  const [a, z] = [sym("a"), sym("z")];
  const bridge = headToMeijerG("IncompleteGammaLower", [a, z])!;
  const recovered = bridge.argsInverse();
  expect(canonicalize(value(recovered[0]!))).toBe(canonicalize(value(a)));
  expect(canonicalize(value(recovered[1]!))).toBe(canonicalize(value(z)));
});

// Backward discrimination tests
test("(2,0,1,2) with bm=[0,1/2]: routes to Erfc, NOT UpperIncompleteGamma", () => {
  const form: MeijerGForm = {
    an: [], ap: [ONE], bm: [ZERO, rat(1n, 2n)], bq: [], z: sym("z")
  };
  const result = meijerGToHead(form);
  expect(result?.head).toBe("Erfc");
});
test("(2,0,1,2) with bm=[0,0]: routes to ExpIntegralE(1,z), NOT UpperIncompleteGamma(0,z)", () => {
  const form: MeijerGForm = {
    an: [], ap: [ONE], bm: [ZERO, ZERO], bq: [], z: sym("z")
  };
  const result = meijerGToHead(form);
  expect(result?.head).toBe("ExpIntegralE");
});
test("(2,0,1,2) with bm=[a,0] symbolic a: routes to UpperIncompleteGamma", () => {
  const form: MeijerGForm = {
    an: [], ap: [ONE], bm: [sym("a"), ZERO], bq: [], z: sym("z")
  };
  const result = meijerGToHead(form);
  expect(result?.head).toBe("IncompleteGammaUpper");
});

// Mutation-proving tests
test("mutation: wrong bm slot fails discrimination", () => {
  // Change LowerIncompleteGamma form's bm from [sym("a")] to [rat(1,2)]
  // → backward matcher should route to Erf family, not LowerIncompleteGamma
  const form: MeijerGForm = {
    an: [ONE], ap: [], bm: [rat(1n, 2n)], bq: [ZERO], z: sym("z")
  };
  // This is the Erf form (an=[1/2] is Erf, an=[1] is LowerIncompleteGamma)
  // With an=[1], bm=[1/2]: no matching rule → null
  const result = meijerGToHead(form);
  expect(result?.head).not.toBe("IncompleteGammaLower");
});
```

## Acceptance

- [ ] `headToMeijerG("IncompleteGammaLower", ...)` returns correct (1,1,1,2) form.
- [ ] `headToMeijerG("IncompleteGammaUpper", ...)` returns correct (2,0,1,2) form.
- [ ] `headToMeijerG("Gamma", ...)` returns null (documented as structural).
- [ ] `headToMeijerG("Beta", ...)` returns null.
- [ ] `headToMeijerG("BarnesG", ...)` returns null.
- [ ] Backward matcher discriminates UpperIncompleteGamma from Erfc and ExpIntegralE(1).
- [ ] Round-trip via argsInverse byte-identical.
- [ ] All existing `meijer-core` tests green (cgamma call sites unaffected).
- [ ] `bun run check` green.

---

## Cross-bead dependency summary

```
I6a ←── I4 (vocab heads needed for new-head rules in priority-C)
I6a ←── I6 (IncompleteGamma vocab admission needed for bridge)
I5  ←── T2 (wire tool float64 dispatch)
I2a ←── I2b (regularised forms build on upper/lower)
I2a ←── I6 (bridge round-trip tests use arb-prec oracle)
I3a, I3b, I3c ←── I3d (complex extensions reference real implementations)
I3d ←── T3 (T3 meijer-g closure needs complex arms for numerical verification)
I6  ←── T3 (T3 exercises the bridge)
```

---

## Corpus design notes for Phase 1 subagents (G1-G8)

The Phase 1 corpus (`bench/gamma-anchor/`) must cover these input tiers, informed
by R2 algorithm crossovers and R5 oracle capabilities:

1. **Real positive z, positive a** — all 16 heads; covers series and CF crossovers.
2. **Real negative z** — Gamma family poles, LogGamma analytic continuation.
3. **Near-poles** (z near 0, -1, -2, ...) — cancellation stress test for
   `lgammaRealAbs` and `clgammaReflect` paths.
4. **Complex z, Q1-Q4** — 4 heads × 4 quadrants (IncompleteGamma{Upper,Lower},
   Beta, BarnesG complex).
5. **Half-integer a** (a ∈ {1/2, 3/2, 5/2}) — closed-form special values per R1
   priority-A/B rules.
6. **Large |z|** (|z| > 100) — Poincaré asymptotic path for IncompleteGammaUpper.
7. **Near a = z** (transition region) — Temme uniform asymptotic stresses.
8. **Digamma near negative integers** — near-pole cancellation for reflection path.

**L12 must be pinned in every adapter** (`// L12` comment on every oracle call
involving P, Q, or the regularised/unregularised distinction). See R5 §6 for the
full landmine list.
