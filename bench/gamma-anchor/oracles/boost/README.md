# Boost.Math oracle (G5 — silver tier, real-only)

**Bead:** `scientist-workbench-3v35`
**Epic:** `scientist-workbench-xqc7` (World-class Gamma-family reference implementation)
**ADR:** [`0042 §"Decision 8"`](../../../../docs/adr/0042-gamma-family-per-head-substrate.md)
**Reference:** [`docs/refs/gamma-research/R5-oracle-landscape.md §3.4, §6`](../../../../docs/refs/gamma-research/R5-oracle-landscape.md)

Silver-tier (50-decimal arb-prec) Boost.Math oracle for the Gamma family.
Consumes `bench/gamma-anchor/corpus.json` (377 inputs across 8 tiers, sha256
`1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5`); emits
`bench/gamma-anchor/oracles/boost/results.json`.

Boost.Math is the silver-tier independent voice that, together with the gold
tier (Wolfram + mpmath) and bronze tier (SciPy + libm), pins the 50-decimal
real arb-prec cross-validation per ADR-0042 §"Decision 8". Spot check:
`tgamma(1/2)` produces

```
1.7724538509055160272981674833411451827975494561225e+00
```

— agreeing with the mpmath reference value
`1.77245385090551602729816748334114518279754945612238…` to 49 decimal
digits (the 50th digit is a 1-ULP last-digit rounding, R5 §6 L2 — the
canonical silver-vs-gold tolerance the G8 comparator already absorbs).

## Why silver, real-only

Three orthogonal constraints converge on the silver-tier-real-only contract:

1. **`cpp_bin_float<50>` is the silver-tier substrate** (ADR-0042 §Decision 8).
   50 decimal digits of working precision is one full guard digit beyond the
   50-dp gold-tier emit target, so any silver-vs-gold disagreement is
   first-order detectable.
2. **Boost has no `std::complex<cpp_bin_float<N>>` instantiation** for any
   gamma-family head (R5 §3.4 "No complex support"; same finding as the
   besselj G5 and erf G6 adapters). The 44 complex corpus rows refuse with
   `status="unsupported" reason="boost-no-complex"`.
