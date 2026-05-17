# ADR-0040 — Per-head special-function substrate + bidirectional Meijer-G bridge, prototyped via Erf

**Status:** Implemented — 2026-05-17 (see worklog 142); float64 complex
substrate amended to full Faddeeva-Johnson port (Algorithm 916 +
`w_im_y100` Chebyshev) — 2026-05-17 (see worklog 167). Originally
proposed 2026-05-16.
**Beads:** `scientist-workbench-43hw` (epic — World-class Erf). Phase 0
research children all closed: `kvfu` (R1 symbolic identities), `9jpm`
(R2 arb-prec algorithms), `1i5z` (R3 float64 algorithms), `lnux` (R4
Meijer-G bridge), `u4pe` (R5 oracle landscape). This ADR (`ss5o`/A0) is
the Phase 0 gate. Phase 1 (golden corpus, G1–G8) and Phase 2 (substrate
impl, I1–I6 plus discovered I6a) are filed and blocked on this ADR.
**Related:** ADR-0014 (first numerical tier — substrate-package
pattern), ADR-0015 (`numerical: true` determinism contract — bit-
identical given platform fingerprint), ADR-0020 (`arbprec: true`
determinism contract — bit-identical cross-platform forever given
`--precision=N`), ADR-0023 (closed-vocabulary special-function table;
this ADR amends with `Erfi`), ADR-0025 (Meijer-G symbolic dispatch
pattern-rule design), ADR-0030 (cone-solver tier — bench-discipline
template for the gold/silver/bronze oracle hierarchy adopted here),
ADR-0034 (qinfo substrate-package pattern — sibling for the new
`@workbench/special-eval` package). Bead `d6s` (per-head arbprec
evaluator umbrella) supersedes its scope into the substrate this ADR
pins. Bead `ybrw` (`bigErfc` for Berry smoothing) is the load-bearing
downstream consumer that keeps the design honest.

## Context

`@workbench/cas-core`'s vocabulary table (ADR-0023) admits 27 special
function heads (28 after this ADR amends with `Erfi`). For the
elementary subset and the Γ-family, the substrate is mature:
`@workbench/bigfloat::cgamma / clgamma / cdigamma / lgamma / gamma /
digamma / trigamma / polygamma` ship arb-prec real and complex evaluators;
`@workbench/quadrature::evalNumericExpr` ships the float64 closed-
vocabulary numerical evaluator; the symbolic differentiator handles 15
heads (`packages/cas-core/src/special-functions.ts`); the Adamchik–
Marichev + Roach symbolic dispatcher (ADR-0025) ships Meijer-G reduction
rules that emit named heads.

What is missing is a *per-head architecture*: a uniform substrate shape
that every special function — Erf today, Bessel / Whittaker / Legendre
tomorrow — plugs into across all four axes (symbolic identities,
arb-prec evaluator, float64 evaluator, bidirectional Meijer-G bridge),
under a single decision principle and with one wire surface.

The Erf head is the smallest function that exercises every axis without
the complications of multi-parameter dispatch (Bessel), branch cuts
(`log` family), or list-of-list parameters (`HypergeometricPFQ`,
`MeijerG`). It has a real downstream consumer (`ybrw` Berry-smoothing
in the Stokes band) that pins the precision-tracking discipline against
a concrete use case. Once the per-head pattern is pinned, every
subsequent head reuses it incrementally.

### Phase 0 research findings (load-bearing for the decisions)

Five Opus deep-research subagents produced 245 KB of literature-cited
material at `docs/refs/erf-research/`. The findings that pin
ADR-0040:

* **R1** (symbolic, `docs/refs/erf-research/R1-symbolic-identities.md`,
  580 lines, 38 rule entries): 22 v0.1-shippable identities under the
  current ADR-0023 vocabulary. **Verified finding** —
  `packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts:132` already
  ships the rule `dlmf-16-18-erf` emitting `√π · erf(√z)` from
  `G^{1,1}_{1,2}(1; 1/2, 0 | z)`. The Adamchik–Marichev forward path
  through `Erf` is in production. Erf, Erfc, Erfi are all entire — no
  branch-cut bookkeeping on the forward heads.
