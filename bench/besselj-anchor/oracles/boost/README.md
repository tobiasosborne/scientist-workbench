# Boost.Math oracle (G5 — silver + bronze tier)

**Bead:** `scientist-workbench-5zxc`
**Epic:** `scientist-workbench-zcam` (World-class Bessel J + Y + I + K)
**ADR:** [`0041 §"Decision 8"`](../../../../docs/adr/0041-bessel-family-per-head-substrate.md)
**Reference:** [`docs/refs/besselj-research/R5-oracle-landscape.md §2, §4, §6`](../../../../docs/refs/besselj-research/R5-oracle-landscape.md)

Silver-tier (50-decimal arb-prec) and bronze-tier (float64) Boost.Math
oracle for the Bessel J/Y/I/K family. Consumes
`bench/besselj-anchor/corpus.json` (1766 inputs across 10 tiers); emits
`bench/besselj-anchor/oracles/boost/results.json`.

Boost.Math is the silver-tier independent voice that, together with
the gold tier (Wolfram + mpmath + Arb), pins the 50-decimal real
arb-prec cross-validation per ADR-0041 §"Decision 8". The R5 worked
example `cyl_bessel_i(0, 700) =
1.5295933476718737363162072288904508649662689614637e+302` reproduces
byte-identically with this adapter (verified against `T6-besseli-007`
in the emitted `results.json`).

## Versions probed (2026-05-17, host: Ubuntu 24.04 derivative)

| Component | Version | Path |
|---|---|---|
| Boost.Math | 1.83 (`BOOST_LIB_VERSION = "1_83"`) | `/usr/include/boost/version.hpp` |
| g++ | 13.3.0 (`Ubuntu 13.3.0-6ubuntu2~24.04.1`) | `/usr/bin/g++` |
| `boost/math/special_functions/bessel.hpp` | header-only | `/usr/include/boost/math/special_functions/bessel.hpp` |
| `boost/multiprecision/cpp_bin_float.hpp` | header-only | `/usr/include/boost/multiprecision/cpp_bin_float.hpp` |

No `-l` link is needed; Boost.Math is header-only.

## How to (re-)run

```sh
bun bench/besselj-anchor/oracles/boost/adapter.ts
```

Idempotent: skips recompilation if `./build/bessel-oracle` is newer
than `bessel-oracle.cpp`. First run on a fresh clone takes ~55 s
(Boost.Math's cyl_bessel family is heavily templated; cpp_bin_float
quadruples instantiation cost); subsequent runs go straight to
execution (~1.5 s wall-clock for 1766 corpus inputs).

## Silver vs bronze split

| Tier | Method | Real | Complex | Heads supported |
|---|---|---|---|---|
| **Silver** | `boost::multiprecision::cpp_bin_float<50>` (50 dp) | YES | **NO** | BesselJ, BesselY, BesselI, BesselK, BesselIScaled, BesselKScaled |
| **Bronze** | `double` template arg (53-bit) | YES | **NO** | same six heads |

Each success record carries BOTH `value_silver` (the 50-dp arb-prec
voice) AND `value_bronze` (the float64 voice) — the G8 cross-oracle
comparator consumes silver for gold-tier agreement and bronze for
float64-tier agreement at platform-fingerprint-recorded precision.

## Boost API spellings (R5 §6 L_boost_yspell — load-bearing)

Boost.Math's Y_ν entry point is `boost::math::cyl_neumann`, **NOT**
`cyl_bessel_y`. Calling `cyl_bessel_y` fails to compile with a
misleading "did you mean cyl_bessel_k?" suggestion. The C++ source
calls `cyl_neumann` directly at both lanes; pre-pinning this here so
any future reader sees the spelling before reading the source:

```cpp
y = boost::math::cyl_bessel_j(nu, z);   // BesselJ
y = boost::math::cyl_neumann  (nu, z);   // BesselY  ← spelling matters!
y = boost::math::cyl_bessel_i(nu, z);   // BesselI
y = boost::math::cyl_bessel_k(nu, z);   // BesselK
```

