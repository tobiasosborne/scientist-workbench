# SciPy oracle (G4 — Bronze tier, float64) — Gamma family

**Bead:** `scientist-workbench-tqwc` (Phase 1 G4, SciPy bronze-tier oracle adapter).
**ADR:** [`docs/adr/0042-gamma-family-per-head-substrate.md`](../../../../docs/adr/0042-gamma-family-per-head-substrate.md) §"Decision 8" (oracle hierarchy / bronze tier).
**Research:** [`R5-oracle-landscape.md`](../../../../docs/refs/gamma-research/R5-oracle-landscape.md) §3.3 + §6 (landmines L12, L13, L14, L15, L17).

## What this oracle is

`results.json` — a parallel-shape manifest of float64 values for every row of [`../../corpus.json`](../../corpus.json) (377 inputs across T1–T8 tiers × 19 ADMITTED_HEADS), computed with **SciPy 1.17.0** at native float64 precision (IEEE-754 double, ~15.95 decimal digits) and emitted via `f"{x:.17g}"` (17-digit round-trip guarantee).

SciPy sits at the **bronze tier** of the R5 oracle hierarchy (alongside libm). It is the **workhorse float64 oracle** with the widest head coverage of any local oracle — 17 of 19 corpus heads emit a numeric answer; `BarnesG` is unsupported wholesale (`status: "unsupported"`), and complex `Polygamma`/`Trigamma`/`IncompleteGamma{Upper,Lower,P,Q}` refuse cleanly per L14 (`status: "refused"`).

SciPy 1.17.0 wraps Stephen Moshier's **Cephes** (`gamma.c`, `igam.c`), the SunPro-1993 lineage (`e_lgamma_r.c`), Boost's `digamma.hpp` / `polygamma.hpp`, and SciPy's own `_loggamma.pxd` for complex-aware variants. This substrate is algorithmically **independent** from the in-substrate ports the workbench will ship in Phase 2 (musl SunPro for integer-ν J/Y per R3; TS ports of Cephes functions; Boost reference implementations re-derived in TS). Independence is load-bearing: a joint Cephes↔in-substrate ≤ 3-ULP agreement on the corpus is strong evidence of correctness rather than shared-bug agreement (per ADR-0042 §"Decision 8" bronze-tier acceptance target).

## Per-head call table — 19 ADMITTED_HEADS

| Head | SciPy function | Status | Notes |
|------|---|---|---|
| `Gamma` | `sp.gamma(z)` | real & complex | L17 pole behavior at z = 0, -1, -2, … |
| `LogGamma` | `sp.loggamma(z)` | real & complex | L15: real x < 0 routed through `+0j` |
| `Digamma` | `sp.digamma(z)` | real & complex | — |
| `Trigamma` | `sp.polygamma(1, z)` | real only | L14: complex refused |
| `Polygamma` | `sp.polygamma(m, z)` | real only | L14: complex refused |
| `Pochhammer` | `sp.poch(a, n)` | real | — |
| `IncompleteGammaUpper` | `sp.gammaincc(a, z) · sp.gamma(a)` | real | L12: Q · Γ(a) = Γ(a, z) unregularised |
| `IncompleteGammaLower` | `sp.gammainc(a, z) · sp.gamma(a)` | real | L12: P · Γ(a) = γ(a, z) unregularised |
| `IncompleteGammaP` | `sp.gammainc(a, z)` | real | L12: SciPy spells P (not Q) |
| `IncompleteGammaQ` | `sp.gammaincc(a, z)` | real | L12: SciPy spells Q (not P) |
| `InverseIncompleteGammaP` | `sp.gammaincinv(a, p)` | real | L13: inverts P; Wolfram inverts Q only |
| `InverseIncompleteGammaQ` | `sp.gammainccinv(a, q)` | real | L13: inverts Q |
| `Beta` | `sp.beta(a, b)` | real | — |
| `LogBeta` | `sp.betaln(a, b)` | real | magnitude only (`log|B|`) |
| `GammaRatio` | `sp.poch(b, a-b)` or `sp.gamma(a)/sp.gamma(b)` | real | stable composition when (a-b) integer |
| `GammaDeltaRatio` | `1 / sp.poch(a, b)` | real | reciprocal Pochhammer (overflow-safe) |
| `GammaPDerivative` | DLMF §8.8.2 closed form | real | `exp(-z)·z^(a-1)/Γ(a)` |
| `IncompleteBeta` | `sp.betainc(a, b, z)` | real | regularised form I_z |
| `BarnesG` | — | **unsupported** | SciPy has no `barnesg` / `barnes_g` |

## Landmines pinned (R5 §6 — every adapter must encode these)

### L12 — The #1 gamma trap: incomplete-gamma regularisation convention

SciPy's spelling is **opposite** to Wolfram and mpmath:

```text
SciPy:   gammainc(a, z)   = P(a, z)  ← LOWER regularised
         gammaincc(a, z)  = Q(a, z)  ← UPPER regularised

Wolfram: Gamma[a, z]              = Γ(a, z)  upper UNregularised
         GammaRegularized[a, z]   = Q(a, z)

mpmath:  gammainc(a, z, False)    = Γ(a, z)  upper UNregularised
         gammainc(a, z, True)     = Q(a, z)
```

SciPy has NO raw unregularised primitive. The adapter recovers them by multiplying back by Γ(a):
- `IncompleteGammaUpper(a, z) = gammaincc(a, z) · gamma(a)` — Q · Γ(a)
- `IncompleteGammaLower(a, z) = gammainc(a, z) · gamma(a)` — P · Γ(a)

Accuracy is bounded by float64 precision of Γ(a) (≤ 2 ULP per R3 §3.1 Cephes); for the corpus's a ∈ (0, 20], the round-trip is honest to ≤ 3 ULP. **Every call site in `oracle.py` touching `gammainc` / `gammaincc` / `gammaincinv` / `gammainccinv` carries an explicit `# L12` comment.**

### L13 — Inverse incomplete-gamma convention

Wolfram's `InverseGammaRegularized[a, q]` inverts **Q only**. SciPy splits the inverse into two distinct functions:
- `gammaincinv(a, p)` — inverts P (lower regularised)
- `gammainccinv(a, q)` — inverts Q (upper regularised)

The corpus has TWO distinct heads (`InverseIncompleteGammaP`, `InverseIncompleteGammaQ`) so the comparator never has to disambiguate. All call sites in `oracle.py` are tagged `# L13` for clarity.

### L14 — SciPy complex polygamma raises TypeError

```python
sp.polygamma(m, complex) raises:
  TypeError: ufunc '_zeta' not supported for the input types
```

Confirmed in SciPy 1.11.4 AND 1.17.0. Trigamma (which routes through `polygamma(1, z)`) inherits the refusal. The adapter emits `status: "refused"` with `refuse_token: "TypeError-complex-polygamma"`. The comparator graduates these cells to gold-only (Wolfram + mpmath). **8 complex Trigamma cells + 16 complex Polygamma/IncompleteGamma cells = 24 refused records.**

### L15 — SciPy loggamma(real_negative) returns NaN

```python
sp.loggamma(-0.5)      → nan          # real input → no analytic continuation
sp.loggamma(-0.5+0j)   → (1.265 - πi) # complex input → branch-cut handled
```

The adapter routes real `x < 0` (not a non-positive integer) through `sp.loggamma(complex(x, 0.0))`. The result carries a non-zero imaginary part; we emit it as a complex value `{re, im}`. Every such call carries an explicit `# L15` comment.

### L17 — Gamma at non-positive integer poles (four oracles, four behaviors)

```text
Wolfram: ComplexInfinity
mpmath:  ValueError("gamma function pole")
SciPy:   gamma(0.0) = +inf;  gamma(-1.0) = nan
libm:    same as SciPy
```

This adapter emits SciPy's raw return (`+inf` or `nan`) at `status: "success"`. The comparator special-cases pole inputs and grades them against a "pole" tag rather than a numeric value. We do **not** raise on poles — they are the honest float64 answer. **42 pole-related records emit with L17 landmine pin.**

## Status distribution (from results.json)

```
Total records:  377
├─ success:     342 (90.72%)
├─ refused:      24 (6.37%)
└─ unsupported:  11 (2.92%)
  
No errors.
```

Refuse tokens:
- `TypeError-complex-polygamma`: 8 (complex Trigamma)
- `TypeError-complex-gammainc`: 16 (complex IncompleteGamma{Upper,Lower,P,Q})

Landmine tally (per-record pins):
- L17 (poles): 42
- L12 (regularisation convention): 104
- L13 (inverse convention): 12
- L15 (loggamma real-negative): 13
- L14 (complex polygamma): 8
- L14-cousin (complex gammainc/gammaincc): 16

## Re-run

From the workbench root:

```sh
bun bench/gamma-anchor/oracles/scipy/adapter.ts
```

Expected wall-time: **≤ 5 s** on a typical Linux x86_64 desktop (Python boot ~250 ms; SciPy warm-batch throughput at float64 is ~10⁴ evaluations/second for the gamma family on this corpus).

A confirmed reference run on this machine:
**1.04 s wall-time**, 377 inputs, 90.72% success + 6.37% refused + 2.92% unsupported.

## Files