* **R2** (arb-prec, `docs/refs/erf-research/R2-arbprec-algorithms.md`,
  1781 lines): five canonical algorithm representations
  (Maclaurin / asymptotic / continued fraction / ₁F₁ / Karbach-
  Weideman) with a derived crossover `x_c(p) := √(p · ln 2)`. For 50 dps
  (`p = 196`), `x_c ≈ 11.0`. Substrate exemplar is
  `packages/bigfloat/src/complex.ts` (`cgamma` / `clgamma` /
  `cdigamma`). Faddeeva pick: Karbach 2014 / Weideman-Fourier (the only
  modern algorithm with closed-form prec-dependence for both truncation
  parameters). **Critical risk surfaced:** `bigErfc` must not be
  implemented as `1 - bigErf` for `|x| > x_c` (catastrophic cancellation
  costs `x²·log₂(e)` bits — at `x = 20`, ~580 bits gone, 50 dps becomes
  garbage). Mirrors the `expm1` / `log1p` pattern in
  `transcendental.ts`.
* **R3** (float64, `docs/refs/erf-research/R3-float64-algorithms.md`,
  1236 lines): port the **Sun Microsystems 1993** algorithm verbatim
  (musl + glibc + FreeBSD lineage, byte-identical across five libms, 33
  years in service, ≤ 1 ULP `erf` / ≤ 2 ULP `erfc`). Five-piece dispatch
  on `|x|`. Complex via Faddeeva-Johnson MIT (2529 LOC). Inverses via
  Blair–Edwards–Johnson 1976 rational approximants (1 ULP without
  Newton refinement). All algorithms are pure float64 + `Math.exp` /
  `Math.log` / `Math.sqrt` + a `DataView` low-mantissa-mask helper — no
  FFI, no platform branches, inherits the `numerical: true` fingerprint
  of V8 transcendentals (ADR-0015).
* **R4** (Meijer-G bridge,
  `docs/refs/erf-research/R4-meijer-g-bridge.md`, 898 lines): canonical
  G-form table for Erf / Erfc / Erfi pinned via SymPy + diofant + mpmath
  triangulation (Wolfram Functions Site gated HTTP 403, substance
  recovered). `Erf⁻¹` / `Erfc⁻¹` honestly refuse — no Meijer-G form
  exists in the literature (DLMF §7.17 gives only power series).
  Adopt **Form A** (`erf(z) = z/√π · G([{1/2},{}], [{0},{-1/2}], z²)`)
  as canonical forward. **Critical finding:** `Erfi` is not in the
  ADR-0023 vocabulary table — this ADR amends.
* **R5** (oracle landscape,
  `docs/refs/erf-research/R5-oracle-landscape.md`, 647 lines): Wolfram
  Mathematica 14.3 + mpmath 1.3.0 + sympy 1.14.0 + Boost.Math 1.83 +
  scipy 1.17.0 + g++ 13.3 libm available locally; Julia
  SpecialFunctions.jl, Arb/FLINT, MPFR/GSL dev headers **not**
  installed. Three-way 50-dp agreement (`mpmath = sympy = Boost
  cpp_bin_float<50>`) establishes the cross-validation baseline.
  Critical landmines: Wolfram input must parse as `Rational[num,den]`
  not float (`N[Erf[1.23],50]` silently returns ~16 digits). Single-
  engine complex arb-prec oracle pair (Wolfram + mpmath) is the weakest
  link — installing Arb closes it.

## Decision

We pin the per-head special-function substrate as the following layered
architecture. Every special function admitted to the ADR-0023
vocabulary lives in the same shape; Erf is the v0.1 instantiation and
proves the pattern.

### Decision 1 — Substrate layering (where each layer lives)

| Axis | Package | Per-head landing site | Determinism tier |
|---|---|---|---|
| Symbolic identities | `@workbench/cas-core` | `src/special-funcs/<head>-identities.ts` | symbolic (default; bit-identical forever) |
| Diff rules | `@workbench/cas-core` | `src/special-functions.ts` (existing dispatcher; per-head case) | symbolic |
| Arb-prec real + complex | `@workbench/bigfloat` | `src/special-funcs/<head>.ts` (real on BigFloat) + extension to `src/complex.ts` (complex on BigComplex) | `arbprec: true` (ADR-0020) |
| Float64 real + complex | `@workbench/quadrature` | `src/special-funcs/<head>-float64.ts` (the SunPro / Faddeeva-Johnson port for Erf) + new `src/eval-numeric-expr.ts` wrapping `eval-expr.ts` with an `applySpecial(head, args, env)` dispatch | `numerical: true` (ADR-0015) |
| Meijer-G bridge | `@workbench/meijer-core` | `src/bridges/<head>.ts` (forward `headToMeijerG` + backward pattern-matcher; new bridge sub-directory sibling to existing `dispatch-rules/`) | symbolic |
| Wire surface | `tools/special-eval/` | one umbrella tool with `--head=<name>` flag dispatching across heads; honours `--precision=<int>` (ADR-0011 standard flag) — `--precision ≤ 53` routes the float64 lane, `> 53` routes the arb-prec lane | per-tier; arb-prec call records platform-independent provenance, float64 call records platform fingerprint |

