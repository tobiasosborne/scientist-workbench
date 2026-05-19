# Wolfram Mathematica gold-tier oracle for the Gamma-anchor corpus

This directory holds the Wolfram-side adapter and its generated golden-master
file for the world-class Gamma-family reference-implementation effort
(ADR-0042, bead `scientist-workbench-ehi4`, part of the Gamma family epic
`scientist-workbench-1s3o` — successor to the Bessel-anchor epic `zcam`).

## Provenance

| Field | Value |
| --- | --- |
| Probed against (CLI) | `WolframScript 1.13.0 for Linux x86 (64-bit)` |
| Probed against (kernel) | `14.3.0 for Linux x86 (64-bit) (July 8, 2025)` |
| Oracle tier | **Gold** (ADR-0042 §"Decision 8" — primary gold voice for all 19 ADMITTED_HEADS real + complex at 50+ dp; one of only two voices for `BarnesG` complex alongside mpmath) |
| Method | `wolfram-N-at-60-decimal` |
| Achieved precision | 60 decimal digits per value (working precision; first ~58 are gold-trustworthy per R5 §6 L11) |
| Inputs evaluated | 377 / 377 (corpus seed 20260519) |
| Wall-clock total | ~5-7 s post-cold-start; ~25-40 s including kernel boot |
| Corpus SHA-256 | `1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5` |

## How to run

```sh
bun bench/gamma-anchor/oracles/wolfram/adapter.ts
```

This consumes the frozen corpus at `bench/gamma-anchor/corpus.json`, spawns
`wolframscript -file <tempfile>` exactly once (Wolfram cold-start is ~7.6 s;
per-invocation overhead for 377 inputs would be ~50 min — batch mode is
mandatory per R5 §3.1), and overwrites `results.json` in place.

Override binary location:

```sh
WOLFRAMSCRIPT_BIN=/path/to/wolframscript bun bench/gamma-anchor/oracles/wolfram/adapter.ts
```

The run is single-subprocess and unsupervised; it can be backgrounded if
desired, though for a 377-input corpus the wall-time is short enough
(~10 s after cold-start) that backgrounding is rarely worth the cognitive
load of forgetting it ran.

## Coverage — all 19 ADMITTED_HEADS

Wolfram supplies every cell at gold precision. The 19 heads per ADR-0042
§Decision 4 (real + complex):

