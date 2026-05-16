# Wolfram Mathematica gold-tier oracle for the Erf-anchor corpus

This directory holds the Wolfram-side adapter and its generated golden-master
file for the world-class Erf reference-implementation effort (ADR-0040,
bead `scientist-workbench-ufgd`).

## Provenance

| Field | Value |
| --- | --- |
| Probed against (CLI) | `WolframScript 1.13.0 for Linux x86 (64-bit)` |
| Probed against (kernel) | `14.3.0 for Linux x86 (64-bit) (July 8, 2025)` |
| Oracle tier | Gold (see R5 §3 oracle tier proposal) |
| Method | `wolfram-N-at-60-decimal` |
| Achieved precision | 60 decimal digits per value (working precision; first 50 are gold-trustworthy) |
| Inputs evaluated | 271 / 271 (no skips, no refusals) |
| Wall-clock total | ~10 s (single batch invocation) |

## How to re-run

```sh
bun bench/erf-anchor/oracles/wolfram/adapter.ts
```

This consumes the frozen corpus at `bench/erf-anchor/corpus.json`, spawns
`wolframscript -file <tempfile>` exactly once (Wolfram cold-start is ~3 s; a
per-input invocation would take ~14 minutes — batch mode is mandatory per
R5 §"Adapter shape"), and overwrites `results.json` in place.

Override binary location:

```sh
WOLFRAMSCRIPT_BIN=/path/to/wolframscript bun bench/erf-anchor/oracles/wolfram/adapter.ts
```

## Landmines pinned in adapter code (read before editing)

1. **Wolfram input-trap (R5 §3.1, ADR-0040 §"Decision 8 §3 landmine 1").**
   `N[Erf[1.23], 50]` silently returns only ~16 digits because `1.23` parses
   as `MachinePrecision` (a float64). Every decimal value from the corpus is
   parsed to an exact `BigInt`-rational `(num, den)` and emitted to Wolfram
   as `Rational[num, den]`. The spot-checks `erf(1/2)` and `erf(123/100)`
   confirm the trap is defused: both reproduce the canonical R5 50-digit
   reference exactly through 50 digits.

2. **Erfcx is not Wolfram's `Erfcx[z]`.** Wolfram 14.3's `N[Erfcx[z], 60]` is
   *partial* — it returns unevaluated symbolic form for complex arguments and
   for many real arguments at arbitrary precision. The adapter computes
   `erfcx(z) = Erfc[z] · Exp[z^2]` at 60 working digits. For the corpus's
   `|z| ≤ 30` range this composition is numerically benign (the
   exponentially-small `erfc` and exponentially-large `exp(z^2)` factors
   cancel at 60 working digits to leave ≥50 trustworthy output digits). At
   the `Number.MAX_VALUE` edge the composition becomes `0 * Infinity` and
   the adapter records `Indeterminate` — an honest refusal at that
   particular input via this oracle.

3. **`Underflow[]` / `Overflow[]` post-processing.** For inputs whose
   magnitude pushes Wolfram past `$MaxExtraPrecision = 50` (the
   `Number.MAX_VALUE` T6 edge cases), Wolfram returns a wrapper symbol like
   `1 - Underflow[]` instead of an evaluated limit. The adapter's batch
   script replaces `Underflow[] -> 0` and `Overflow[] -> Infinity` and
   re-evaluates, collapsing the result to the structural limit. For
   `Erf[MAX_VALUE]` this yields the exact integer `1`; for `Erfc[MAX_VALUE]`,
   `0`; for `Erfi[MAX_VALUE]`, `Infinity`.

4. **Wolfram `Print` line-wrapping.** Wolfram's default `$PageWidth` chops
   60-decimal numbers across multiple lines, breaking the consumer's
   line-oriented parser. The batch script sets `$PageWidth = Infinity`.

5. **Precision-suffix on InputForm strings.** Wolfram's `InputForm` of an
   arb-prec real number is e.g. `` 0.918050…`60. `` with a backtick-prefixed
   precision annotation. The adapter strips everything from the first
   backtick onward and trims a trailing `.` before emitting the JSON
   record's `output` field.

## Output shape

`results.json` envelope:

```jsonc
{
  "manifest_version": 1,
  "generated_at": "<ISO 8601>",
  "bead": "scientist-workbench-ufgd",
  "adr": "0040",
  "oracle_id": "wolfram",
  "oracle_tier": "gold",
  "oracle_version": "<wolframscript -version>",
  "oracle_kernel_version": "<$Version inside kernel>",
  "method": "wolfram-N-at-60-decimal",
  "achieved_precision": 60,
  "total_inputs": 271,
  "total_elapsed_ms": <number>,
  "notes": [...],
  "results": [<one record per corpus input>]
}
```

Per-record shape (matches the prompt's spec):

```jsonc
{
  "input_id": "T1-erf-001",
  "head": "Erf",
  "z": "0.0000…0" | { "re": "…", "im": "…" },     // echoed from corpus
  "output": "<decimal string ≥50 digits>"
           | "0" | "1" | "-1" | "2"                // exact integer limit
           | "Indeterminate"                       // NaN-input or Erfcx@huge
           | "Infinity" | "-Infinity"              // limit values for huge inputs
           | { "re": "…", "im": "…" },             // complex outputs
  "method": "wolfram-N-at-60-decimal",
  "achieved_precision": 60,
  "oracle_id": "wolfram",
  "oracle_version": "...",
  "oracle_kernel_version": "...",
  "elapsed_ms": <amortised batch time / N>,
  "refusal"?: { "class": "wolfram/symbolic-unevaluated", "reason": "..." }
}
```

The `refusal` field appears only when Wolfram declined to numerically
evaluate `head[z]` (i.e. `N[...]` returned an unevaluated symbolic form, as
would happen for out-of-domain inputs like `InverseErf[2]`). The 271-input
v0.1 corpus exercises no such case — every record was evaluated to a value.

## Cross-validation status (informational)

Three-way real-branch consensus probe at `erf(123/100)`:

| Source | First 50 decimals |
| --- | --- |
| Wolfram@60 (this adapter) | `0.91805010412676136789273300392075214555771922462406` |
| Wolfram@80 (independent re-run) | `0.91805010412676136789273300392075214555771922462406` |
| mpmath@100 truncated to 50 | `0.91805010412676136789273300392075214555771922462406` |

All 50 digits agree. The corpus consumer's downstream comparators (G3 mpmath,
G6 Boost, G8 agreement matrix) extend this check across the entire 271-input
corpus.

## Notes the user should know

- **Re-running is idempotent.** The corpus is frozen; the adapter consumes
  it and produces a deterministic results.json modulo two non-determinism
  surfaces: (a) wall-clock timestamps (`generated_at`, `elapsed_ms`,
  `total_elapsed_ms`); (b) any kernel-version difference if Wolfram is
  upgraded under the user's feet. The numeric outputs themselves should be
  byte-identical across re-runs on the same kernel.
- **No installation needed.** `wolframscript` is already on `PATH`
  (`/usr/bin/wolframscript`); the kernel is activated. R5 §1 confirmed.
- **Adapter does not modify the corpus.** It is a pure consumer of
  `bench/erf-anchor/corpus.json`.
