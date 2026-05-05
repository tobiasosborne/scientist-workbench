# ADR-0016 — Warning-based scaling for the numerical tier (no hard caps)

**Status:** Accepted (2026-05-05)
**Supersedes (in part):** ADR-0014 §"Cap on n" — the cap rationale is
withdrawn; everything else in ADR-0014 stands.
**Bead:** `scientist-workbench-32s`

## Context

ADR-0014 set the numerical-tier `n ≤ 200` cap (`linalg-solve`, then
inherited by `linalg-qr`, `linalg-svd`). The rationale at the time:

1. Wire-encoding cost grows as `O(m·n)` and a 200×200 matrix is already
   ~640 KB on the wire (16 hex chars + JSON overhead per entry).
2. Pure-TS dense linear algebra at much larger sizes was speculative.
3. A loud `ToolError` at the cap was preferable to a tool that silently
   produced a slow or wrong answer.

The forcing function for revisiting: the **phone deployment** use case
(Bun-in-browser-on-mobile) where Python / SciPy / numpy are not
available, and the agent has *no fallback* to delegate large problems
to. In that environment, refusing `n = 300` because the spec says 200
is worse than running it slowly and warning the agent that it'll be slow.

The `singular_values_match` design mistake from worklog 043 is a
parallel: an extra-strict check that ruled out honest implementations
without adding signal. The cap is the same shape — strictness as a
proxy for safety, paid for in foreclosure.

## Decision

**Remove the `m·n ≤ 200·200` hard cap from all numerical-tier tools.**
Replace with **measurement-driven warnings** in the agent-honest output:

```
{ ...,
  warnings: [
    "matrix size n=600 above the 500-cell well-tested threshold; "
    "expected wall-clock ~3s in pure TS (Householder); "
    "consider FFI bridge (bead e7y) for n > 1000",
    ...
  ]
}
```

The agent reads `warnings` and decides what to do. The tool no longer
makes the decision *for* the agent.

**OOM remains the only refusal class.** Trying to allocate a Float64Array
larger than the host process can support throws a `RangeError`; the tool
catches it and surfaces a `ToolError` with the attempted byte count and
a remediation suggestion. This is *physics*, not policy.

The `tagged "linalg-X/non-finite-input"` and `tagged "linalg-X/degenerate-shape"`
boundaries (from ADR-0003) are unchanged.

## Threshold table (measured 2026-05-05)

Profiled on `linux x64, Bun 1.3.0` against random well-conditioned
matrices. RSS delta is post-call growth; peak RSS includes baseline
JS heap. Phone CPUs run ~3× slower than this dev box (rule of thumb
for ARM cores vs x86 desktop).

| Tool | n | wall-clock | RSS delta | peak RSS | warning emitted |
|---|---|---|---|---|---|
| linalg-qr  | 100  | 0.05 s | 2 MB   | 62 MB  | none |
| linalg-qr  | 200  | 0.18 s | 3 MB   | 65 MB  | none |
| linalg-qr  | 500  | 2.6 s  | 6 MB   | 71 MB  | "moderate" |
| linalg-qr  | 1000 | 25 s   | 31 MB  | 102 MB | "slow" |
| linalg-qr  | 2000 | 535 s  | 92 MB  | 194 MB | "very slow; consider FFI" |
| linalg-svd | 100  | 0.17 s | 8 MB   | 202 MB | none |
| linalg-svd | 200  | 0.58 s | <1 MB  | 202 MB | none |
| linalg-svd | 500  | 17.6 s | 4 MB   | 206 MB | "slow" |
| linalg-svd | 1000 | 210 s  | 35 MB  | 241 MB | "very slow; switch algorithm" |
| linalg-svd | 2000 | (skip) | (skip) | (skip) | extrapolated 2-3 h with Jacobi |

(Pure Jacobi for SVD scales as `O(n³ log² n)`; the Golub-Reinsch port
on the roadmap will move the threshold up by ~1.5 orders of magnitude.)

## Warning strings (canonical)

The exact strings emitted, keyed off `n` (or `min(m, n)` for rectangular):