| Head | Wolfram body | Source notes |
| --- | --- | --- |
| `Gamma(z)` | `Gamma[z]` | DLMF §5.2.1 |
| `LogGamma(z)` | `LogGamma[z]` | DLMF §5.2.1 + branch choice; complex via `LogGamma` not `Log[Gamma[…]]` |
| `Digamma(z)` | `PolyGamma[z]` | DLMF §5.2.2 |
| `Trigamma(z)` | `PolyGamma[1, z]` | DLMF §5.15.1 — `PolyGamma[1, z]` is ψ′(z), not ψ⁽⁰⁾ |
| `Polygamma(m, z)` | `PolyGamma[m, z]` | DLMF §5.15.5 |
| `BarnesG(z)` | `BarnesG[z]` | Adamchik 1998 convention; G(1)=G(2)=G(3)=1, G(4)=2, G(5)=12 (L_polynew_3 pin) |
| `Pochhammer(a, n)` | `Pochhammer[a, n]` | DLMF §5.2.5 rising factorial; `(a)_n = Γ(a+n)/Γ(a)` — matches mpmath `rf` and SciPy `poch` |
| `Beta(a, b)` | `Beta[a, b]` | DLMF §5.12.1 |
| `LogBeta(a, b)` | `LogGamma[a] + LogGamma[b] − LogGamma[a+b]` | Wolfram has no native `LogBeta`; closed-form sum |
| `GammaRatio(a, b)` | `Gamma[a] / Gamma[b]` | R3 §5 ratio-stable variant |
| `GammaDeltaRatio(a, b)` | `Gamma[a] / Gamma[a+b]` | NOT the symmetric-difference form; corpus convention per `generate-corpus.ts:446` |
| `GammaPDerivative(a, z)` | `Exp[-z] · z^(a−1) / Gamma[a]` | DLMF §8.8.3 closed form; avoids Wolfram's symbolic-derivative parsing |
| `IncompleteGammaUpper(a, z)` | `Gamma[a, z]` | **L12** — unregularised upper Γ(a,z) |
| `IncompleteGammaLower(a, z)` | `Gamma[a, 0, z]` | **L12** — unregularised lower γ(a,z) |
| `IncompleteGammaP(a, z)` | `GammaRegularized[a, 0, z]` | **L12** — regularised P(a,z) = γ(a,z)/Γ(a) |
| `IncompleteGammaQ(a, z)` | `GammaRegularized[a, z]` | **L12** — regularised Q(a,z) = Γ(a,z)/Γ(a) |
| `InverseIncompleteGammaP(a, q)` | `InverseGammaRegularized[a, 0, q]` | **L12** — inverts P (3-arg form) |
| `InverseIncompleteGammaQ(a, q)` | `InverseGammaRegularized[a, q]` | **L12** — inverts Q (2-arg form, Wolfram's default) |
| `IncompleteBeta(z, a, b)` | `BetaRegularized[z, a, b]` | Corpus convention I_z(a,b) regularised |

## Status distribution (this run)

```json
{ "success": 369, "refused": 8, "limit": 0, "error": 0 }
```

The 8 refusals are all L17 exact-pole cells (Γ and ψ at z ∈ {0, −1, −2, −3})
where Wolfram returns `ComplexInfinity`. These are honest refusals — the
function has a pole, no number to produce. The G8 comparator special-cases
L17 cells against the other oracles' divergent behaviours
(mpmath `ValueError`, SciPy `+∞`, libm `NaN`).

The `limit` bucket is empty for the gamma corpus: unlike the Bessel corpus
which has `BesselI[0, Infinity]`-style "function has a finite-or-infinite
limit but Wolfram declines numerically" cells, the gamma corpus does not
push any head to a `±Infinity` argument that maps to a limit-but-not-pole.
The dispatch is reserved for parity with the Bessel adapter; the gamma
adapter will only emit `limit` if a future corpus extension introduces such
a cell.

## Landmines pinned in adapter code (read before editing)

Every landmine here is **pinned in adapter code** as a defensive check, an
inline comment, or a wire-format rewrite. Removing a pinned mitigation
without an updated landmine entry is a regression.

### L1 — Wolfram input-trap (`Rational[]`, NOT machine doubles)

**The bug**: `N[Gamma[1.5], 60]` silently returns only ~16 digits of
precision, because `1.5` parses as `MachinePrecision` (float64) and
`N[…, 60]` propagates machine precision through the head. The
60-displayed-digit answer is mostly a lie — only the first ~16 are
trustworthy.

**The fix**: every numeric corpus value — real-string z, complex re/im
parts, every scalar arg under its `{kind, value}` discriminator — is parsed
to an exact `BigInt` rational `(num, den)` and emitted to Wolfram as
`Rational[num, den]` (auto-reducing to a bare integer when `den == 1`).
The corpus's 60-dp decimal-string convention exists exactly so this parse
is lossless. See `parseDecimalToRational`, `parseFractionToRational`, and
`argToWlExpr` / `zToWlExpr` in `adapter.ts`. Smoke-tested at module load.

### L12 — Incomplete-gamma regularisation convention (THE critical gamma landmine)

**The bug**: SciPy's `gammainc(a, z)` returns *P (lower regularised)*;
Wolfram's `Gamma[a, z]` returns *upper UNregularised Γ(a,z)*. The same
function name means opposite things in different oracles. A cross-agreement
comparator that calls "the incomplete gamma" on both will report a 100%
disagreement when in fact both oracles are correct — just answering
different questions.

**The fix**: the corpus emits FOUR DISTINCT HEADS (`IncompleteGammaUpper`,
`IncompleteGammaLower`, `IncompleteGammaP`, `IncompleteGammaQ`) plus two
inverse heads, NEVER sharing an input record. The Wolfram adapter maps
each to its exact symbol per the table above. **Every adapter line for
these six heads carries an inline `// L12` comment** (audit: `grep '// L12'
adapter.ts` returns 17 matches across body comments and code).

The identities `P + Q = 1` and `Upper + Lower = Γ(a)` hold across the corpus
— verified spot-check for `(a=1/2, z=2)`: P = 0.9544997..., Q = 0.0455002...,
sum = 1 to 60 dp.

### L_carryover — Wolfram `*^` exponent marker → standard `e<exp>`

**The bug**: Wolfram's `InputForm` of an arb-prec real prints
`<mantissa>BT<prec>.*^<exp>` (where BT is the literal backtick character).
A naive "strip from the first backtick onward" shaver silently drops the
`*^<exp>` exponent. This was the load-bearing G2a bug from the Erf epic
(worklog 138). Note that the precision-annotation can itself carry a
decimal point: a complex `Gamma` evaluation emits backticks like
`BT59.74219736486953*^-23` — the regex must accept any digits+dot pattern.

**The fix**: the `.wls` preamble's `FormatNumeric` function rewrites
`` `[0-9.]+\*\^ `` → `e` *before* stripping the trailing `` `[0-9.]+$ ``.
Wire format is therefore standard-scientific (`<mantissa>e<exp>`) or
plain-decimal (`<mantissa>`), ready for any cross-language numeric parser.
The TS-side `stripPrecisionSuffix` is retained as belt-and-suspenders.

Spot-check this run: `Gamma[12]` = 39916800 emits as `"3.99168e7"`;
complex `Gamma` at T4 cells emits both `re` and `im` as standard-scientific
without precision-annotation leakage.

### L17 — Γ/ψ at non-positive integers (pole behaviour diverges per oracle)

**The behaviour**: Wolfram returns `ComplexInfinity` at every pole of Γ
(z = 0, −1, −2, …) and ψ (same pole set). The corpus T3 tier includes
exact-pole cells at z ∈ {0, −1, −2, −3} for both Γ and ψ — 8 cells total
in this run.

**The mitigation**: the classifier's `COMPLEX-INFINITY` bucket maps to
`status: "refused"` with `wolfram_returned_token: "ComplexInfinity"`. This
is the **HONEST refusal** discipline — Wolfram declined because there is
no number to produce, not because the function has a finite-or-infinite
limit Wolfram is shy about. (The Bessel adapter maps `COMPLEX-INFINITY` to
`status: "limit"` because in Bessel land the relevant cell is
`BesselI[0, Infinity]` where the function does have a limit; the gamma
adapter intentionally diverges.) The G8 comparator special-cases L17 cells
against the other oracles' divergent pole behaviours (mpmath `ValueError`,
SciPy `+∞`, libm `NaN`).

