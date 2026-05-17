# Wolfram Mathematica gold-tier oracle for the Bessel-anchor corpus

This directory holds the Wolfram-side adapter and its generated golden-master
file for the world-class Bessel (J, Y, I, K) reference-implementation effort
(ADR-0041, bead `scientist-workbench-z9fq`, part of epic `scientist-
workbench-zcam`).

## Provenance

| Field | Value |
| --- | --- |
| Probed against (CLI) | `WolframScript 1.13.0 for Linux x86 (64-bit)` |
| Probed against (kernel) | `14.3.0 for Linux x86 (64-bit) (July 8, 2025)` |
| Oracle tier | **Gold** (ADR-0041 §"Decision 8" — primary gold voice for all 4 heads × {real, complex} × all ν-classes) |
| Method | `wolfram-N-at-60-decimal` |
| Achieved precision | 60 decimal digits per value (working precision; first ~58 are gold-trustworthy per R5 §6 L11) |
| Inputs evaluated | 1766 / 1766 (corpus seed 20260517) |
| Wall-clock total | ~38-45 min (single batch invocation; cold-start ~7.6s + ~1.4s per evaluation) |

## How to run

```sh
bun bench/besselj-anchor/oracles/wolfram/adapter.ts
```

This consumes the frozen corpus at `bench/besselj-anchor/corpus.json`, spawns
`wolframscript -file <tempfile>` exactly once (Wolfram cold-start is ~7.6 s;
a per-input invocation of 1766 inputs would take ~3.7 hours — batch mode is
mandatory per R5 §3.1), and overwrites `results.json` in place.

Override binary location:

```sh
WOLFRAMSCRIPT_BIN=/path/to/wolframscript bun bench/besselj-anchor/oracles/wolfram/adapter.ts
```

Expected wall-time scaling (measured against the v0.1 corpus on a probe host):

| Inputs in corpus | Cold-start | Per-input | Total wall-time |
| --- | --- | --- | --- |
| 9 (smoke) | 7.6 s | 1.5 s | 21 s |
| 1766 (full) | 7.6 s | 1.4 s | ~41 min |

The full-corpus run is unavoidably long but ships in a single subprocess
without supervision, so it can be backgrounded.

## Capability matrix per corpus tier

Wolfram is the only oracle in the local landscape that returns every cell at
gold-tier precision. The capability matrix per R5 §3.1 (verified across
this corpus):

| Tier | Description | Inputs | Wolfram status |
| --- | --- | ---: | --- |
| T1 | small-z series `|z| ∈ (0, 8]` | 468 | full coverage |
| T2 | mid-z `|z| ∈ (8, 60]` | 364 | full coverage |
| T3 | large-z asymptotic `|z| ∈ (60, 300]` | 336 | full coverage |
| T4 | transition `|z| ≈ ν` (algorithmically hardest) | 96 | full coverage |
| T5 | complex Q1-Q4 `|z| ∈ [0.5, 30]` | 128 | full coverage |
| T6 | edges (±0, ±∞, NaN, subnormal, 700-boundary) | 96 | mixed: numeric values for finite edges; `status: "limit"` for `Infinity`/`-Infinity`/`NaN` inputs where Wolfram returns the unevaluated symbolic form (e.g. `BesselI[0, Infinity]`) |
| T7 | high-ν Debye `ν ∈ [50, 500]` | 80 | full coverage (Wolfram at 60dps handles the large-ν asymptotic without underflow) |
| T8 | negative-real-ν Y/K connection-formula branch | 30 | full coverage |
| T9 | Bessel zeros — zero-crossing tolerance band | 120 | full coverage (Wolfram correctly returns ~`1e-50` to `1e-17` near each tabulated root) |
| T10 | large-ν integer — overflow/underflow boundary | 48 | full coverage; scaled-variant heads (`BesselIScaled`, `BesselKScaled`) computed by composition |

Total: 1766 inputs across 6 heads × 3 ν-classes.

## Landmines pinned in adapter code (read before editing)

The discipline (per R5 §6): every landmine here is **pinned in adapter
code as a defensive check, an inline comment, or a wire-format rewrite**.
Removing a pinned mitigation without an updated landmine entry is a
regression.

### L1 — Wolfram input-trap (`Rational[]`, NOT machine doubles)