3. **Three corpus heads have no Boost primitive at all**: BarnesG (11 rows),
   Pochhammer (20 rows), Hyperfactorial (0 rows in v0.1, kept for forward
   compat). Each emits `status="unsupported"` with a head-name reason token.
   We deliberately do NOT derive Pochhammer via `tgamma_ratio`: smuggling
   in a hand-rolled identity would defeat the silver-voice independence
   contract (same discipline as Erf G6's `Erfi` refusal).

## Versions probed (2026-05-19, host: Ubuntu 24.04 derivative)

| Component | Version | Path |
|---|---|---|
| Boost.Math | 1.83 (`BOOST_LIB_VERSION = "1_83"`) | `/usr/include/boost/version.hpp` |
| g++ | 13.3.0 (`Ubuntu 13.3.0-6ubuntu2~24.04.1`) | `/usr/bin/g++` |
| `boost/math/special_functions/gamma.hpp` | header-only | `/usr/include/boost/math/special_functions/gamma.hpp` |
| `boost/math/special_functions/beta.hpp` | header-only | `/usr/include/boost/math/special_functions/beta.hpp` |
| `boost/math/special_functions/polygamma.hpp` | header-only | `/usr/include/boost/math/special_functions/polygamma.hpp` |
| `boost/multiprecision/cpp_bin_float.hpp` | header-only | `/usr/include/boost/multiprecision/cpp_bin_float.hpp` |

No `-l` link is needed; Boost.Math is header-only.

## How to (re-)run

```sh
bun bench/gamma-anchor/oracles/boost/adapter.ts
```

Idempotent: skips recompilation if `./build/oracle` is newer than
`oracle.cpp`. First run on a fresh clone takes ~22 s (gamma + beta +
digamma + trigamma + polygamma headers are all heavily templated and
`cpp_bin_float<50>` quadruples instantiation cost); subsequent runs go
straight to execution (~100 ms wall-clock for 377 corpus inputs).

## Per-head Boost call table

The oracle dispatches on the `head` field. R5 §3.4 is the canonical
reference for the Boost name → semantics mapping; every dispatcher call
site that touches the incomplete-gamma family carries a `// L12` pin so
a `grep "L12" oracle.cpp` audit returns one line per call:

| Corpus head | Arity | Boost call | Status |
|---|---|---|---|
| `Gamma` | 1 | `boost::math::tgamma(z)` | supported |
| `LogGamma` | 1 | `boost::math::lgamma(z, &sign)` (real log\|Γ\|) | supported (real-part-only) |
| `Digamma` | 1 | `boost::math::digamma(z)` | supported |
| `Trigamma` | 1 | `boost::math::trigamma(z)` | supported |
| `Polygamma` | 2 (m,z) | `boost::math::polygamma(m, z)` | supported |
| `Pochhammer` | 2 | — | **unsupported** (no native; refusing rather than smuggling tgamma_ratio) |
| `BarnesG` | 1 | — | **unsupported** (no Boost primitive) |
| `IncompleteGammaUpper` | 2 (a,z) | `boost::math::tgamma(a, z)` — `// L12` upper unregularised | supported |
| `IncompleteGammaLower` | 2 (a,z) | `boost::math::tgamma_lower(a, z)` — `// L12` lower unregularised | supported |
| `IncompleteGammaP` | 2 (a,z) | `boost::math::gamma_p(a, z)` — `// L12` P = lower regularised | supported |
| `IncompleteGammaQ` | 2 (a,z) | `boost::math::gamma_q(a, z)` — `// L12` Q = upper regularised | supported |
| `InverseIncompleteGammaP` | 2 (a,p) | `boost::math::gamma_p_inv(a, p)` — `// L12` inverts P | supported |
| `InverseIncompleteGammaQ` | 2 (a,q) | `boost::math::gamma_q_inv(a, q)` — `// L12` inverts Q | supported |
| `GammaPDerivative` | 2 (a,z) | `boost::math::gamma_p_derivative(a, z)` | supported |
| `Beta` | 2 (a,b) | `boost::math::beta(a, b)` | supported (a, b > 0) |
| `LogBeta` | 2 (a,b) | `lgamma(a) + lgamma(b) − lgamma(a+b)` (in cpp_bin_float<50>) | supported (textbook identity from Boost primitives) |
| `IncompleteBeta` | 3 (z,a,b) | `boost::math::ibeta(a, b, z)` — note arg-order swap | supported |
| `GammaRatio` | 2 (a,b) | `boost::math::tgamma_ratio(a, b)` = Γ(a)/Γ(b) | supported |
| `GammaDeltaRatio` | 2 (a,Δ) | `boost::math::tgamma_delta_ratio(a, Δ)` = Γ(a)/Γ(a+Δ) | supported |

`LogGamma` deserves a footnote: Boost's `lgamma(z, &sign)` returns
`log|Γ(z)|` (real part only) with the sign tracked separately. For
positive real z this is the analytic LogGamma value. For negative real z
non-integer, the analytic continuation has imaginary part `iπk` (where
`k` counts poles crossed) — Boost cannot represent that imaginary part
in `cpp_bin_float<50>` arithmetic. The G8 comparator on the consumer
side knows to compare against `Re(Wolfram LogGamma)` for x < 0; the
silver lane carries the real-part contribution. R5 §3.4 + ADR-0042
§"What we will not decide" §LogGamma-real-x<0 pin this trade-off.

## L12 — incomplete-gamma regularisation convention

R5 §6 L12 is the #1 trap of the gamma family: different oracles assign
the same name to different conventions. Boost's spelling is unambiguous
and matches Wolfram/mpmath (only SciPy inverts):

```
WOLFRAM:           Gamma[a, z]              = Γ(a, z) upper unreg     → Upper
                   GammaRegularized[a, z]   = Q(a, z) upper reg       → Q
                   Gamma[a, 0, z]           = γ(a, z) lower unreg     → Lower
                   GammaRegularized[a, 0, z]= P(a, z) lower reg       → P

MPMATH:            gammainc(a, z)           = Γ(a, z)                  → Upper
                   gammainc(a, z, reg=True) = Q(a, z)                  → Q
                   gammainc(a, 0, z)        = γ(a, z)                  → Lower
                   gammainc(a, 0, z, reg=T) = P(a, z)                  → P

BOOST:             tgamma(a, z)             = Γ(a, z) upper unreg     → Upper
                   tgamma_lower(a, z)       = γ(a, z) lower unreg     → Lower
                   gamma_p(a, z)            = P(a, z) lower reg       → P
                   gamma_q(a, z)            = Q(a, z) upper reg       → Q

SCIPY:             gammainc(a, z)           = P(a, z)  LOWER REG      → P   ← name inversion
                   gammaincc(a, z)          = Q(a, z)                  → Q
```

The Boost adapter pins `// L12` on each of the six relevant call sites
(Upper, Lower, P, Q, InverseP, InverseQ) so a grep audit across all
oracle adapters in the gamma-anchor family returns matching annotations.

## L_pole — Boost throws at gamma poles

`tgamma(0)`, `tgamma(-n)` for positive integer `n`, and `digamma(0)`,
`digamma(-n)` raise `boost::math::evaluation_error` (a subclass of
`std::domain_error`). The oracle catches all `std::exception` descendants
and emits

```json
{ "status": "refused",
  "method": "boost-refused",
  "reason": "std-exception: <Boost's verbose what() message>" }
```

R5 §6 L17 documents the four different oracle behaviors at poles
(Wolfram `ComplexInfinity`, mpmath `ValueError`, SciPy `+∞`, libm `NaN`,
and now Boost `std-exception`); the comparator on the consumer side
special-cases pole inputs.

## Number formatting

Silver values emit in scientific notation with 50 significant decimal
digits via `std::ostringstream << std::setprecision(49)` (mantissa digit
+ 49 fractional = 50 sig digits). Zero is special-cased to a canonical
`"0.0…0e+00"` rendering.

Boost's `cpp_bin_float<50>` stream operator uses the `1.234e+05` form
(explicit `+` in the exponent). The TS adapter passes this through
unchanged; if a downstream consumer needs the `1.234e5` form (no `+`)
the rewrite lives at that layer rather than mutating the silver wire.

## Expected output counts (v0.1 corpus, 377 inputs)

| Bucket | Count | Reason |
|---|---|---|
| `success` (silver) | **295** | finite-real-z, supported head, away from poles |
| `unsupported`, reason `boost-no-complex` | **44** | every complex `{re, im}` row across all heads |
| `unsupported`, reason `boost-no-pochhammer` | **20** | every Pochhammer row (no Boost primitive) |
| `unsupported`, reason `boost-no-barnesg` | **7** | every real BarnesG row (4 complex BarnesG hit the complex check first) |
| `refused`, reason `std-exception: …` | **11** | gamma / digamma at integer poles (Γ(0), Γ(-1), Γ(-2), Γ(-3); ψ(0), ψ(-1), ψ(-2), ψ(-3); and three Beta rows with negative `a`) |
| `driver_error` | **0** | every refusal traces to a documented mathematical or capability-matrix reason |
| **Total records** | **377** | one per corpus input (no row silently dropped) |

The complete absence of `driver_error` records is meaningful: every
input Boost cannot handle traces to a documented mathematical or
capability-matrix reason. If a `driver_error` record appears in a
future run it is signal, not noise.

## Output schema (per record)

```json
{
  "input_id":           "T1-gamma-001",
  "head":               "Gamma",
  "args":               { "z": "1.000…" },               // or {z:{re,im}}, or {a, b}, etc.
  "value":              "1.0000…e+00"                    // 50 sig digits, scientific
                        | null,                          // on refusal / unsupported
  "method":             "boost-cpp_bin_float-50" |
                        "boost-refused"          |
                        "boost-unsupported",
  "achieved_precision": 50 | 0,
  "oracle_id":          "boost",
  "oracle_version":     "1_83",
  "elapsed_ms":         <integer>,                       // wall-clock, varies between runs
  "status":             "success" | "refused" | "unsupported",
  "reason":             "<text>"                         // present on refusal / unsupported
}
```

## Reproducibility

Same compiler + same Boost version → byte-identical `value`, `method`,
`status`, `reason` fields across runs. The `elapsed_ms` field carries
wall-clock noise and is expected to differ between runs — it is a
diagnostic field, not part of the determinism contract.

## File layout

- `oracle.cpp` — single-TU C++17 oracle (~700 LOC including literate
  doc-comments and hand-rolled JSON parser).
- `adapter.ts` — pure-TS Bun orchestrator (probe → build → run → verify).
- `build/` — gitignored compile output (`build/oracle`).
- `results.json` — committed silver-tier golden masters.
- `README.md` — this file.
- `.gitignore` — `build/`.
