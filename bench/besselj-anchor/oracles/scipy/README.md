# SciPy Oracle (G4 — Bronze tier, float64) — Bessel J / Y / I / K + Scaled

**Bead:** `scientist-workbench-qvnm`
**Phase:** BesselJ-anchor Phase 1, Tier 4 (bronze, float64)
**Epic:** `scientist-workbench-zcam` ([epic] World-class Bessel)
**ADR:** [`docs/adr/0041-bessel-family-per-head-substrate.md`](../../../../docs/adr/0041-bessel-family-per-head-substrate.md) — see §"Decision 8" (oracle hierarchy / bronze tier).

## Role in the oracle hierarchy

This adapter is the **primary bronze-tier voice** for the Bessel-family
golden-master suite — and the **only** bronze voice with full coverage of all
24 (head × ν-class × {real, complex}) cells of the matrix on this host. The
sibling bronze voices are narrower:

- **libm** (`<math.h>`) — `j0/j1/jn/y0/y1/yn` only, real-only, integer-ν only.
  Covers 6 cells / 24 (the integer-ν J and Y real-axis cells).
- **Boost `<double>`** — template-fails on `std::complex<double>`
  (R5 §3.4 — same compile error as `cpp_bin_float<N>`). Real-only.

SciPy covers all 24 cells via Donald Amos's TOMS 644 Fortran suite
(`zbesj.f` / `zbesy.f` / `zbesi.f` / `zbesk.f`) for general-ν and Stephen
Moshier's Cephes specialisations for integer-ν `j0`/`j1`/`y0`/`y1` — plus
the scaled variants `ive(ν, z) = e^{-|z|}·I_ν(z)` and
`kve(ν, z) = e^z·K_ν(z)` that mitigate L9 / L10 (the `|z| > 700` overflow /
underflow cliffs for unscaled `iv` / `kv`).

Per ADR-0041 §"Decision 8" the bronze-tier acceptance target is
ULP-distance ≤ 2 vs gold (Wolfram + mpmath + Arb truncated to float64). This
adapter's output is the comparison target for the in-substrate float64
evaluators landing in Phase 2 (beads `rkoo` I5a real, `q7ty` I3a complex,
`t73h` I3b complex modified).

## AMOS / Cephes lineage

SciPy 1.17's Bessel family wraps two upstream codebases:

- **AMOS TOMS 644** (Donald E. Amos, Sandia National Labs, 1986; ACM TOMS
  algorithm 644 published 1995). Routines `ZBESJ` / `ZBESY` / `ZBESI` /
  `ZBESK` (plus ~30 internal callees) implementing the canonical algorithms
  for cylindrical Bessel functions over the entire complex plane. The
  free-of-charge reference implementation; SciPy and Julia
  (`SpecialFunctions.jl`) both wrap it. Algorithmic notes: backward
  recurrence in ν, Miller's algorithm with normalisation, asymptotic series
  for large `|z|`, Olver uniform asymptotic for large ν.

- **Cephes** (Stephen Moshier, 1984–2000). `j0.c` / `j1.c` / `y0.c` / `y1.c`
  / `jn.c` / `yn.c` / `i0.c` / `i1.c` / `k0.c` / `k1.c` — the libm-grade
  integer-ν real-axis ports. SciPy uses these for `sp.j0` / `sp.j1` etc.;
  `sp.jv(int, real)` dispatches through AMOS rather than Cephes for ν > 1.

Both lineages are **algorithmically independent** from the in-substrate
ports the workbench will ship (musl SunPro for integer-ν J/Y per R3; Boost
`i0`/`i1`/Holoborodko for I; Cephes `k0`/`k1` for K — same Moshier code but
re-derived in TS, not wrapped; Boost `bessel_jy.hpp` for general-ν J/Y via
Steed CF1+CF2 + Temme; SciPy's `ikv_temme` for general-ν I/K). Independence
is what makes joint AMOS↔in-substrate 2-ULP agreement on the corpus strong
evidence of correctness rather than mere shared-bug agreement.

## Versions probed (2026-05-17)

| Tool       | Version | Source             |
|------------|---------|--------------------|
| Python     | 3.12.3  | system (GCC 13.3)  |
| SciPy      | 1.17.0  | pre-installed      |
| NumPy      | 1.26.4  | pre-installed      |

Probe command:
```sh
python3 -c "import scipy, numpy, sys; print('scipy', scipy.__version__); print('numpy', numpy.__version__); print('python', sys.version)"
```

## Install state

**No installation required.** SciPy 1.17.0 + NumPy 1.26.4 + Python 3.12.3 are
available system-wide on this host (R5 §3.5 install path:
`/usr/lib/python3.12/dist-packages/scipy/special/`).

## Re-run

```sh
bun bench/besselj-anchor/oracles/scipy/adapter.ts
```

The adapter:

1. Reads `bench/besselj-anchor/corpus.json` (1766 inputs across 10 tiers,
   6 heads, 3 ν-classes).
2. Spawns one `python3` subprocess via `Bun.spawn` with an embedded SciPy
   program (passed via stdin; no temp `.py` file).
3. The Python side parses each input's `nu` per `nu_kind` (integer
   `int(s)` → `float`; half-integer `"a/b"` → `float(a)/float(b)`; decimal
   `float(s)`), parses `z` as real `float` or complex `complex(re, im)`,
   and dispatches to `scipy.special.{jv, yv, iv, kv, ive, kve}`.
