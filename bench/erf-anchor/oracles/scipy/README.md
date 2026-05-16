# SciPy Oracle (G4 — Bronze tier, float64)

**Bead:** `scientist-workbench-1f8r`
**Phase:** Erf-anchor Phase 1, Tier 4 (bronze, float64)
**ADR:** [`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`](../../../../docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md) — see §"Decision 4" (float64 contract) and §"Decision 8" (oracle hierarchy / bronze tier).

## Role in the oracle hierarchy

This adapter is one of three **bronze-tier** voices for the Erf golden-master
suite. Bronze tier validates the **float64** lane only — the SunPro-1993 port
we will ship in Phase 2 (bead I5) will be graded against this oracle plus the
sibling G6 (Boost `<double>`) and the libm voice.

SciPy is **not** an arb-prec oracle. It is float64 throughout. Use the gold
tier (Wolfram + mpmath at 50+ decimals) for deep-precision validation; use
this oracle for `ULP-distance ≤ 2` agreement on the float64 evaluator (per
ADR-0040 §"Decision 8" bronze acceptance target).

## Cephes lineage

SciPy 1.17's real-axis special-function family
(`scipy.special.erf`/`erfc`/`erfcx`/`erfi`/`erfinv`/`erfcinv`) wraps **Stephen
Moshier's Cephes library** (`cprob/ndtr.c`), maintained 1984–2000 in the
public-domain libm tradition. See `docs/refs/erf-research/R3-float64-algorithms.md`
§1.1 for the upstream characterisation: degree-4/5 rational in z² for
|x| < 1; rational pieces in x split at |x| = 8 for `erfc`; claimed peak
accuracy 1.3e-15 / RMS 2.2e-16 (≈ 6 ULPs peak).

Cephes is **algorithmically independent** from the SunPro-1993 port we will
ship (different rational fits, different asymptotic variable). The
independence is exactly what makes joint Cephes–SunPro agreement at ≤ 2 ULP
strong evidence of correctness.

The complex-axis path routes through Steven G. Johnson's MIT Faddeeva package
(`scipy.special.wofz` — the Faddeeva `w(z)` primitive). The adapter derives
`Erf` / `Erfc` / `Erfcx` / `Erfi` algebraically from `wofz` per the
Karbach §2 / DLMF §7.4 identity table; see the algorithm narrative at the top
of [`adapter.ts`](adapter.ts) for the derivation rules and the half-plane
sign split.

## Versions probed (2026-05-16)

| Tool       | Version | Source          |
|------------|---------|-----------------|
| Python     | 3.12.3  | system (GCC 13.3) |
| SciPy      | 1.17.0  | pre-installed   |
| NumPy      | 1.26.4  | pre-installed   |

Probe command:
```sh
python3 -c "import scipy, numpy, sys; print('scipy', scipy.__version__); print('numpy', numpy.__version__); print('python', sys.version)"
```

## Install state

**No installation required.** SciPy 1.17.0 + NumPy 1.26.4 + Python 3.12.3 are
available system-wide on this host (per `R5-oracle-landscape.md` §2.5).

## Re-run

```sh
bun bench/erf-anchor/oracles/scipy/adapter.ts
```

The adapter:
1. Reads `bench/erf-anchor/corpus.json` (271 inputs).
2. Spawns one `python3` subprocess with an embedded SciPy program (passed via
   stdin; no temp file).
3. Evaluates each input via `scipy.special` (real) or `scipy.special.wofz`
   plus the Karbach derivation (complex).
4. Writes `bench/erf-anchor/oracles/scipy/results.json`.

Typical run: ~0.6 s for the full 271-input corpus.

## Output schema

Each record in `results.json::results[]`:

```jsonc
{
  "id": "T1-erf-004",                    // copied from corpus input
  "head": "Erf",                         // copied
  "tier": "T1",                          // copied
  "output": "0.5204998778130465",        // Python repr(float) — bit-exact round-trip
  // or for complex inputs:
  // "output": {"re": "...", "im": "..."}
  // or for non-finite results:
  // "output": "NaN" | "Infinity" | "-Infinity"
  "method": "scipy.special-cephes",      // or "scipy.special.wofz-Faddeeva-Johnson"
                                         // or "scipy.special.<head>-overflow-fallback"
  "achieved_precision": 53,              // float64 mantissa bits
  "oracle_id": "scipy",
  "oracle_version": "1.17.0",
  "numpy_version": "1.26.4",
  "elapsed_ms": 0.012
}
```

Float64 values render via Python `repr()` — the shortest decimal that
round-trips bit-exactly to the same `double`. A downstream consumer's
`float(s)` recovers the exact 64-bit pattern SciPy returned.

## Method-tag distribution (on the current corpus)

The complex-path Karbach derivation `1 − exp(−z²)·w(iz)` overflows float64 in
the high-|Im(z)| regions of T4 (pure-imag y ≈ 30) and T7 (Stokes-band
|Im(z)| ≈ 30) because `exp(Im² − Re²)` can exceed `~10^308`. In those four
cases the adapter falls back to SciPy's direct dispatch (which uses
overflow-aware scaling inside the Faddeeva C kernel) and tags the record with
`scipy.special.<head>-overflow-fallback`. Both paths are SciPy /
Cephes / Faddeeva-Johnson lineage; the tag exists so the G8 cross-oracle
agreement matrix can grade these records separately.

| Method tag                                  | Records |
|---------------------------------------------|---------|
| `scipy.special-cephes` (real)               | 166     |
| `scipy.special.wofz-Faddeeva-Johnson`       | 101     |
| `scipy.special.erf-overflow-fallback`       | 1       |
| `scipy.special.erfc-overflow-fallback`      | 3       |
| **Total**                                   | **271** |

## Determinism

Per ADR-0040 §"Decision 9" and ADR-0015, this oracle's outputs are tagged
`numerical: true`: bit-identical on a given platform fingerprint
(`{arch: "x64", os: "linux", runtime: "bun-1.3.13"}`) but cross-platform
divergence is possible. The platform fingerprint is recorded in
`results.json::platform`; G8 cache-hit checks must compare on platform match.