The substrate-package boundaries follow the **existing** split: `bigfloat`
already houses the arb-prec Γ family alongside its core type and
arithmetic; `quadrature` already houses the float64 evaluator and the
adaptive Gauss-Kronrod / tanh-sinh substrates. Adding sister files for
the Erf family preserves the per-package locality discipline (ADR-0014).
A new top-level `@workbench/special-eval` package is **explicitly
rejected** as premature consolidation — the per-axis package boundaries
are load-bearing and a single umbrella package would dilute them.

### Decision 2 — Per-head module layout (the literal directory shape)

```
packages/cas-core/src/special-funcs/erf-identities.ts
packages/bigfloat/src/special-funcs/erf.ts             # bigErf / bigErfc / bigErfcx / bigErfi / bigErfInv / bigErfcInv (real)
packages/bigfloat/src/complex.ts                       # extended with bigCErf / bigCErfc / bigCErfcx / bigCErfi / bigW
packages/quadrature/src/special-funcs/erf-float64.ts   # SunPro 1993 verbatim port (real) + Faddeeva-Johnson port (complex)
packages/quadrature/src/eval-numeric-expr.ts           # NEW: wraps eval-expr.ts with applySpecial(head, args, env)
packages/meijer-core/src/bridges/erf.ts                # forward headToMeijerG + backward matcher for Erf/Erfc/Erfi
tools/special-eval/                                    # wire tool: --head=erf|erfc|erfcx|erfi|erfinv|erfcinv, --precision=N, --re=x, --im=y
```

Every subsequent head reuses this layout. `bigfloat/src/special-funcs/`
and `cas-core/src/special-funcs/` and `meijer-core/src/bridges/` are
the per-head landing sub-directories; the wire surface remains a single
umbrella tool.

### Decision 3 — Arb-prec evaluator contract

Per-head signature (uniform across the table):

```ts
// Real path. Throws RangeError on non-finite input; returns BigFloat
// with precision exactly `prec` bits (post-normalisation).
export function bigErf(x: BigFloat, prec: number): BigFloat;
export function bigErfc(x: BigFloat, prec: number): BigFloat;
export function bigErfcx(x: BigFloat, prec: number): BigFloat;   // exp(x²)·erfc(x) — DIRECT computation, never via erfc
export function bigErfi(x: BigFloat, prec: number): BigFloat;
export function bigErfInv(y: BigFloat, prec: number): BigFloat;  // Newton with f64 seed
export function bigErfcInv(y: BigFloat, prec: number): BigFloat;

// Complex path. Throws on non-finite. The Faddeeva primitive bigW is
// the single load-bearing complex implementation; the others are
// algebraic combinations per the Karbach §2 / DLMF §7.4 identity table.
export function bigW(z: BigComplex, prec: number): BigComplex;
export function bigCErf(z: BigComplex, prec: number): BigComplex;
export function bigCErfc(z: BigComplex, prec: number): BigComplex;
export function bigCErfcx(z: BigComplex, prec: number): BigComplex;
export function bigCErfi(z: BigComplex, prec: number): BigComplex;
```

Algorithms are fixed by R2: real path is Arb-style series/asymptotic
dispatch on the derived crossover `x_c(p) = √(p · ln 2)`. Series uses
the **all-positive Borel form DLMF 7.6.2** (NOT 7.6.1 textbook
Maclaurin; the former has zero alternation, the latter cancels
catastrophically for `|z|² > p`). Complex path is Karbach 2014 /
Weideman-Fourier with closed-form `(τ_m, N)` prec-scaling. Each
function carries its own algorithm path; **`bigErfc` is not `1 -
bigErf`** for `|x| > x_c`; **`bigErfcx` is not `exp(x²)·bigErfc(x)`**.
This is the load-bearing R2 risk-mitigation and is the v0.1 design's
single non-obvious discipline.

Cancellation-driven precision retry mirrors `clgammaReflect` (worklog
117, bead `oj5j`): measure loss as `magBits(blowUp) -
magBits(finalValue)`, bump `work = prec + 32 + lossBits`.

Determinism: every operation is `BigInt` + bounded-integer-exponent
arithmetic; `BigInt` is bit-identical across runtimes by language
specification. Inherits the `arbprec: true` contract of ADR-0020 — same
`(input, prec)` bytes → byte-identical `BigFloat` output forever.