4. Flags float64-boundary cases (underflow ≤ `2·DBL_MIN`, overflow
   ≥ `DBL_MAX/2`, NaN, ±inf) AS `status: "limit"` when the corpus tier is
   one of {T6, T7, T10} — the tiers where boundary-hitting is documented as
   expected per the corpus generator.
5. Writes `bench/besselj-anchor/oracles/scipy/results.json`.

**Typical wall-time: ~1 s** for the full 1766-input corpus (Python boot
~220 ms; per-record ~80 µs warm). Well under the ~30 s upper bound the
Mission's 30 s–2 min estimate allows for.

## L5 / L9 / L10 — boundary-value flagging discipline

Three SciPy-specific landmines from R5 §6 are pinned in this adapter:

- **L5** — `scipy.special.jv(ν, z)` silently underflows to `0.0`, overflows
  to `inf`, or returns `nan` at the float64 boundary without raising. The
  corpus deliberately probes this in T6 (`z = ±∞`, `NaN`), T7 (large-ν
  Debye), and T10 (large-ν integer with small z).

- **L9** — `scipy.special.kv(ν, z)` underflows at `z > 700` (since
  `K_ν(z) ~ √(π/2z)·e^{-z}` shrinks past `2^-1074 ≈ 5e-324`). The scaled
  variant `kve(ν, z) = e^z·K_ν(z)` is the load-bearing mitigation; the
  corpus has 20 `BesselKScaled` inputs in T3 specifically to validate that
  path. The adapter still emits the unscaled `kv` value at large z (as
  `status: "limit"`) for completeness.

- **L10** — `scipy.special.iv(ν, z)` overflows at `z > 700`. Mirror: the
  scaled variant `ive(ν, z) = e^{-|z|}·I_ν(z)` stays in range, and the
  corpus has 20 `BesselIScaled` inputs in T3 to exercise it.

The flag fires on values matching the boundary predicate
(`|x| ≤ 2·DBL_MIN`, `|x| ≥ DBL_MAX/2`, or non-finite) AND occurring in one
of the limit-expected tiers. The actual SciPy-returned value lands in the
`scipy_returned` field alongside the canonical `value`, and the `notes`
string carries the regime description (e.g. `"L5 NaN at expected tier"` or
`"L10 overflow band (1.529e+302) at expected tier"`). The G8 cross-oracle
agreement matrix consumes `status: "limit"` records under absolute-error
tolerance bands (per R5 §5 L7 zero-band + L5/L9/L10 boundary-band logic);
this is G8's concern, not G4's.

Note that **scaled variants can also hit the boundary** at extreme ν+z
combinations — e.g. `ive(500, 1) = 0.0` (because `exp(-1)·I_500(1)` is
sub-subnormal) and `kve(500, 1) = inf` (because the scaling factor only
cancels the dominant exponential, not the polynomial-in-ν growth). The flag
logic applies uniformly across scaled and unscaled.

## Real-input-vs-complex-input discipline (R5 §3.5)

R5 §3.5 documents an observed accuracy delta: `sp.iv(0.5, 3+0j)` returns
`4.614822903407577` (3 ULP off gold) while `sp.iv(0.5, 3)` returns
`4.614822903407602` (gold-exact). The COMPLEX-input AMOS recurrence is less
accurate than the REAL-input AMOS/Cephes path on the pure-real axis. This
adapter ALWAYS dispatches on the WIRE shape of `z`: a corpus string `z`
goes to the real-input call; only a `{re, im}` dict triggers the complex
path. The corpus's T5 tier is the only one with complex z; T1–T4, T6–T10
are all real, so the ULP-divergence quirk is mechanically avoided for the
1638 real inputs.

## Output schema

Top-level:

