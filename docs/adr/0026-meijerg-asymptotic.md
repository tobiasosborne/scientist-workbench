# ADR-0026 — `meijer-core` Braaksma asymptotic layer (Layer 6, v0.1)

**Status:** Accepted — 2026-05-08
**Beads:** `scientist-workbench-hv0.9` (this ADR + the
`packages/meijer-core/src/asymptotic.ts` kernel + the
`tools/meijer-g-asymptotic-only` wire wrapper); parent epic
`scientist-workbench-hv0` (problem-13 Meijer G mega-test).
**Related:** ADR-0020 (arb-prec tier — every numerical layer in
this stack inherits the bit-deterministic-cross-platform-given-
precision contract). ADR-0021 / ADR-0022 (BigComplex G7K15 driver
— the contour layer the asymptotic complements; we share the
`MeijerG…Result` envelope conventions). ADR-0025 (Layer 4 symbolic
dispatch — the asymptotic kernel is the *numerical* sibling to be
dispatched to when |z| is large). ADR-0010 (`defineTool` /
`runTool` shape — the wire wrapper). ADR-0003 (three output
categories; refusal on Stokes lines / secondary sectors is a
*boundary failure*, tagged).
**References:**
- B. L. J. Braaksma 1964. "Asymptotic Expansions and Analytic
  Continuations for a Class of Barnes-Integrals." *Compositio
  Mathematica* **15**: 239–341. The foundational paper. The
  asymptotic theorem (§2-3) gives the connection between the
  Mellin–Barnes contour and the formal asymptotic series, with
  explicit sectorial conditions and Stokes-line connection
  coefficients.
- R. B. Paris & D. Kaminski 2001. *Asymptotics and Mellin–Barnes
  Integrals.* Cambridge University Press, ISBN 0-521-79001-8. §2
  redoes Braaksma's theorem in modern notation; §2.3 gives the
  explicit `H_{p,q}` and `E_{p,q}` formal series and the
  Stokes-multiplier table.
- A. B. Olde Daalhuis & F. W. J. Olver 1995. "Hyperasymptotic
  Solutions of Second-Order Linear Differential Equations I."
  *Methods Appl. Anal.* **2**: 173–197. The hyperasymptotic
  refinement that recovers exponentially-small terms across Stokes
  lines. **Out of scope for v0.1**; named here so the follow-up
  bead's grounding is pinned.
- Y. L. Luke 1969. *The Special Functions and Their Approximations,
  Vol. I.* Academic Press, §5. Working-formula treatment of the
  Meijer G asymptotic for the case `p ≤ q` algebraic series.
- NIST DLMF §16.11. *Asymptotic Expansions of Generalized
  Hypergeometric Functions.* The contemporary public reference.
  Equation 16.11.2 defines the algebraic formal series
  `H_{p,q}(z)`; equation 16.11.3 the exponential `E_{p,q}(z)`.
  §16.11(iii) tabulates the regime-by-regime combinations.
- F. W. J. Olver 1974/1997. *Asymptotics and Special Functions.*
  AKP Classics. §3.7 gives the optimal-truncation rule
  ("superasymptotic"): truncate at the term whose magnitude is
  smallest; the achieved error is of order that minimal term.

## Context

Layer 6 of the seven-layer Meijer G stack
(`tstournament/.../PLAN.md` table row 6). Three numerical paths
are now in place:

- Layer 3 (Slater residue summation, `slater.ts`, `hv0.5`): **convergent**
  in the regime where one of two formal series has finite radius
  of convergence. Cheap when applicable.
- Layer 5 (Mellin–Barnes contour quadrature, `contour.ts`, `hv0.8`):
  direct numerical integration on a vertical contour. Works
  whenever the integrand decays (`2(m+n) > p+q`); independent of
  `|z|`. Expensive at large `|z|` because the integrand peak
  shifts and the truncation T grows like `precision · log|z|`.
- **Layer 6** (this ADR, `asymptotic.ts`, `hv0.9`): the asymptotic
  far-field path. When `|z|` is large enough that Slater Series
  diverges or the contour quadrature is exponentially expensive,
  the **Braaksma 1964 sectorial asymptotic expansion** gives a
  formal series that — truncated optimally — produces an answer
  to a fixed number of digits in `O(precision)` work, no
  `|z|`-dependence beyond the truncation index.

The *full* Braaksma theorem is genuinely complicated:

1. The asymptotic expansion has both an **algebraic part** (formal
   series in `z^{-1}` with `z^{-a_h}` prefactors) and an
   **exponential part** (terms of the form `z^{ν} exp(κ z^{1/κ})`
   with `κ = q − p + 1`, `p < q+1` only).
