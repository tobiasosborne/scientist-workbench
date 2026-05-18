# Boost.Math oracle (G6 — silver + bronze tier)

**Bead:** `scientist-workbench-x1lt`
**ADR:** [`0040 §"Decision 8"`](../../../../docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md)
**Reference:** [`docs/refs/erf-research/R5-oracle-landscape.md §1, §2.4`](../../../../docs/refs/erf-research/R5-oracle-landscape.md)

Silver-tier (50-decimal arb-prec) and bronze-tier (float64) Boost.Math
oracle for the Erf-family. Consumes `bench/erf-anchor/corpus.json`;
emits `bench/erf-anchor/oracles/boost/results.json`.

Boost is the **third independent voice** at the arb-prec real branch
(alongside Wolfram + mpmath), closing the gold-tier three-way agreement
check from R5 §"Headline finding". The R5 worked example
`erf(123/100) = 0.91805010412676136789273300392075214555771922462407`
at 50 dp reproduces byte-identically with this adapter.

## Versions probed (2026-05-16, host: Ubuntu 24.04 derivative)

| Component | Version | Path |
|---|---|---|
| Boost.Math | 1.83 (`BOOST_LIB_VERSION = "1_83"`) | `/usr/include/boost/version.hpp` |
| g++ | 13.3.0 (`Ubuntu 13.3.0-6ubuntu2~24.04.1`) | `/usr/bin/g++` |
| `boost/math/special_functions/erf.hpp` | (header-only) | `/usr/include/boost/math/special_functions/erf.hpp` |
| `boost/multiprecision/cpp_bin_float.hpp` | (header-only) | `/usr/include/boost/multiprecision/cpp_bin_float.hpp` |

No `-l` link is needed; Boost.Math is header-only.

## How to (re-)run

```sh
bun bench/erf-anchor/oracles/boost/adapter.ts
```

Idempotent: skips recompilation if `./build/erf-oracle` is newer than
`erf-oracle.cpp`. First run on a fresh clone is ~5 s (heavily-templated
header inflates compile time); subsequent runs skip straight to
execution (~600 ms wall-clock for 271 corpus inputs).

## Silver vs bronze split

| Tier | Method | Real | Complex | Heads supported |
|---|---|---|---|---|
| **Silver** | `boost::multiprecision::cpp_bin_float<50>` (50 dp) | YES | **NO** | Erf, Erfc, Erfcx, InverseErf, InverseErfc |
| **Bronze** | `boost::math::erf<double>` etc. (53-bit) | YES | **NO** | Erf, Erfc, Erfcx, InverseErf, InverseErfc |

- **No complex at any precision.** Boost.Math's `erf` template
  instantiates only on ordered scalar types and rejects `std::complex`.
  R5 §1 row "arb-prec complex: NO" + "float64 complex: no"; confirmed by
  the 2026-05-16 compile test:

  ```text
  $ g++ -std=c++17 test_boost_complex.cpp -o /tmp/x
  /usr/include/boost/math/special_functions/erf.hpp:146:9:
  error: no match for 'operator<' (operand types are
  'std::complex<double>' and 'int')
        if(z < 0)
  ```

- **`Erfcx` derived from primitives.** Boost has no standalone `erfcx`,
  so silver computes it as `exp(x²) · erfc(x)` in `cpp_bin_float<50>`
  arithmetic. Both factors are Boost arb-prec primitives; the
  composition is the textbook scaled-erfc identity (DLMF 7.7.1), not a
  competing algorithm.

- **`Erfi` refused at every tier.** Boost has no `erfi` primitive, and
  the standard identity `erfi(x) = -i · erf(ix)` requires `erf` of a
  pure-imaginary argument — which is `std::complex` and therefore
  unavailable in Boost. The cleanest path is honest refusal (CLAUDE.md
  Rule 8) rather than smuggling in a non-Boost Taylor/Dawson
  implementation, which would compromise Boost's status as an
  *independent* silver voice.

- **Non-finite real inputs (Infinity, NaN) refused.** `cpp_bin_float`
  has no string parser for `"Infinity"` / `"NaN"` and Boost's arb-prec
  `erf` overflows rather than saturating at `±∞`. The 8 T6 real edge
  cases for `Erf` / `Erfc` (positive-infinity, negative-infinity, NaN
  — 4 of which round to `0.000…` in fixed-decimal-string form and are
  computable) emit refusal records with the mechanical reason.

## Expected output counts (v0.1 corpus, 271 inputs)

| Bucket | Count | Reason |
|---|---|---|
| `boost-cpp_bin_float-50` (silver) | 149 | real, head ∈ {Erf, Erfc, Erfcx, InverseErf, InverseErfc}, finite |
| `boost-refused` (complex) | 105 | Boost has no `std::complex` instantiation at any tier |
| `boost-refused` (Erfi all) | 17 | 15 complex Erfi T5 (already counted under complex) + 8 real Erfi T6 — Boost has no `erfi` primitive |
| `boost-refused` (non-finite real edges) | 9 | `Infinity` / `-Infinity` / `NaN` literals — `cpp_bin_float` cannot parse |
| **Total records** | **271** | one per corpus input (refusals not skipped) |

(The Erfi-complex inputs are double-counted as both "complex" and
"Erfi"; the union is 122 refused records — silver=149, refused=122,
total=271.)

## Output schema (per record)

```json
{
  "input_id":           "T1-erf-001",
  "head":               "Erf",
  "z":                  "0.000000…",          // or {"re":"…","im":"…"}
  "output":             "5.20…e-01"           // scientific, 50 sig digits
                        | null,               // on refusal
  "method":             "boost-cpp_bin_float-50" |
                        "boost-double"        |
                        "boost-refused",
  "achieved_precision": 50 | 53 | 0,
  "oracle_id":          "boost",
  "oracle_version":     "1_83",
  "elapsed_ms":         <integer>,
  "note":               "<reason>"            // present on refusal
}
```

Silver values are emitted in scientific notation with 50 significant
decimal digits (e.g. `"5.2049987781304653768274665389196452873645157575796e-01"`)
rather than fixed-point, so the wire shape carries the full
silver-tier contract regardless of magnitude: a tiny value like
`erfc(13) ≈ 6.88e-69` and a saturating value like `erf(very-large) = 1`
both serialise to a 50-significant-digit form. The G8 cross-oracle
comparator canonicalises this against mpmath's `nstr` and Wolfram's
`N[]` outputs (cf. R5 §2.2 closing note on rounding-mode-mismatch
handling).

## File layout

- `erf-oracle.cpp` — single-TU C++17 oracle (≈ 530 LOC including
  literate doc-comments and hand-rolled JSON parser).
- `adapter.ts` — pure-TS orchestrator (probe → build → run → verify).
- `build/` — gitignored compile output (`build/erf-oracle`).
- `results.json` — committed silver+bronze golden masters.
- `README.md` — this file.
- `.gitignore` — `build/`.
