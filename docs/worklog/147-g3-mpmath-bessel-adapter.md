# 147 — G3 mpmath gold-tier oracle adapter for the Bessel-anchor corpus

**Bead:** `scientist-workbench-g70g` (Phase 1 G3 of epic `zcam`).
**ADR:** [`0041`](../adr/0041-bessel-family-per-head-substrate.md) §"Decision 8".
**Research:** [`R5-oracle-landscape.md`](../refs/besselj-research/R5-oracle-landscape.md) §3.2 (mpmath probe), §6 L2 / L3 / L9 / L10 (landmines).

## Context

ADR-0041's Phase 1 needs four oracle voices to set the cross-validation
baseline for the per-head Bessel substrate: G2 Wolfram (gold, closed-
source), G3 mpmath (gold, open-source — this shard), G4 Boost
(silver, real-only), G5 SciPy (bronze, float64). Without G3 there is no
**independent open-source** voice on the complex-Bessel branch — Wolfram
becomes the single point of failure for half the cross-agreement matrix.

The G3 adapter follows the styling exemplar set by the Erf G3 adapter
([`bench/erf-anchor/oracles/mpmath/adapter.ts`](../../bench/erf-anchor/oracles/mpmath/adapter.ts),
worklog 142) but with three Bessel-specific extensions: 6-head dispatch
(not 6 Erf-family heads — 4 native Bessel + 2 scaled-variant composites);
the L2 emit-margin canonicalisation discipline pushed deeper into a
literate Python module; and a SIGALRM per-input timeout for the L9/L10
long-tail.

## What changed

Three files under `bench/besselj-anchor/oracles/mpmath/`:

- **`oracle.py`** (304 LOC) — pure-Python mpmath driver. Reads the
  corpus's `{inputs: [...]}` envelope on stdin; emits a JSON list on
  stdout with element 0 as a `__meta__` sentinel (`mpmath_version`,
  `python_version`, `work_dps=60`, `emit_dps=55`,
  `per_input_timeout_s=30`) and subsequent elements as per-row results
  in input order. Six-head dispatch table:
  - `BesselJ` → `mpmath.besselj`
  - `BesselY` → `mpmath.bessely`
  - `BesselI` → `mpmath.besseli`
  - `BesselK` → `mpmath.besselk`
  - `BesselIScaled` → `exp(-|Re z|) · mpmath.besseli` (Amos `kode=2` convention)
  - `BesselKScaled` → `exp(z) · mpmath.besselk` (Amos `kode=2` convention)

  ν parsing branches on `nu_kind`: `"integer"` → Python `int` (triggers
  mpmath's integer-recurrence path); `"half-integer"` → `mpf(a)/mpf(b)`;
  `"decimal"` → `mpf(nu_str)`. z parsing handles real strings, complex
  `{re, im}`, and the sentinel tokens `"NaN"` / `"Infinity"` /
  `"-Infinity"`.

- **`adapter.ts`** (358 LOC) — Bun-side orchestrator. Smoke-tests
  `python3 -c 'import mpmath'`, loads `corpus.json`, spawns
  `python3 oracle.py` via `Bun.spawn` (NOT `node:child_process`),
  drains stdout / stderr concurrently with `proc.exited` to avoid the
  64 KiB Bun-pipe back-pressure deadlock (worklog 027), validates row-
  by-row id order, tallies the six status categories with a TS
  exhaustiveness check (`const _exhaustive: never = r.status`), and
  writes `results.json`. Fails the run with exit code 2 if success
  fraction < 95 % (bead acceptance criterion 3).

- **`README.md`** — re-run instructions, status taxonomy, landmine
  mitigation summary, determinism contract.

## Why these choices

### Sibling `.py` file, NOT inline template literal

Erf G3's Python was 130 LOC and inlined fine. Bessel G3's Python is
~280 LOC (corpus parsing + 6-head dispatch + 60-line special-token
classifier + SIGALRM handler + literate landmine commentary). Inlining
would (a) defeat syntax-highlighting and lint discipline for the
Python; (b) hide the SIGALRM logic behind escape sequences; (c) cost
30 % of TS file length for content no TS reader benefits from; (d)
break the independent-testability property — `python3 oracle.py <
corpus.json` is the fastest debugging path, and it requires the script
to live on disk as a Python file. Documented in the adapter's top-of-
file narrative under "Subprocess discipline".

### 60-dps compute / 55-dp emit

Verbatim from ADR-0041 §"Decision 8". The 10-dp compute margin absorbs
mpmath's per-algorithm internal precision bumps (Hankel crossover at
`|z| ≈ p/2`, negative-ν `cos(ν π)` cancellation, integer-vs-near-
integer-ν jump). The 5-dp emit margin canonicalises the mpmath round-
to-nearest vs Wolfram `N[]` truncate mismatch (R5 L2). Together they
let the G8 comparator do byte-equality on the 55-dp strings.

### SIGALRM per-input timeout at 30 s