2. The **connection coefficients** between the Meijer G value and
   the formal series depend on which **sector** of the complex
   `z`-plane `arg z` lies in, with **Stokes lines** at boundaries
   where exponentially-small terms switch on/off discontinuously
   (the Stokes phenomenon).
3. **Hyperasymptotics** (Olde Daalhuis–Olver 1995): even within a
   sector, the optimally-truncated asymptotic series has an
   error of order the smallest-term magnitude, which is not zero;
   recovering further accuracy across Stokes lines requires the
   hyperasymptotic refinement.

Implementing the full theorem in one session is unrealistic. This
ADR pins the **v0.1 scope**: the algebraic dominant asymptotic
in the **principal sector**, with **structured refusal** on
Stokes lines, in secondary sectors, and for the symmetric `|z|
→ 0` regime (which would use the same machinery flipped).

## Decision

### 1. v0.1 scope: principal-sector algebraic asymptotic only

The **principal sector** is the open sector around the positive
real `z` axis where the algebraic series alone is asymptotic to
`G(z)` *with no exponential corrections*. Concretely (DLMF
§16.11.7, Paris–Kaminski Theorem 2.1):

- For `p ≤ q − 1`: the algebraic series `H^{m,n}_{p,q}(z)` is
  asymptotic *throughout* `|arg z| < π`, no Stokes lines (the
  exponential terms are subdominant in every sector). v0.1 handles
  this regime directly.

- For `p = q`: the algebraic series is asymptotic in
  `|arg z| < π` *modulo* an exponential `E_{p,q}(z)` term that
  contributes when `arg z` enters certain sub-sectors. v0.1
  handles the principal sub-sector `|arg z| ≤ π/2` where the
  exponential is subdominant; refuses outside.

- For `p > q`: the **Borel-divergent** regime; Slater Series 2
  *itself* is the algebraic asymptotic series. Direct
  application of the Series-2 formula at fixed truncation index
  (rather than as a convergent sum) gives the dominant
  asymptotic. v0.1 handles this regime via a re-shaped
  `evaluateSeries2` that reads "treat as asymptotic, truncate
  optimally" rather than "sum to convergence."

The unifying pattern: in every regime above, **the algebraic
asymptotic is a sum of `n` (the upper-pole count) formal series
in `1/z`, each multiplied by `z^{a_h - 1}` for `h = 1..n`.**

The **n-pole formula** (Paris–Kaminski 2.2.4, DLMF 16.11.2 form,
Luke §5.10):

```
       n
G(z) ~ Σ  z^{a_h - 1} · S_h(1/z)
       h=1
```

where for each `h ∈ [1, n]`:

```
                ∞
   S_h(w) =    Σ   c_{h,k} · w^k                       (formal in w = 1/z)
               k=0
```

with coefficient recurrence `c_{h,0} = A_h` (the Slater Series-2
prefactor — same Γ-product), and `c_{h,k+1}` derived from
`c_{h,k}` by the rising-factorial recurrence implied by the
Mellin–Barnes integrand at the `(a_h + k)`-th pole:

```
                   (1 + a_h - b_1)_k · ... · (1 + a_h - b_q)_k         1
   c_{h,k} = A_h · ───────────────────────────────────────────  · ────────  · sign
                   (1 + a_h - a_1)_k · ... · (1 + a_h - a_p)_k       k! z^k
                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                            (skip j=h in the denominator)
```

This is **exactly the inner pFq of Slater Series 2 read
term-by-term** — the formula `slater.ts` implements as a
*convergent* sum we now read as an *asymptotic* sum truncated at
the optimal index.

This unification is why the new layer is small (~400 LOC):
the recurrence machinery already exists in `evaluateSeries2`;
we add the truncation logic and the sector classifier.

**The full Braaksma combination** with the `H^{m,n}` algebraic
series (different prefactor than Series 2 when `n < p`) and the
`E^{m,n}` exponential series for full Stokes-line treatment is
follow-up work (`hv0.9.1`–`hv0.9.4` beads).

### 2. Optimal-truncation rule (Olver §3.7)

For the formal series `Σ c_{h,k} / z^k`, the term magnitudes
`|t_k| = |c_{h,k}| / |z|^k` decrease until some optimal index
`k* = k*(h, params, |z|)` where they start increasing again
(divergent series). The **superasymptotic error** at truncation
`k*` is of order `|t_{k*+1}|` — the smallest term.

```
   error_estimate ≈ |t_{k*+1}|       (Olver Lemma 3.7.1)
```

Algorithm:

1. Iterate the recurrence `c_{h,k+1}/c_{h,k} =
   ratio_h(k) / z` where `ratio_h(k)` is a Pochhammer ratio.
2. Track `|t_k|`; stop at the first `k` where `|t_{k+1}| ≥
   |t_k|` (the geometry has turned around).
3. Truncated sum is `Σ_{j=0}^{k} c_{h,j} / z^j`; reported error
   estimate is `|t_{k+1}|`.

If `k = 0` already shows `|t_1| ≥ |t_0|`, the series is in the
"asymptotic-too-divergent" regime (`|z|` not large enough);
refuse with `non-asymptotic-regime`.

### 3. Sector classifier

Three sector classes:

- **principal**: `|arg z| < π/2` for the easy `p ≤ q − 1` and
  `p > q` regimes; `|arg z| < π/2` for `p = q` (cap conservative
  to avoid the Stokes line at `arg z = ±π/2`).
- **stokes**: `arg z` within `precision_dependent_band` of a
  Stokes line at `±π/2` (for `p = q`) or at `±π/(q − p + 1)` (for
  the exponential regime when `p < q`). The band width is set
  to `2^{-precision_bits/4}` — small enough that legitimate
  inputs aren't caught, large enough that genuinely-near-Stokes
  inputs are flagged.
- **secondary**: `|arg z| > π/2` (or the equivalent for the
  parameter regime) — the v0.1 dominant-balance is no longer
  valid; full Braaksma theorem is needed. Refuse.

### 4. I/O envelope (mirrors `MeijerGContour…`)

```ts
export type MeijerGAsymptoticResult =
  | MeijerGAsymptoticSuccess
  | MeijerGAsymptoticRefusal;

export interface MeijerGAsymptoticSuccess {
  readonly status: "success";
  readonly value: BigComplex;
  readonly achievedPrecision: number;
  readonly method: "braaksma-algebraic";
  readonly nTerms: number;             // total summands across all n series
  readonly optimalTermIndices: readonly number[];   // per-h optimal k*
  readonly errorEstimate: BigFloat;    // sum of per-h |t_{k*+1}|
  readonly sector: "principal";
  readonly workingPrecision: number;
  readonly warnings: readonly string[];
}

export interface MeijerGAsymptoticRefusal {
  readonly status:
    | "stokes-line"
    | "secondary-sector"
    | "small-z"
    | "non-asymptotic-regime"
    | "no-pole-residues"
    | "input-error";
  readonly reason: string;
}
```

Mirrors `MeijerGContourResult` from `contour.ts` line-for-line.
Naming preserves the "method" field from the existing layers'
shape (`slater-series-1` / `slater-series-2` / `mellin-barnes` /
`braaksma-algebraic`).

### 5. Wire-tool contract (`tools/meijer-g-asymptotic-only/`)

Same shape as `tools/meijer-g-slater-only`:

- `arbprec: true` — inherits the standard `--precision=<int>`
  flag; default 50 dps.
- Input schema: `record { an, ap, bm, bq: list<bigcomplex>, z: bigcomplex }`.
- Output: `record { value: bigcomplex, achieved_precision,
  method, n_terms, optimal_term_indices, error_estimate: bigfloat,
  sector, working_precision, warnings }` for success;
  `tagged "meijer-g-asymptotic-only/<class>" record { reason }`
  for refusal.

### 6. Determinism contract: `arbprec: true`

Every operation bottoms out in `BigInt` arithmetic via the
bigfloat / bigcomplex substrate. The recurrence is deterministic
given the inputs; the optimal-truncation finder is `<` on
BigFloats (deterministic). So same `(params, z, precision)` ⇒
same output bytes, forever, on any platform — the strongest
contract `arbprec` provides.

### 7. What v0.1 explicitly does NOT do (deferred to follow-ups)

- **Full Braaksma theorem with E_{p,q} exponential terms** —
  needed for `p ≤ q − 2` regimes where the answer involves
  oscillatory exponentials, and for the `p = q` Stokes-line
  switching. Filed as `hv0.9.1`.
- **Stokes-line connection coefficients** — `hv0.9.2`. Recovers
  the exponentially-small terms across `arg z = ±π/2` (for
  `p = q`) and across other sector boundaries.
- **Olde Daalhuis–Olver hyperasymptotic refinement** — `hv0.9.3`.
  Recovers exponentially-small accuracy across Stokes lines via
  Borel-resummation. Multiple-session-scale.
- **Symmetric `|z| → 0` asymptotic** — `hv0.9.4`. Uses Series 1
  read asymptotically when the convergent radius is too narrow.