**The bug**: `N[BesselJ[3, 2.5], 60]` silently returns *only sixteen* digits
of precision, because `2.5` parses as a `MachinePrecision` double (float64)
and `N[…, 60]` propagates the input's machine precision through the call.
Same trap for ν: `N[BesselJ[0.5, Rational[3,2]], 60]` ≈ 16 digits because
`0.5` is a machine-double.

**The fix**: every numeric corpus value — both ν and z — is parsed to an
exact `BigInt` rational `(num, den)` and emitted to Wolfram as
`Rational[num, den]` (auto-reducing to `Integer` when `den == 1`). The
adapter's `decimalStringToWl` / `parseFractionToRational` / `nuToWlExpr`
helpers enforce this. Spot-checked against R5 §6 L1's reference
`BesselJ[3, Rational[5,2]]@50` and the smoke-test outputs `J_0(0.001)`,
`J_{1/2}(0.001)`, `I_{1.7}(0.001)` all match Wolfram's interactive output
through ≥58 digits.

### L_carryover — Wolfram `*^` exponent marker → standard `e<exp>`

**The bug**: Wolfram's `InputForm` of an arb-prec real with an exponent
prints `<mantissa>BT<prec>.*^<exp>` (e.g. `` 6.5632…`60.*^-343 ``). A naive
"strip from the first backtick onward" shaver silently drops the `*^-343`
exponent, leaving a mantissa-only string. This was the load-bearing G2a
bug from the Erf epic (worklog 138, bead `scientist-workbench-nwdj`).

**The fix**: the `.wls` preamble's `FormatNumeric` Wolfram function rewrites
`` `<prec>.*^ `` → `e` *before* stripping the trailing `` `<prec>. ``. The
wire format is therefore standard-scientific (`<mantissa>e<exp>`) or
plain-decimal (`<mantissa>`), ready for any cross-language numeric parser.
The TS-side `stripPrecisionSuffix` is retained as belt-and-suspenders.

### L11 — Wolfram trailing-noise digits past declared precision

**The bug**: at 60-dp declared precision Wolfram emits ~62-64 digits, the
last 2-4 of which are noise (rounding artefacts past the declared
precision). Treating them as meaningful generates spurious agreement
failures.

**The mitigation**: this adapter emits all digits Wolfram produces; the
tier-tolerance band is the G8 cross-agreement comparator's responsibility,
not this adapter's. The README documents the noise floor so downstream
consumers know to compare at `precision - 2` digits when matching
Wolfram-against-Wolfram (or against another gold-tier voice at the same
declared precision).

### L9 / L10 — `Underflow[]` / `Overflow[]` post-processing (belt-and-suspenders)

**The risk**: for inputs whose magnitude pushes Wolfram past
`$MaxExtraPrecision`, the kernel returns a wrapper symbol like
`1 - Underflow[]` instead of a limit value.

**The mitigation**: the `.wls` preamble's `PrintRecord` applies
`Underflow[] -> 0` and `Overflow[] -> Infinity` substitutions then re-runs
`N[…, 60]` before classification. At 60-dp working precision this rarely
triggers (Wolfram handles `K_0(700) ≈ 4.67e-306` and `I_0(700) ≈ 1.53e+302`
directly), but the mitigation remains as defence against any future corpus
that pushes further (`K_0(1e6)` etc.).

### L7 — Zero-crossing band (T9 corpus tier; comparator responsibility)

**The point**: the corpus's T9 tier (120 inputs near Bessel zeros) already
carries `z_root_index` and `z_root_distance` fields per ADR-0041 §"Decision
12". The adapter emits Wolfram's value verbatim (typically ~`1e-50` to
`1e-17` near each root); the G8 comparator switches to absolute-error
comparison within the band. **No adapter-side special-case for T9**.

### Limit cases — `BesselI[0, Infinity]` and friends (capability matrix)

**The behaviour**: Wolfram's `N[BesselI[0, Infinity], 60]` returns the
unevaluated symbolic form `BesselI[0, Infinity]` rather than `Infinity`,
even though `I_0(∞) = ∞` mathematically. Same for `K[0, -Infinity]`,
`I[ν, Indeterminate]`, etc.

**The mitigation**: the classifier's REFUSE bucket captures these as
`status: "limit"` (NOT `"refused"` — the function has a limit, Wolfram just
doesn't volunteer it numerically) and writes the raw symbolic form into
the `wolfram_returned_token` field. Downstream comparators (G8) treat a
limit record as "this oracle declines for an honest mathematical reason,
not a bug" and cross-check against the other gold voice (mpmath) where
possible.

## Output schema

`results.json` envelope (matches the orchestrator's prompt schema):

```jsonc
{
  "oracle_id": "wolfram",
  "oracle_version": "Mathematica 14.3.0 ... / wolframscript WolframScript 1.13.0 ...",
  "generated_at": "<ISO 8601>",
  "corpus_seed": 20260517,
  "tier": "gold",
  "precision_decimals_requested": 60,
  "bead": "scientist-workbench-z9fq",
  "adr": "0041",
  "total_inputs": 1766,
  "total_elapsed_ms": <number>,
  "notes": [...],
  "totals": { "success": N, "refused": N, "limit": N, "error": N },
  "results": [<one record per corpus input, in corpus order>]
}
```

Per-record shape (orchestrator schema):

```jsonc
{
  "input_id": "T1-besselj-001",
  "status": "success" | "limit" | "refused" | "error",
  "value":  "0.99999975...60dp"                       // real success
          | { "re": "...", "im": "..." }              // complex success
          | "0" | "1" | "2"                           // exact integer limit
          | null,                                     // limit / refused / error
  "wolfram_returned_token":
            "BesselI[0, Infinity]"                    // when Wolfram declines numerically
          | "Indeterminate"                           // when NaN propagates
          | "Infinity" | "-Infinity"                  // when the answer is ±∞
          | "ComplexInfinity"                         // when ComplexInfinity
          | "Underflow[]"                             // (rare; see L9)
          | null,                                     // when status === "success"
  "elapsed_ms": <amortised batch time / N>,
  "notes": "..."                                      // optional, only for limit/refused records
}
```

The `value` field preserves the corpus's input shape: scalar string when
the input z was a real string, `{re, im}` when the input z was a complex
record. Real inputs whose Wolfram value happens to be exactly representable
as an integer (e.g. `J_0(0) = 1`, `J_n(0) = 0` for n≥1) emit the integer
string ("0", "1", "2") with `status: "success"`.

## Cross-validation status (informational)

Spot-checks against R5 §3.1's published reference values (probed
2026-05-17):

| Input | Wolfram@60 (this adapter) | R5 §3.1 reference |
| --- | --- | --- |
| `BesselJ[3, 25/10]` | `0.21660039103911352476668900351596372171684342357695992677700684053000212453412` | `0.21660039103911352476668900351596372171684342357695992677700684053000212453412` |
| `BesselJ[3, 2]` | `0.12894324947440205109879333296923983526999372528246023386443960874280858978464` | `0.12894324947440205109879333296923983526999372528246023386` (R5 truncated to 60dp) |
| `BesselK[0, 700]` | `4.6697764316853768809856276364426087990517773537954366535271211985081132399515522e-306` | `4.66977643168537688098562763644260879905177735379543665352712e-306` (R5 truncated) |

All 50 digits agree with R5's reference. Comparison against the second
gold voice (mpmath @ 60 dps) is the G8 cross-agreement matrix's job; this
adapter's responsibility ends at "produce Wolfram-truth-as-Wolfram-sees-it
in a parseable wire format."

## Notes the user should know

- **Re-running is idempotent.** The corpus is frozen; the adapter consumes
  it and produces a deterministic `results.json` modulo two non-determinism
  surfaces: (a) wall-clock timestamps (`generated_at`, `total_elapsed_ms`,
  per-record `elapsed_ms`); (b) any kernel-version difference if Wolfram
  is upgraded under the user's feet. The numeric outputs themselves are
  byte-identical across re-runs on the same kernel — verified by re-running
  the adapter and diffing the `results[]` arrays.
- **No installation needed.** `wolframscript` is already on `PATH`
  (`/usr/bin/wolframscript`); the kernel is activated. R5 §1 confirmed.
- **Adapter does not modify the corpus.** It is a pure consumer of
  `bench/besselj-anchor/corpus.json`.
- **The single most likely failure mode** if Wolfram's behaviour changes
  in a future kernel release: a previously-numeric output starts returning
  unevaluated, flipping a `status: "success"` row to `status: "limit"`.
  This shows up immediately in the `totals` summary at the top of
  `results.json` and is visible in `git diff`. The other gold voice
  (mpmath) gives the regression a fallback.