Scaled variants are computed as `exp(-|z|) · cyl_bessel_i(nu, z)`
(BesselIScaled) and `exp(z) · cyl_bessel_k(nu, z)` (BesselKScaled).
At the silver tier the exponential factor is computed in
`cpp_bin_float<50>` arithmetic — its exponent range (~2^31 binary) is
enormous, so the silver lane never trips the float64 |z|≈700
over/underflow cliff that R5 §6 L9/L10 pin. The bronze lane WILL trip
that cliff at extreme `z` (we let it — bronze's contract is "what
Boost in float64 produces").

## L4 — Boost Y tail cancellation (observed-bounded)

R5 §6 L4 documents that for moderate-large z, Boost docs warn Y_ν loses
bits via catastrophic cancellation in the Hankel tail. R5's
`boost-y-tail-probe` observed L4 does NOT manifest at z ≤ 1e10 in
Boost 1.83 — Boost still emits values, just at slightly less than 50
dp at the extreme tail.

**Adapter policy:** emit at the full 50-dp width and let the G8
cross-agreement comparator handle per-cell precision degradation. We
do not pre-emptively truncate or refuse on suspected L4 cases — that
would hide silver-tier evidence from the comparator.

## No complex Bessel at any precision

`boost::math::cyl_bessel_*` templates instantiate only on ordered
scalar types and reject `std::complex` (R5 §2 row "arb-prec complex:
NO" + R5 §4 `boost-complex-probe-output.txt`). All 128 T5 complex
inputs in `corpus.json` emit a clean refusal record:

```json
{ "method": "boost-refused",
  "status": "refused",
  "reason": "boost-no-complex-bessel",
  "value_silver": null, "value_bronze": null }
```

Refusal is documented per-input rather than silently skipped
(CLAUDE.md Rule 1, "fail loud"); the parent adapter reconciles the
count (CLAUDE.md Rule 8, "honest scope").

## ν parsing (3 classes)

The C++ side reads the corpus's `nu` field as a raw string and sniffs
the format:

| nu_kind | Example wire form | C++ handling |
|---|---|---|
| `integer` | `"0"`, `"1"`, `"-1"`, `"10"`, `"100"`, `"500"` | `Real50(nu_str)` — Boost accepts integer-valued decimal strings |
| `half-integer` | `"1/2"`, `"-1/2"`, `"3/2"`, `"5/2"`, `"7/2"` | split on `/`, build `Real50(num) / Real50(den)`. Bit-exact since denominator is always a power of 2 |
| `decimal` | `"1.69999…"`, `"-1.69999…"`, `"4.69999…"` | `Real50(nu_str)` — fixed-decimal-string ctor |

## Expected output counts (v0.1 corpus, 1766 inputs)

| Bucket | Count | Reason |
|---|---|---|
| `success` (silver + bronze) | **1578** | finite-real-z, head ∈ {BesselJ, BesselY, BesselI, BesselK, BesselIScaled, BesselKScaled} |
| `refused`, reason `boost-no-complex-bessel` | **128** | All T5 complex inputs (Boost has no `std::complex` instantiation at any tier) |
| `refused`, reason `non-finite-real-input` | **36** | T6 edges with `z ∈ {Infinity, -Infinity, NaN}` for all six heads — `cpp_bin_float` cannot parse these literals |
| `refused`, reason `singular-at-z-zero` | **24** | T6 inputs with z=0 for BesselY and BesselK — both have a mathematical singularity at the origin (DLMF 10.7.2 / 10.30.2) |
| `error` | **0** | All Boost throws traced to documented refusal classes; none are driver bugs |
| **Total records** | **1766** | one per corpus input (refusals not skipped) |

The complete absence of `error` records is meaningful: every input
Boost cannot handle traces to a documented mathematical or
capability-matrix reason. If an `error` record appears in a future run
it is signal, not noise.

## Output schema (per record)

```json
{
  "input_id":           "T1-besselj-001",
  "head":               "BesselJ",
  "nu":                 "0",
  "z":                  "0.001000…",          // or {"re":"…","im":"…"}
  "value_silver":       "9.99999750000…e-01"   // 50 sig digits, scientific
                        | null,                // on refusal
  "value_bronze":       "0.99999975000001562"  // 17 sig digits, float64
                        | null,                // on refusal
  "method":             "boost-cpp_bin_float-50" |
                        "boost-double" |
                        "boost-refused",
  "achieved_precision": 50 | 53 | 0,
  "oracle_id":          "boost",
  "oracle_version":     "1_83",
  "elapsed_ms":         <integer>,             // wall-clock, varies between runs
  "status":             "success" | "refused" | "error",
  "reason":             "<text>"               // present on refusal / error
}
```

Silver values are emitted in scientific notation with 50 significant
decimal digits (e.g.
`"7.6519768655796655144971752610266322090927428975532e-01"`) so the
wire shape carries the full silver-tier contract regardless of
magnitude: a tiny value like K_0(700) ≈ 4.67e-306 and a saturating
value like I_0(700) ≈ 1.53e+302 both serialise to 50-significant-
digit form. Bronze values are 17-significant-digit decimal
(round-trip-exact for IEEE 754 binary64).

## Reproducibility

The `value_silver`, `value_bronze`, `method`, `status`, and `reason`
fields are byte-identical across runs given the same corpus + Boost
version (verified 2026-05-17 with `jq -S` field-by-field diff). The
`elapsed_ms` field carries wall-clock noise and is expected to differ
between runs — it is a diagnostic field, not part of the determinism
contract.

## File layout

- `bessel-oracle.cpp` — single-TU C++17 oracle (≈ 620 LOC including
  literate doc-comments and hand-rolled JSON parser).
- `adapter.ts` — pure-TS Bun orchestrator (probe → build → run → verify).
- `build/` — gitignored compile output (`build/bessel-oracle`).
- `results.json` — committed silver+bronze golden masters.
- `README.md` — this file.
- `.gitignore` — `build/`.