| Threshold | Emitted string |
|---|---|
| `n > 500` | `"matrix size n=<N> above the 500-cell well-tested threshold; <T>s wall-clock typical (3× slower on phone CPUs)"` |
| `n > 1000` | `"matrix size n=<N> above the 1000-cell stress-tested threshold; expect tens of seconds; consider FFI bridge to OpenBLAS (bead scientist-workbench-e7y) for production use"` |
| `n > 2000` | `"matrix size n=<N> in regime where pure-TS dense linear algebra becomes impractical; FFI strongly recommended"` |
| `peak_rss_mb > 100` (estimated) | `"estimated peak memory <X> MB; large fraction of typical mobile-browser tab budget (~1-2 GB)"` |
| `peak_rss_mb > 500` (estimated) | `"estimated peak memory <X> MB; OOM risk on mobile platforms"` |

Strings are concatenated with `; ` if multiple thresholds fire.

## Memory estimation (front-of-envelope)

For an `m × n` dense `float64` matrix:

- **Wire (canonical)**: `~80 · m · n` bytes (16-hex-char float64 + JSON
  framing per entry).
- **In-memory working set**: `~5 · 8 · m · n = 40 · m · n` bytes (one
  copy for input, one for working, one each for Q, R, plus scratch).

A 1000×1000 matrix:
- wire: 80 MB
- working: 40 MB
- total touched: ~120 MB

A 2000×2000 matrix:
- wire: 320 MB
- working: 160 MB
- total: ~480 MB

A typical mobile-browser tab gets 1-2 GB. The wire cost dominates and
is what limits practical n on phones — not the algorithm.

## Why warnings, not tiers

Considered alternative: declare separate tools `linalg-qr-small`
(n ≤ 200, fast path), `linalg-qr-large` (n > 200, FFI required),
forcing the agent to choose a tier explicitly. Rejected because:

1. **Two principles**: a TS expert types `qr(A)` and expects it to
   work. Forcing them to introspect the size and pick a tool is
   exactly the API friction the workbench tries to avoid.
2. **Honest scope** (Rule 8): one tool that runs and warns is more
   honest than two that draw a synthetic line at `n = 200`.
3. **The FFI tool doesn't exist yet.** Bead `e7y` is a long-horizon
   item; until it lands, refusing `n > 200` outright leaves the
   agent with *nothing*. Warning-and-running gives a usable result.

Considered alternative: dynamic cap based on `process.memoryUsage()`
at entry. Rejected because phone JS engines under-report available
memory and the prediction would be unreliable. Better: estimate from
`m, n` (predictable), warn loudly, let physics enforce the real cap.

## Consequences

### Code changes

- Remove `MAX_N` constant and the cap-rejection `ToolError` branch
  from `tools/linalg-solve/tool.ts`, `tools/linalg-qr/tool.ts`,
  `tools/linalg-svd/tool.ts`.
- Add a shared `assessNumericalScale(m, n)` helper in
  `packages/linalg-core/src/scale.ts` that returns the warning-string
  list for the given dimensions, applied at the tool wire layer.
- Wrap the substrate-call with `try/catch` for `RangeError`; surface
  as `ToolError` with the attempted-bytes detail.
- Update each tool's `invariants` block: remove "n > MAX_N raises
  ToolError" and replace with "n above warning thresholds emits
  warning strings; OOM emits ToolError".
- Add bench cases at n = 500, 1000 to both `bench/linalg-qr` and
  `bench/linalg-svd` (the new "stress" regime).
- README catalog rows: remove "n ≤ 200" mention; add "scales to
  ~1000 in pure TS, ~2000 with patience".
- Bead `wmm` (blob-by-hash convention): re-scoped — no longer the
  forcing function for n > 200; remains useful if/when *goldens*
  grow past inline-JSON.

### Provenance / cache implications

`numerical: true` (ADR-0015) is unchanged. Provenance records still
carry `platform`, `runMemoized` still discriminates on platform.
Larger goldens take more disk per provenance record; if this becomes
painful, bead `wmm` revives.

### What this does NOT change

- ADR-0014's agent-honest output discipline, Float64Array substrate,
  numerical-tier package layout. All still in force.
- ADR-0015's determinism-tier annotations. All still in force.
- ADR-0003's three output categories. The tagged-boundary classes
  (`non-finite-input`, `degenerate-shape`) are unchanged.

## Pointers

- ADR-0014 — first numerical tier, the cap this ADR lifts.
- ADR-0015 — determinism tier, platform fingerprint.
- ADR-0003 — output categories.
- Worklog 045 (in progress) — implementation notes.
- `scripts/bench-numerical-tier.ts` — measurement harness, source of
  the threshold table above.
- Bead `scientist-workbench-32s` — tracking bead.
- Bead `scientist-workbench-e7y` — FFI BLAS bridge (long-horizon
  follow-up; warning strings reference this).