- **Secondary sectors `|arg z| > π/2`** — `hv0.9.5`. Requires
  the connection-coefficient table that depends on the full
  `(m, n, p, q)`-shape.

These are honest scope cuts, not hidden bugs: each refusal class
above has a structured envelope and a clear reason. The
top-level dispatcher (`hv0.10`) routes to contour quadrature
when asymptotic refuses and contour can handle the input
(typical case for moderate `|z|`); when both refuse the user
sees a structured `tagged "meijer-g/out-of-region"` envelope.

## Why these choices

### Why "algebraic only" in v0.1, not the full theorem

Three constraints: (1) one-session budget; (2) the full Braaksma
theorem's connection coefficients are tabulated rather than
derived — translating the table from primary literature is at
least as much work as the algorithmic core; (3) the user-stated
brief is "v0.1 dominant-balance asymptotic in the principal
sector with structured refusal." The algebraic-only subset is
what the brief authorises, no more.

The honest-scope refusal envelope (Stokes-line / secondary-sector
classes) means a v0.1 caller knows exactly when the answer is
trustworthy and routes to the contour quadrature otherwise. The
top-level dispatcher (hv0.10) composes asymptotic-first →
contour-fallback for inputs the asymptotic refuses; this gives
correct answers throughout the `(m, n, p, q, z)` parameter space
even though the asymptotic alone covers only the principal
sector.

### Why optimal-truncation, not fixed precision-targeted truncation

The asymptotic series is **divergent**. Its terms first decrease
geometrically (~`|z|^{-1}` ratio), reach a minimum at the
"optimal" index `k* ≈ |z|` (for clean cases), then grow
factorially. Truncating earlier than `k*` gives a worse-than-
necessary error; truncating later than `k*` gives a *worse*
result (because the divergent tail starts to dominate). The
Olver §3.7 rule — "stop when terms turn around" — is the
canonical and only correct choice.

The error estimate `|t_{k*+1}|` is the load-bearing diagnostic:
when it exceeds `10^{-precision}`, the user-targeted precision is
not achievable in the principal sector with v0.1's algebraic-only
algorithm. Refuse with `non-asymptotic-regime` and route to the
contour layer.

### Why the n-pole formula for the algebraic part, not the m-pole formula

The classical Braaksma theorem distinguishes two formal series:

- `H^{(left)}_{p,q}(z)` = sum over the `m` lower-pole residues
  `s = -b_h - k`. Asymptotic for `|z| → 0`.
- `H^{(right)}_{p,q}(z)` = sum over the `n` upper-pole residues
  `s = a_h + k - 1`. Asymptotic for `|z| → ∞`.

v0.1 ships the right-pole (n-pole) version because that's the
`|z| → ∞` regime — the named target of the bead. The m-pole
version (`|z| → 0` symmetric) is `hv0.9.4`.

### Why mirror `MeijerGContourResult` exactly, even where fields differ

The hv0.10 dispatcher reads the result envelope to decide
"success or fallback?" It must dispatch by `result.status` and
read the `method` field for provenance — and it must do so *via
a single switch* across the three numerical layers' return
shapes. The mirror discipline (same field names, same status
enum vocabulary, same wire-tool refusal-tag pattern) makes the
dispatcher's compose code one switch statement instead of
three. Pre-emptive mirror = lower hv0.10 cost.

The fields where asymptotic *uniquely* needs different
information (`optimalTermIndices`, `errorEstimate`,
`sector`) are added to the success record but the *common
shape* (`status, value, method, achievedPrecision,
workingPrecision, warnings`) is byte-identical.

### Why `optimalTermIndices` is per-h not summary

Each of the `n` upper-pole series can hit its optimal truncation
at a different index `k*_h`, because each has a different
prefactor and recurrence ratio. The aggregate "summary index"
loses information that's diagnostically useful (which series is
dominant?). We keep the per-h list and let the caller aggregate
if they want a scalar.

## Pointers

- Kernel: `packages/meijer-core/src/asymptotic.ts`.
- Wire wrapper: `tools/meijer-g-asymptotic-only/`.
- Tests: `packages/meijer-core/test/asymptotic.test.ts` plus
  `asymptotic-mpmath.test.ts` and `asymptotic-mutations.test.ts`
  per the discipline shipped in `dispatch.test.ts` (worklog 076).
- Worklog shard: `docs/worklog/077-meijerg-asymptotic.md`.
- Campaign log: `tstournament/ts-bench-infra/problems/13-meijer-g/
  WORKLOG-13.md`.
- Predecessor ADRs: 0020 (arbprec tier), 0022 (BigComplex
  contour driver), 0025 (symbolic dispatch).