### L_polynew_3 — BarnesG Adamchik convention

**The pin**: Wolfram's `BarnesG[z]` uses the Adamchik 1998 convention,
normalised so `G(1) = G(2) = G(3) = 1`, `G(4) = 2`, `G(5) = 12`. mpmath's
`barnesg(z)` uses the same convention (spot-checked at integer arguments).
Boost and SciPy do not ship `BarnesG`, so cross-validation for this head
is gold-only (Wolfram + mpmath).

**The risk if a future Wolfram release drifts**: a comment-vs-behaviour
mismatch will surface in `git diff` of `results.json` (BarnesG(4) flipping
from "2" to some other value); the comparator will catch the divergence
against mpmath.

### L9 / L10 — `Underflow[]` / `Overflow[]` post-processing (belt-and-suspenders)

**The risk**: for inputs pushing the kernel past `$MaxExtraPrecision`,
Wolfram emits a wrapper like `1 - Underflow[]` instead of a limit value.

**The mitigation**: the `.wls` preamble's `PrintRecord` applies
`Underflow[] -> 0` and `Overflow[] -> Infinity` substitutions and re-runs
`N[…, 60]` before classification. At 60-dps + |z| ≤ 1000 (the gamma
corpus's T6 cap) this rarely triggers in practice; the mitigation is here
for parity with Bessel and as defence against any future corpus extension.

### L11 — Wolfram trailing-noise digits past declared precision

**The behaviour**: at 60-dp declared precision Wolfram emits ~62-64 digits;
the last 2-4 are rounding noise.

**The mitigation**: this adapter emits all digits Wolfram produces. The
tier-tolerance band is the G8 comparator's responsibility (not the
adapter's). The README documents the noise floor so downstream consumers
compare at `precision − 2` digits when matching Wolfram-against-Wolfram
or against another gold voice at the same declared precision.

## Output schema

`results.json` envelope:

```jsonc
{
  "oracle_id": "wolfram",
  "oracle_version": "Mathematica 14.3.0 … / wolframscript WolframScript 1.13.0 …",
  "generated_at": "<ISO 8601>",
  "corpus_seed": 20260519,
  "corpus_sha256": "1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5",
  "tier": "gold",
  "precision_decimals_requested": 60,
  "bead": "scientist-workbench-ehi4",
  "adr": "0042",
  "total_inputs": 377,
  "total_elapsed_ms": <number>,
  "notes": [ …landmine pin summary… ],
  "totals": { "success": N, "refused": N, "limit": N, "error": N },
  "results": [ <one record per corpus input, in corpus order> ]
}
```

Per-record shape:

```jsonc
{
  "input_id": "T1-gamma-001",
  "status": "success" | "refused" | "limit" | "error",
  "value": "1.7724…60dp"                    // real success scalar
         | { "re": "…", "im": "…" }          // complex success
         | "1" | "24" | "504"                // exact-integer shortcut (rare)
         | "3.99168e7"                        // standard-scientific (large value)
         | null,                              // refused / limit / error
  "wolfram_returned_token":
           "ComplexInfinity"                 // at Γ pole (L17)
         | "Indeterminate"                   // NaN composition
         | "Infinity" | "-Infinity"          // diverging value
         | "Underflow[]" | "Overflow[]"      // L9/L10 (rare)
         | "<symbolic-form>"                 // generic refusal
         | null,                              // success
  "elapsed_ms": <amortised batch time / N>,
  "notes": "…"                                // optional, for non-success
}
```

The `value` field preserves the corpus's input shape: scalar string for
real-input `z` strings, `{re, im}` for complex `{re, im}` inputs. Cells
whose Wolfram value happens to be an exact integer (Γ(1)=1, Γ(5)=24,
GammaRatio(10,7) = 9·8·7 = 504) emit as a short integer string.

## Spot-check transcript (against the run committed alongside this README)

| Cell | Expected | This run |
| --- | --- | --- |
| `Gamma(1/2)` = √π | `1.77245385090551602729816748334114518279754945612238712821380778985291…` | `1.77245385090551602729816748334114518279754945612238712821380778985291128459103` |
| `Gamma(1)` = 1 | `1` | `1` |
| `Gamma(5)` = 24 | `24` | `24` |
| `Gamma(12)` = 11! = 39916800 | `3.99168e7` | `3.99168e7` |
| `LogGamma(1)` = 0 | `0` | `0` |
| `Beta(1/2, 1/2)` = π | `3.14159265358979323846…` | `3.14159265358979323846264338327950288419716939937510582097494459230781640628621` |
| `BarnesG(1)` = 1 (Adamchik) | `1` | `1` |
| `BarnesG(5)` = 12 (Adamchik) | `12` | `12` |
| `GammaRatio(10, 7)` = 9·8·7 = 504 | `504` | `504` |
| `IncompleteBeta(0.5; 2, 3)` = 0.6875 | `0.6875` | `0.6875` |
| `Polygamma(2, 1)` = −2·ζ(3) | `-2.40411380631918857079947632302…` | `-2.40411380631918857079947632302289998152997258468099776358454311068367682270427` |
| `IncompleteGammaP(1/2, 2)` | `0.9544997361…` | `0.95449973610364158559943472566693312505644755259664313203266799963261042625033` |
| `IncompleteGammaQ(1/2, 2)` | `0.0455002639…` (= 1 − P) | `0.04550026389635841440056527433306687494355244740335686796733200026446920733607` |
| `Γ(0)` (L17 pole) | refused (ComplexInfinity) | refused (ComplexInfinity) |

All identities and reference values agree. The P+Q identity holds to 60 dp.

## Notes the user should know

- **Re-running is deterministic.** The corpus is frozen
  (sha256 `1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5`);
  the adapter consumes it and produces deterministic `results.json` modulo
  three non-determinism surfaces:
  (a) wall-clock timestamps (`generated_at`, `total_elapsed_ms`, per-record
      `elapsed_ms`);
  (b) any kernel-version difference if Wolfram is upgraded under the user's
      feet;
  (c) `WolframScript` CLI version drift.
  The numeric outputs themselves are byte-identical across re-runs on the
  same kernel — verified by re-running and diffing `results | map(del(.elapsed_ms))`.
- **No installation needed.** `wolframscript` is already on `PATH`
  (`/usr/bin/wolframscript`); the kernel is activated. R5 §1 confirmed.
- **Adapter does not modify the corpus.** It is a pure consumer of
  `bench/gamma-anchor/corpus.json`.
- **The single most likely failure mode** if Wolfram's behaviour changes
  in a future kernel release: a previously-numeric output starts returning
  an unevaluated symbolic form, flipping a `status: "success"` row to
  `status: "refused"`. This shows up immediately in the `totals` summary
  at the top of `results.json` and is visible in `git diff`. The other
  gold voice (mpmath) gives the regression a fallback.

## Pointers

- `docs/adr/0042-gamma-family-per-head-substrate.md` §Decision 4 (ADMITTED_HEADS), §Decision 8 (oracle hierarchy).
- `docs/refs/gamma-research/R5-oracle-landscape.md` §3 (Wolfram capability matrix), §6 (landmines L1-L17).
- `bench/gamma-anchor/corpus.json` — the frozen 377-input manifest this adapter consumes.
- `bench/gamma-anchor/corpus-spec.md` — wire-format conventions and arity table.
- `bench/besselj-anchor/oracles/wolfram/adapter.ts` — the closer precedent (multi-arg + Rational[] discipline).
- `bench/erf-anchor/oracles/wolfram/adapter.ts` — the seed precedent (single-arg head).
- Bead `scientist-workbench-ehi4` (this G2 work item; orchestrator-tracked).