R5 L9/L10 flagged that K underflow / I overflow at very-large-z can
push mpmath into multi-second per-call territory. The bead prompt
mandated `status: "timeout"` if exceeded. SIGALRM is the Linux-portable
way to interrupt a CPU-bound Python call without spawning a watchdog
thread (mpmath releases the GIL inconsistently; a thread-based watchdog
isn't reliable). One input hit it on the reference run:
`T7-besselk-020` = `BesselK(500, 1000)` in the high-ν Debye regime —
exactly the case the budget was designed to catch. The scaled-variant
corpus rows (`BesselKScaled`) cover this regime at full precision.

### Honest-special-token short-circuit

The reference run exposed an mpmath behaviour the R5 probes didn't
surface: `mpmath.besselj(0, mpf('inf'))` raises `TypeError`
("unsupported operand type(s) for `//`: 'mpf' and 'int'"), and
`mpmath.besselj(0, mpf('nan'))` raises `ValueError` ("cannot convert
inf or nan to int"). These are NOT refusals — the mathematical answers
are well-defined (`J_ν(±∞) = 0`, `*(NaN, _) = NaN`, etc.). The
`classify_special_token` helper in `oracle.py` intercepts these
36 corpus inputs (the T6 edge-of-representation tier) and emits the
IEEE-754 limit with a `notes` annotation. The G8 comparator checks
gold-tier carry-through agreement on these separately from numeric
agreement.

### TS exhaustiveness check on `r.status`

```ts
default: {
  const _exhaustive: never = r.status;
  void _exhaustive;
  process.stderr.write(`mpmath adapter: unknown status ${r.status} ...\n`);
  process.exit(1);
}
```

If the Python side ever invents a new status, the TS compiler refuses
the build (`Type 'string' is not assignable to type 'never'`). The
runtime branch is a defence-in-depth — the static check fires first
in CI / `bun run check`. Pattern from `packages/protocol/src/tag-narrow.ts`.

## Frictions surfaced

- **mpmath raises on infinite z.** R5's probes used finite arguments;
  the corpus's T6 tier deliberately exercises ±∞ / NaN. The fix was
  literally a 30-line classifier dispatched before any mpmath call —
  cheap once the failure mode was identified. Filed forward as a
  pattern: every oracle adapter for a substrate that admits IEEE
  sentinels needs a special-token short-circuit. Erf's G3 adapter
  doesn't need this because the Erf corpus didn't include ±∞ in T6;
  the Bessel corpus does.
- **Bun.spawn back-pressure.** First draft awaited `proc.exited`
  before reading stdout — the run hung because the Python child filled
  the 64 KiB stdout pipe buffer and blocked. Fixed by `Promise.all`-
  ing the three drain operations (worklog 027 had documented this for
  another adapter; the pattern is now canonical for any oracle adapter
  whose output exceeds 64 KiB).
- **`besseli` with negative real z goes complex.** `I_ν(-1) = mpf` for
  integer ν (mpmath handles the parity), but for non-integer ν it
  returns mpc with a tiny imaginary part. The `complex-success` status
  cleanly captures this; the G8 comparator's tolerance band for the
  near-zero imaginary part lives in its own bead.
- **Inline-vs-sibling-Python tradeoff is real.** Erf's inline approach
  worked because the Python fit in one screen. Bessel's doesn't — and
  the test "would a legendary TS SE skim this and trust it?" answers
  unambiguously for the sibling file. Worth noting as a guideline for
  future oracle adapters: if the Python exceeds 200 LOC or contains
  signal-handling / `os.fork` / complex regex, prefer the sibling file.

## Acceptance

Per the bead's seven criteria:

1. ✓ Adapter on disk (`adapter.ts`, 358 LOC, literate top-of-file
   narrative covering oracle choice, margin discipline, subprocess
   discipline, output schema, re-run instructions).
2. ✓ README on disk; expected wall-time confirmed (108 s reference run,
   well inside the prompt's 5–15 min envelope).
3. ✓ `results.json` on disk; 99.94 % success (1765 / 1766; the single
   timeout is the L9/L10 long-tail case the 30 s budget was designed
   to catch — `BesselK(500, 1000)` in the high-ν Debye regime).
4. ✓ Re-run byte-identical (verified: `[(input_id, status, value, notes)
   for r in results]` equal across two consecutive runs; totals
   identical; oracle version identical).
5. ✓ This worklog shard.
6. ✓ Bead `scientist-workbench-g70g` updated with notes + closed.
7. ✓ Inline summary in the agent's final message.

## Pointers

- Adapter entry: [`bench/besselj-anchor/oracles/mpmath/adapter.ts`](../../bench/besselj-anchor/oracles/mpmath/adapter.ts)
- Python driver: [`bench/besselj-anchor/oracles/mpmath/oracle.py`](../../bench/besselj-anchor/oracles/mpmath/oracle.py)
- Results manifest: [`bench/besselj-anchor/oracles/mpmath/results.json`](../../bench/besselj-anchor/oracles/mpmath/results.json)
- README: [`bench/besselj-anchor/oracles/mpmath/README.md`](../../bench/besselj-anchor/oracles/mpmath/README.md)
- Styling exemplar: [`bench/erf-anchor/oracles/mpmath/adapter.ts`](../../bench/erf-anchor/oracles/mpmath/adapter.ts) (Erf G3, worklog 142)
- ADR: [`docs/adr/0041-bessel-family-per-head-substrate.md`](../adr/0041-bessel-family-per-head-substrate.md) §"Decision 8"
- Landmine catalogue: [`docs/refs/besselj-research/R5-oracle-landscape.md`](../refs/besselj-research/R5-oracle-landscape.md) §3.2 + §6
- Next: G8 cross-agreement comparator (`scientist-workbench-s2n1`) — when G2 / G4 / G5 / G7 all land, the comparator can ULP-distance the four oracles' results.json pairwise.