- **`adapter.ts`** — Bun-side orchestrator. Reads `corpus.json`, spawns `python3 oracle.py`, parses the JSON result blob, merges with corpus metadata + wall-time, writes `results.json`. Uses `Bun.spawn` (NOT `node:child_process`).
- **`oracle.py`** — pure-Python SciPy driver (~820 LOC). Reads the corpus envelope on stdin; emits a JSON list on stdout (element 0 is a `__meta__` sentinel; subsequent elements are per-row results). Per-head dispatch with L12/L13/L14/L15/L17 mitigation logic embedded. **Independently smoke-testable**:

  ```sh
  python3 -c 'import json; print(json.dumps({"inputs":[{"id":"x","tier":"T1","head":"Gamma","z":"0.5"}]}))' \
    | python3 bench/gamma-anchor/oracles/scipy/oracle.py | head -3
  ```

- **`results.json`** — the output manifest. Schema documented in `adapter.ts` top-of-file narrative.

## Output schema

Top-level:

```jsonc
{
  "oracle_id": "scipy",
  "oracle_version": "SciPy 1.17.0 / Python 3.12.3 / NumPy 1.26.4",
  "scipy_version": "1.17.0",
  "numpy_version": "1.26.4",
  "python_version": "3.12.3",
  "generated_at": "2026-05-19T08:14:49.164Z",
  "bead": "scientist-workbench-tqwc",
  "corpus_bead": "scientist-workbench-0kq3",
  "corpus_manifest_version": 1,
  "corpus_generated_at": "2026-05-19T00:00:00Z",
  "corpus_seed": 20260519,
  "tier": "bronze",
  "precision_emit": "float64 (f\"{x:.17g}\"; 17-sig-digit round-trip)",
  "platform": { "arch": "x64", "os": "linux", "runtime": "bun-1.3.13" },
  "totals": { "records": 377, "success": 342, "refused": 24, "unsupported": 11, ... },
  "results": [ ... ]
}
```

Per-record:

```jsonc
{
  "id": "T1-gamma-001",                    // copied from corpus input
  "head": "Gamma",                         // copied
  "tier": "T1",                            // copied
  "status": "success" | "refused" | "unsupported" | "error",
  "value": "1" | "Infinity" | "NaN" | {"re":"...","im":"..."},
  "method": "scipy.special.gamma" | "...",
  "landmines": ["L12", "L17"],             // adapter-side pins
  "refuse_token": "TypeError-complex-polygamma" | undefined,  // only when status="refused"
  "elapsed_ms": 0.058868,
  "notes": null | "<explanation>"
}
```

Complex values render as `{"re": "...", "im": "..."}`. Float64 values use `f"{x:.17g}"` (17 significant digits, IEEE-754 round-trip guarantee). Non-finite values emit as `"NaN"`, `"Infinity"`, `"-Infinity"`.

## Determinism contract

Per ADR-0015, this oracle's outputs are tagged `numerical: true`: bit-identical on a given platform fingerprint (`{arch, os, runtime}`) but cross-platform divergence is possible. The platform fingerprint is recorded in `results.json::platform`; the G8 cross-agreement comparator's `runMemoized` cache-hit check must compare on platform match.

**Re-run byte-identity verified:** running the adapter twice in succession produces a `results` array where all 377 records are byte-identical except for the cosmetic `elapsed_ms` field (per-run wall-time, not load-bearing). All `status` / `value` / `method` / `landmines` / `refuse_token` / `notes` fields are byte-identical between runs (given identical corpus, SciPy/NumPy/Python versions, and platform).

## Spot-checks (reference values)

```text
Γ(1/2)       = 1.77245385090551602729816748334114518279754945612238712821381  (60 dp)
             ≈ √π (R5 §8.2, DLMF §5.4.1)
ψ(1)         = -0.577215664901532860606512090082402431042159335939923598805767 (60 dp)
             = -γ (Euler-Mascheroni constant, DLMF §5.4.12)
P(3/2, 5/2)  = 0.828202855703266864936393347816948500210901763194030637750441  (60 dp)
             = γ(3/2, 5/2) / Γ(3/2) (R5 §3.2 line 353)
Γ(3/2, 5/2)  = 0.152251254991657627635403712624832257862424837713894019933188  (60 dp)
             = upper unregularised (R5 §3.2 line 350)
(3/2)_3      = 13.125 (Pochhammer, R5 §3.2 line 347)
B(1/2, 1/2)  = π (DLMF §5.12.1)
```

These serve as sanity-check anchors when comparing SciPy's float64 evaluations against gold (Wolfram, mpmath). SciPy will match ≤ 3 ULP per the bronze-tier acceptance criterion (ADR-0042 §"Decision 8").

## Platform & install state

**No installation required.** SciPy 1.17.0 + NumPy 1.26.4 + Python 3.12.3 are available system-wide on this host per R5 §3.5 (install path: `/usr/lib/python3.12/dist-packages/scipy/special/`).

Probed: 2026-05-19.

```sh
python3 -c "import scipy, numpy, sys; print('scipy', scipy.__version__); print('numpy', numpy.__version__); print('python', sys.version)"
# scipy 1.17.0
# numpy 1.26.4
# python 3.12.3
```

On a fresh machine: `pip install --user scipy numpy` (or system package manager).