```jsonc
{
  "oracle_id": "scipy",
  "oracle_version": "SciPy 1.17.0 / Python 3.12.3 / NumPy 1.26.4",
  "scipy_version": "1.17.0",
  "numpy_version": "1.26.4",
  "python_version": "3.12.3",
  "generated_at": "2026-05-17T...",
  "bead": "scientist-workbench-qvnm",
  "corpus_bead": "scientist-workbench-qccc",
  "corpus_manifest_version": 1,
  "corpus_generated_at": "2026-05-17T00:00:00Z",
  "corpus_seed": 20260517,
  "tier": "bronze",
  "precision_emit": "float64 (Python repr; shortest round-trip)",
  "platform": { "arch": "x64", "os": "linux", "runtime": "bun-1.3.13" },
  "totals": { "records": 1766, "success": 1667, "limit": 99, "error": 0, ... },
  "results": [ ... ]
}
```

Per-record:

```jsonc
{
  "id": "T1-besselj-001",         // copied from corpus input
  "head": "BesselJ",              // copied
  "tier": "T1",                   // copied
  "nu_kind": "integer",           // copied
  "status": "success",            // "success" | "limit" | "error"
  "value": "0.9999997500000156",  // Python repr(float) — bit-exact round-trip
  // or for complex inputs:
  // "value": {"re": "...", "im": "..."}
  // or for non-finite results:
  // "value": "NaN" | "Infinity" | "-Infinity"
  "method": "scipy.special.jv",   // or "...-limit-boundary" when status="limit"
  "elapsed_ms": 0.012,
  "notes": null                   // string when status≠"success"
}
```

For `status: "limit"` records the additional `scipy_returned` field carries
the same shape as `value` (currently equal to `value`; the field exists so
G8 can disambiguate the SciPy-returned bytes from any future
adapter-side canonicalisation).

Float64 values render via Python `repr()` — the shortest decimal that
round-trips bit-exactly to the same float64. A downstream consumer's
`Number(s)` (JS) or `float(s)` (Python) recovers the exact 64-bit pattern.

## Coverage tally (on the current 1766-input corpus)

```
totals: { records: 1766, success: 1667 (94.39%), limit: 99, error: 0 }
                          ─ success + limit = 100.00% ─
```

Per-tier:

| Tier | success | limit | error |
|------|---------|-------|-------|
| T1   |   468   |   0   |   0   |
| T2   |   364   |   0   |   0   |
| T3   |   336   |   0   |   0   |
| T4   |    96   |   0   |   0   |
| T5   |   128   |   0   |   0   |
| T6   |    17   |  79   |   0   |
| T7   |    78   |   2   |   0   |
| T8   |    30   |   0   |   0   |
| T9   |   120   |   0   |   0   |
| T10  |    30   |  18   |   0   |

Per (limit-tier × head):

| Tier | head            | limit |
|------|-----------------|-------|
| T6   | BesselJ         |  17   |
| T6   | BesselY         |  21   |
| T6   | BesselI         |  17   |
| T6   | BesselK         |  24   |
| T7   | BesselI         |   1   |
| T7   | BesselK         |   1   |
| T10  | BesselJ         |   3   |
| T10  | BesselY         |   3   |
| T10  | BesselI         |   3   |
| T10  | BesselK         |   3   |
| T10  | BesselIScaled   |   3   |
| T10  | BesselKScaled   |   3   |

Every limit-flagged record is in a tier the corpus explicitly designates as
boundary-probing (T6 edges / T7 large-ν Debye / T10 large-ν integer); zero
unexpected boundary hits. The combined success+limit coverage is **100% of
the 1766 inputs** — SciPy delivers a defensible float64 value for every
corpus row, far exceeding the Mission's ≥95% success target. The split
between `success` and `limit` is informational, not pass/fail: a
limit-flagged record carries the SciPy-returned bytes verbatim, just with
the metadata G8 needs to switch comparator branches.

## Determinism

Per ADR-0041 §"Decision 9" and ADR-0015, this oracle's outputs are tagged
`numerical: true`: bit-identical on a given platform fingerprint
(`{arch, os, runtime}`) but cross-platform divergence is possible. The
platform fingerprint is recorded in `results.json::platform`; G8 cache-hit
checks must compare on platform match.

**Re-run byte-identity verified:** running the adapter twice in succession
produces a `results` array where all 1766 records are byte-identical except
for the cosmetic `elapsed_ms` field (which is per-run wall-time
measurement and not load-bearing for the bronze-tier value contract). All
`status` / `value` / `scipy_returned` / `method` / `notes` fields are
byte-identical between runs.