### Decision 4 — Float64 evaluator contract + dispatch hook

A new `packages/quadrature/src/eval-numeric-expr.ts` wraps the existing
`eval-expr.ts` with an `applySpecial(head, args, env): number` dispatch.
The wrapper extends `ADMITTED_HEADS` with the special-function heads
this ADR ships (`Erf`, `Erfc`, `Erfcx`, `Erfi`, `InverseErf`,
`InverseErfc` — and as future ADRs ship Bessel etc., the same list
grows additively).

Per-head signature:

```ts
// Real (Float64); pure JS, no FFI. Inherits the numerical: true
// platform fingerprint of V8's Math.exp/log/sqrt.
export function erfFloat64(x: number): number;
export function erfcFloat64(x: number): number;
export function erfcxFloat64(x: number): number;
export function erfiFloat64(x: number): number;
export function erfInvFloat64(y: number): number;
export function erfcInvFloat64(y: number): number;

// Complex (pair of float64; carries through the qinfo Matrix encoding
// idea — but for scalars the shape is just {re, im}).
export function erfComplexFloat64(re: number, im: number): { re: number; im: number };
export function erfcComplexFloat64(re: number, im: number): { re: number; im: number };
// ... etc.
```

Algorithm: SunPro 1993 verbatim port per R3 (the canonical libm
algorithm; ≤ 1 ULP `erf`, ≤ 2 ULP `erfc`). Complex via Faddeeva-Johnson
2012 (MIT-licensed; canonical w(z) reference). Inverses via Blair-
Edwards-Johnson 1976 rational approximants.

**Amendment (worklog 167, bead `nxvu`).** The original 2026-05-17 ship
landed the Faddeeva-Johnson port with the unified Poppe-Wijers
continued fraction as the universal complex bulk — a deliberate
v0.1 simplification. Browser-app testing surfaced two regressions:
(a) `|z| < 1.5` complex Erf was wrong by 1-3 orders of magnitude
(CF doesn't converge for small `|z|`); (b) real-axis `erfi(x)` for
`x ∈ [3.5, 6]` was precision-limited to ≈ 1e-7 by the inherent
asymptotic-truncation floor of an `erfi(x) ~ exp(x²)/(x√π)·(1 +
1/(2x²) + …)` series. The float64 complex substrate is now upgraded
to the full Faddeeva-Johnson hybrid: Zaghloul-Ali Algorithm 916
(`ACM TOMS 38(2), 2011`) for the bulk, Poppe-Wijers CF for large
`|z|` (Faddeeva.cc's documented envelope), the 100-panel
`w_im_y100` Chebyshev table on the real axis, and both `taylor` and
`taylor_erfi` cancellation-band branches for complex `erf`. The
accuracy contract is now ≤ Faddeeva-Johnson's published `1e-13`
relative across all of ℂ, matching the canonical reference.

The `applySpecial` dispatch keeps the existing closed-vocabulary
discipline (ADR-0023 generalised): unknown heads continue to throw
`UnknownVocabularyError`. The dispatch table is a `Map<string, (args:
number[]) => number>`; adding a new head is one map insertion plus the
per-head float64 module.

`numerical: true` determinism contract: same `(input_bytes, platform_fp)`
→ same `output_bytes`. Platform fingerprint `{arch, os, runtime}` is
recorded in the provenance record (ADR-0015).

### Decision 5 — Bidirectional Meijer-G bridge API

Per R4:

```ts
// In packages/meijer-core/src/bridges/types.ts (new module):
export interface MeijerGForm {
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
}

// In packages/meijer-core/src/bridges/erf.ts:
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;       // prefactor / multiplier reconstruction
  readonly zInverse: () => readonly Value[];     // recovers original head args byte-identically
                                                  // (sidesteps multi-valued √(z²) on round-trip)
}

export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null;                          // null = head not in this bridge module's scope (caller can try the next bridge)

export function meijerGToHead(
  form: MeijerGForm,
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null;
```

The `zInverse` closure is the load-bearing trick: forward records the
original `args` in a closure; backward calls `zInverse()` to recover
them byte-identically without computing `√` of the G-form's z-slot
(which would expose the multi-valued root branch problem).

Round-trip property (the bridge's correctness contract):

```ts
for (const head of ["Erf", "Erfc", "Erfi"]) {
  for (const sample of erfFamilySamples) {
    const fwd = headToMeijerG(head, [sample]);
    const bwd = meijerGToHead(fwd!.gForm);
    assert(bwd!.head === head);
    assert(canonicalize(value(bwd!.args)) === canonicalize(value([sample])));
  }
}
```

For inverse-erf and inverse-erfc, both directions return `null`
(refusal); this IS the contract — no Meijer-G form exists in the
literature.

### Decision 6 — ADR-0023 vocabulary amendment (Erfi)

ADR-0023's `SPECIAL_FUNCTION_HEADS` table grows from 27 to 28 heads by
admitting `Erfi`:

```ts
// packages/cas-core/src/special-functions.ts (extension):
"Erfi",                                            // appended to SPECIAL_FUNCTION_HEADS

// specialFunctionArity:
case "Erfi": return { kind: "fixed", count: 1 };

// differentiateSpecialFunction:
case "Erfi": return mkTimes(R(2, "√π"), mkPower(E, mkPower(z, 2)));   // (2/√π)·exp(z²), DLMF §7.10.2
```

This is the *only* vocabulary expansion this ADR ships. The honest
refusal for `Erf⁻¹` / `Erfc⁻¹` on the Meijer-G bridge is sufficient;
adding inverse-erf vocabulary heads is deferred to a future ADR with a
concrete consumer (probability tail-quantile work would motivate it).

### Decision 7 — Wire tool surface (`tools/special-eval`)

One umbrella tool per the existing `tools/oracle` / `tools/registry-*`
pattern. Schema:

```ts
input  = record{ head: string, args: list<float64> | record{ re: list<float64>, im: list<float64> } }
output = record{
  value: float64 | bigfloat | bigcomplex,
  method: string,                                  // "erf-sunpro-1993", "erf-borel-series", "erf-karbach-faddeeva", "erf-blair-1976-inverse", etc.
  achieved_precision: int,                         // bits attained (matches --precision for arb-prec; 53 for float64)
  warnings: list<string>,
}
| tagged "special-eval/{unknown-head, non-finite-input, degenerate-shape, no-known-representation}"
```

Standard flags: `--head=<name>` (required), `--precision=<int>` (default
53; routes to float64 lane if `≤ 53`, arb-prec lane otherwise),
`--branch=<int>` (deferred; for future multi-valued heads). The
`no-known-representation` boundary tag covers `Erf⁻¹` / `Erfc⁻¹` when
the caller requests the Meijer-G bridge form (and other future
honestly-refused requests).

This wire tool **closes the scope of bead `d6s`** (per-head arbprec
evaluator umbrella, P2): `d6s` is filed for the Meijer-G dispatcher's
need to numerically evaluate AST in the special-function vocabulary;
this wire is the production-quality realization for the Erf head and
generalises as the per-head substrate fills out.

### Decision 8 — Oracle hierarchy + cross-validation discipline

Per R5, the oracle tiers for golden-master generation and bench
grading:

| Tier | Oracles | Use |
|---|---|---|
| **Gold** | Wolfram Mathematica + mpmath | Arb-prec deep masters at 50+ decimals. The two engines are independent (Mathematica's closed-source kernel; mpmath's mpf BigInt-mantissa implementation). Three-way agreement (R5 §1: `mpmath = sympy = Boost cpp_bin_float<50>` at 50 dp for `erf(123/100)`) is the cross-validation baseline. |
| **Silver** | Boost.Math `cpp_bin_float<N>` (real only); Arb if installed | Arb-prec real cross-check. **Single weakest link: no silver-tier complex arb-prec oracle locally.** Install Arb (`apt install libflint-dev libflint-arb-dev` + `pip install python-flint`) to close the gap. |
| **Bronze** | scipy + libm + Boost `<double>` (real); scipy + Wolfram MachinePrecision (complex) | Float64 evaluator validation. Agreement target ULP-distance ≤ 2 vs mpmath truncated to float64. |

Adapter shape: uniform TS `(input, precision_decimals, fn) → (output,
precision_actual, oracle_id, oracle_version)`. All adapters spawn via
the `spawnBun` resolver (ADR-0001 — handles snap-Bun's mount-namespace
corner). Batch mode mandatory for Wolfram (3 s cold-start cost) and
recommended for Python adapters.

**Critical landmines pinned in adapter code, not deferred to runtime
discovery:**

1. Wolfram input MUST construct as `Rational[num, den]` from decimal-
   string parse — `1.23` parses as machine-precision double and
   silently truncates the result to ~16 digits. Probe-confirmed.
2. mpmath `nstr` rounds-to-nearest while Wolfram `N[]` truncates. Last-
   digit can differ by 1 ULP. Comparator canonicalises before equality.
3. Complex arb-prec single-engine pair (Wolfram + mpmath) is the
   weakest link. Mitigation: algebraic self-checks (`erf(z*) = erf(z)*`,
   `erf(z) + erfc(z) = 1`, `erf(-z) = -erf(z)`) supplement oracle
   cross-checks; install Arb when feasible.

### Decision 9 — Determinism tier carried per-output

A tool admits multiple determinism tiers across its outputs (the
ADR-0007 precedent: `meijer-g` carries `achieved_precision` only when
arb-prec; `numerical: true` tools record `platform` only when output
contains float64 leaves — ADR-0035 §"Determinism contract is tiered").
For `tools/special-eval`:

* `--precision=53` (default) → float64 output → `numerical: true`
  contract; platform fingerprint recorded.
* `--precision>53` → BigFloat / BigComplex output → `arbprec: true`
  contract; cross-platform determinism; no platform field needed.

The tool's manifest annotation lists both tiers: `{ numerical: true,
arbprec: true }` is **not** a contradiction here — it's per-output
conditioning, with the live tier decided by the `--precision` value at
each invocation. The provenance writer (`runMemoized`) checks the live
output's tier and writes the appropriate provenance fields.

### Decision 10 — Phase ordering and per-bead claim discipline

The 26 sub-beads filed under `erf-anchor` claim in five gated phases:

1. **Phase 0 (DONE):** R1–R5 research; this ADR (A0 = `ss5o`). Phase 0
   gates Phase 1.
2. **Phase 1:** Oracle harness (G1–G8). G1 designs the corpus tiers;
   G2–G7 fan out parallel per-oracle adapters; G8 computes the cross-
   oracle agreement matrix. **Phase 1 GATE:** corpus + matrix complete
   before any Phase 2 substrate bead claims.
3. **Phase 2:** Substrate impl (I1–I6, plus the discovered I6a vocab
   amendment). I1 (`bigErf` real) is the entry point; I2 (`bigErfc` +
   `bigErfcx`) and I3 (complex via Karbach-Weideman) follow. I4 (cas-
   core identities), I5 (float64 dispatcher), I6 (Meijer-G bridge) and
   I6a (Erfi vocab) are independent; can fan out in parallel. **Phase
   2 GATE:** `bun run check` green; golden-master suite green against
   the Phase 1 corpus.
4. **Phase 3:** Tool integration (T1 integrate-1d, T2 tools/special-
   eval, T3 meijer-g closure validation).
5. **Phase 4:** Verification (V1 property tests + mutation-proving) +
   docs lockstep (D1).

Each bead's implementation is delegated to an Opus subagent with the
bead ID, ADR-0040, the relevant golden tier, and the decision principle
("legendary TS senior SE bar") in the prompt. The orchestrator (me)
monitors, validates, looks for blockers, updates beads, gates on test
results.

## What we will not decide here

* **Numerical evaluation of every special function**, only the Erf
  family. The substrate pattern this ADR pins generalises; per-head
  ADRs (or one omnibus ADR-0040 series) cover Bessel, Whittaker,
  ParabolicCylinderD, Legendre family, Lerch transcendent — those beads
  exist (`zmfs`, `5e1i`, `4eze`, `h6o1`, `2t9z` filed earlier this
  session) but their substrate impls are deferred to follow-up work
  built on top of this prototype.
* **Per-head bench corpus in `scientist-workbench-corpus`.** The
  Phase 1 golden corpus lives locally under `bench/erf-anchor/` for
  v0.1 (oracles G2–G7 emit into this directory). Promotion to the
  corpus repo follows the ADR-0028 / ADR-0037 universal-tier discipline
  in a future bead — the local goldens are the daily inner-loop driver.
* **Inverse-erf complex evaluator.** Multi-valued Riemann surface; no
  canonical computational form; SciPy / Boost / Julia all decline.
  Honest refusal (`tagged "special-eval/no-known-representation"`)
  remains the v0.1 contract.
* **Arb installation as a hard prerequisite.** The substrate ships
  correctly without Arb; the cross-validation chain is weaker (no
  silver-tier complex arb-prec oracle). The R5 install recommendation
  is a *strong* suggestion to the user; ADR-0040 does not block on it.
  Algebraic self-checks (Decision 8 §3) supplement.
* **Per-head pretty-printer.** No general human-readable pretty-printer
  exists for the special-function vocabulary today
  (`packages/cas-core::canonicalize` is canonical JSON, not a
  pretty-printer). Lands when a consumer needs it.
* **TS-native `Erf` DSL.** The TS-native Sturm frontend (ADR-0009)
  pattern could extend to a `cas-frontend` package admitting
  `erf(x: Bigfloat)`; that is a separate design discussion blocked on
  the per-head substrate landing first.

## Why these choices

### Substrate layering follows existing package boundaries

The existing package split — `cas-core` for symbolic AST, `bigfloat`
for arb-prec real + complex arithmetic, `quadrature` for float64
numeric, `meijer-core` for Meijer-G — already encodes the determinism-
tier separation and the algorithmic-substrate locality. Putting
per-head modules inside each respective package preserves: (a) the
type-locality discipline (BigFloat lives where BigFloat lives), (b) the
tier separation (numerical and arbprec do not mix in a single import
graph), and (c) the per-package literate-prose top-of-file context
(CLAUDE.md Rule 10). A unified `@workbench/special-eval` package would
collapse these axes into one tangled dependency knot.

The wire surface (`tools/special-eval`) is *separately* unified because
the agent's mental model is per-head ("I want erf at 50 digits"), not
per-tier ("I want the arb-prec subsystem"). The tool dispatches across
tiers behind one `--head` flag, keeping the agent's experience clean.

### Why the Borel form (DLMF 7.6.2), not the textbook Maclaurin (7.6.1)

R2's critical finding: DLMF 7.6.1 (alternating signs) cancellates
catastrophically when `|z|² > p`. For `z = 5`, ~5 bits gone; for
`z = 20`, ~580 bits gone. The Borel-summed form 7.6.2 has all-positive
terms (after pulling out `e^{-z²}·z`), zero alternation, single ratio-
based term recurrence `term_{n+1} = term_n · z² / (n + 1/2)`. mpmath
uses 7.6.2 internally; we adopt for the same numerical reason. This
choice is *the* load-bearing R2 decision and is documented in the
substrate's top-of-file algorithm narrative.

### Why `bigErfc` and `bigErfcx` are independent implementations, not derived

Mirrors the `expm1` / `log1p` discipline in `transcendental.ts`: for
`|x| > x_c`, computing `1 - erf(x)` discards `x² log₂ e` bits in the
subtraction; computing `exp(x²) · erfc(x)` round-trips through an
intermediate that overflows `Number` (avoidable in BigFloat, but
relative precision still suffers). Each function has its own
algorithmic path on its own input range. This is the *single non-
obvious discipline* the v0.1 implementer must internalise; the top-of-
file algorithm comment is explicit about it.

### Why Karbach-Weideman for complex, not Poppe-Wijers or Algorithm 916

Karbach 2014's `(τ_m, N)` truncation parameters have closed-form prec-
dependence derived from the "highest Fourier coefficient < ε"
criterion: `τ_m(p) = √(4(p ln 2 − ln 4))`, `N(p) ≈ (τ_m/π) · √(p ln 2)`.
At `p = 53`: `(12, 23)` — matches Karbach's published double-precision
numbers exactly. Poppe-Wijers' `nu` is empirically fitted to double
precision; extending to arbitrary precision requires re-fitting.
Algorithm 916 is excellent at float64 (Faddeeva-Johnson's choice for
the bulk region) but has no published prec-scaling. Karbach is the
unique algorithm where prec-scaling is *part of the published
derivation*, not bolted on. Inner loop is `N` complex Horner steps —
same performance class as our existing `clgammaStirling` (cgamma
substrate exemplar).

### Why SunPro 1993 for float64, not anything else

The Sun Microsystems 1993 algorithm is byte-identical across glibc,
musl, FreeBSD, NetBSD, and Apple's libm — five major libms in
production. ≤ 1 ULP `erf`, ≤ 2 ULP `erfc`. In service 33 years; the
coefficient tables have been validated against every conceivable
input pattern. A port is *literal C-to-TS line-by-line translation*
with two changes: float64 arithmetic stays float64 (V8 inherits the
exact semantics), and the `SET_LOW_WORD` mantissa truncation becomes a
4-line `DataView` helper. No in-house algorithm risk; no derived
algorithm risk; ULP accuracy claims are the canonical reference for
the entire libm ecosystem.

### Why `zInverse` as a closure on the forward bridge

The naive backward bridge would compute `√(g.z)` to recover the head's
original `args`. This exposes the multi-valued root branch — `√(z²)`
is `|z|`, not `z`, so the round trip `headToMeijerG(Erf, [-1])` →
`meijerGToHead(...)` returns `Erf(1)`, not `Erf(-1)`. R4's `zInverse`
closure sidesteps this: the forward bridge records the original `args`
in a closure on the `ForwardBridge` record; the backward bridge calls
`zInverse()` to recover them byte-identically. This is the literal
implementation of "byte-identical round-trip" and it requires no
multi-valued root handling.

### Why the wire tool annotates per-output tier conditionally

The single wire tool covers both `numerical: true` (float64) and
`arbprec: true` (BigFloat/BigComplex) outputs, dispatched by the
`--precision` value at invocation. Annotating both flags as static
tool metadata is honest because the provenance writer checks the live
output's tier (per the ADR-0035 §"Determinism contract is tiered"
precedent — same tool, different-tier outputs on different inputs).
This avoids splitting into `tools/special-eval-arbprec` and
`tools/special-eval-float64` for what is, from the agent's perspective,
a single conceptual operation.

### Why ADR-0023 amends rather than a new vocabulary ADR

`Erfi` is a single closed-form head with a single diff rule and a
single Meijer-G representation — no design controversy, no list-
parameter ambiguity, no derivative-rule chain. ADR-0023's "closed
vocabulary, not open registry" discipline says vocabulary expansions
require a deliberate edit + an ADR; an *amendment* to the existing ADR
(a one-paragraph addition under §"Decision" noting the table now has
28 entries including Erfi) is the right granularity. A new ADR would
imply a larger design question that doesn't exist here.

### Why oracle landmines are pinned in adapter code, not deferred

R5 surfaced three landmines, each of which is a 30-minute debugging
session for a future agent if not caught up-front. Pinning them in the
adapter implementation (Decision 8) keeps Phase 1 (G2–G7) deterministic
and prevents the "Wolfram returned 16 digits, what happened" loop.

### Why we don't gate on Arb installation

Arb is a `apt install` away on this Linux box, but the user has not
been asked. The substrate ships correctly without it; the cross-
validation chain is meaningfully weaker (complex arb-prec is single-
engine-paired). Algebraic self-checks (`erf(z*) = conj(erf(z))`,
`erf + erfc = 1`, parity) supplement adequately for the v0.1 claim of
"world's best." Future bead can promote Arb to a hard prerequisite
when the corpus complexity demands the rigorous ball-arithmetic
ground truth.

## Acceptance

This ADR is *accepted* when:

- ADR file written (this document).
- Bead `ss5o` (A0) closed with "ADR-0040 landed; Phase 1 unblocked"
  notes referencing this file.
- Phase 1 beads (G1–G8) lose their `blocked-by:ss5o` dependency edge
  (verified via `bd ready` listing G1 as claimable).
- Worklog shard 131 (or its successor) cites this ADR by number.

The *substrate* this ADR pins is implemented when:

- All Phase 2 beads (I1–I6, I6a) closed.
- `bun run check` green.
- Golden-master suite (Phase 1 G2–G7) byte-identical against
  `@workbench/bigfloat::bigErf*` at 50 and 200 decimals (gold tier:
  Wolfram + mpmath); byte-identical at 50 decimals against Boost
  `cpp_bin_float<50>` for real (silver tier); ULP-distance ≤ 2 vs
  SciPy / libm / Julia for `erfFloat64*` (bronze tier).
- Property tests (V1) green with mutation-proving completed for each
  invariant (`erf(-z) = -erf(z)`, `erf(z̄) = conj(erf(z))`, `erf(0) = 0`,
  `erf(∞) = 1`, `erfc + erf = 1`, `erfcx · exp(-x²) = erfc`,
  `w(z) · exp(z²) = erfc(-iz)`, idempotence of identity rewriter, foreign
  pass-through, byte-identical determinism on the symbolic + arb-prec
  tiers, bit-equality-given-platform-fingerprint on the numerical tier).
- `tools/special-eval --head=erf --precision=200 --re=1.23 --im=0`
  returns a 200-bit BigFloat byte-identical to Wolfram's
  `N[Erf[Rational[123,100]], 60]` truncated to 200 bits.
- Meijer-G bridge round-trip property holds byte-identically for Erf /
  Erfc / Erfi against the canonical G-forms in R4 §1; returns `null`
  byte-identically for `Erf⁻¹` / `Erfc⁻¹`.

The *pattern* this ADR pins generalises when:

- A second head (Bessel J is the natural candidate) ships through the
  same five-layer architecture without architectural changes — only new
  per-head modules in the existing landing sub-directories.
- ADR-0023 deferred-table entries for Whittaker, ParabolicCylinder,
  Legendre/Laguerre/Chebyshev/Gegenbauer, LerchPhi (beads `zmfs`,
  `5e1i`, `4eze`, `h6o1`) retire as the substrate fills out.

When all of the above hold, the Erf head is the reference implementation
the workbench's "world's best" claim rests on.
