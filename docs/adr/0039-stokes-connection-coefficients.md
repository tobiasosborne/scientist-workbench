# ADR-0039 — Stokes connection coefficients and the algebraic-asymptotic split

**Status:** Proposed — 2026-05-15. Amended 2026-05-16 (regime-decision narrowing per `43i` implementation; see §D1). **Amended 2026-05-16 (ulze): §D3 connection-formula assembly retracted — `H_workbench(z) = G(z)` directly on the principal Riemann sheet for v0.1-scope shapes, see §D3 amendment block and new §D6 / §D7.** **Amended 2026-05-16 (atip): §D6 implemented — `degenerate-principal-sector` refusal for κ ≥ 3 ∧ δ ≤ 0; κ=1 path unchanged (Slater 1966 §5.5 makes H = G as a convergent formula regardless of δ). See §D6 amendment 1 and §D7 update.**
**Beads:** `scientist-workbench-43i` (hv0.9.1, Fox-H algebraic-prefactor / divergent-truncation fix for `n < p`). `scientist-workbench-egf` (hv0.9.2, Stokes-multiplier table for `p = q` and `p ≤ q − 2`). This ADR is the spec both beads cite.
**Authors:** tobiasosborne + Claude Opus 4.7 (1M context, orchestrating).
**Related:** ADR-0026 (Braaksma far-field asymptotic — §7 deferred-scope text where `hv0.9.1`/`hv0.9.2` were filed); ADR-0027 (dispatcher — the `canUseAsymptotic` predicate this ADR widens); ADR-0020 (arbprec tier — the bit-identical-cross-platform contract this ADR inherits); `docs/refs/dlmf-16-11.md` (the local canonical reference written alongside this ADR; every formula in scope is cited there by DLMF + Paris-Kaminski equation number).

## Context

`packages/meijer-core/src/asymptotic.ts` (v0.1, ADR-0026) implements the right-closing Slater-Series-2-read-asymptotically formula. It covers the "happy path" of the Braaksma theorem: `n ≥ 1`, `|z| ≥ 1`, `|arg z| < π/2 − π/64` (a conservative principal-sector cap). Outside that envelope it emits structured refusals (`stokes-line`, `secondary-sector`, `small-z`, `non-asymptotic-regime`, `no-pole-residues`, `input-error`). The conservative cap, the `stokes-line` refusal class, and the absence of any `E_{p,q}(z)` code path are explicitly named in ADR-0026 §7 as deferred work, filed as `hv0.9.1`-`hv0.9.5`.

Two deferred sub-tasks are now in scope. The bead titles initially appeared to overlap and were clarified during the audit phase that produced `docs/refs/dlmf-16-11.md`:

1. **`43i` (hv0.9.1).** The current `residuePrefactor` in `asymptotic.ts:457-494` computes the **full** `B_h^{m,n}_{p,q}` from DLMF 16.11.2 — including the products over `ap` and `bq`. **The prefactor is structurally correct.** What is *not* correct is the optimal-truncation finder in `asymptotic.ts:367-435`: it implements Olver's "stop at the smallest term" rule (`asymptotic.ts:412-420`) which works for convergent or mildly-asymptotic inner ${}_pF_{q-1}$ series but fails for the genuinely divergent regime that arises when `n < p` and `κ = q − p + 1 ≥ 1`. Paris-Kaminski Theorem 2.2 (p. 53) gives the rigorous optimal-truncation index $N^* = \lfloor |\kappa z^{1/\kappa}| \rfloor$ for the divergent case.

2. **`egf` (hv0.9.2).** The exponential series $E_{p,q}(z)$ from DLMF 16.11.3 — present nowhere in code today — is mandatory in the asymptotic expansion whenever $\kappa \le 1$ (i.e. $p \ge q$) regardless of sector, and across Stokes lines for $\kappa \ge 1$. The connection coefficients $\mathcal{S}_k$ from DLMF §16.11(iii) / Paris-Kaminski §2.3 govern *which* exponential contribution is active in each sector and *how* the contribution switches discontinuously (or, with Berry's universal smoothing function, smoothly) across each Stokes line.

The two pieces are sequenced: `egf` depends on `43i` because the Stokes-multiplier table is keyed on a correctly-truncated algebraic series. They are filed as separate beads to permit `43i` to land and be verified independently.

## Decision

### D1 — Scope split between the two beads

**`43i`** replaces `findOptimalTruncation` in `asymptotic.ts:367-435` with a regime-aware variant:

- **Scan-for-smallest-term branch** (all `n = p` cases regardless of `κ`): keep the existing Olver §3.7 scan logic. When the formal inner ${}_qF_{p-1}(z^{-1})$ has a genuine factorial-vs-geometric turnaround (e.g. `κ = −1` anchor cases like $G^{0,2}_{2,0}$), Olver's rule catches it interior to the cap. When the inner series is empirically convergent for moderate $|z|$ (e.g. anchor 5 at $|z| \approx 11$), the scan sums until terms fall below the working-precision floor — required for tier-A precision at modest $|z|$.
- **Paris–Kaminski analytical-N\* branch** (when `n < p` AND `κ ≥ 1`): switch to the analytical truncation index $N^*(h) = \lfloor |\kappa z^{1/\kappa}| \rfloor$ from Paris-Kaminski Theorem 2.2, with the per-pole error bound being the magnitude of the first omitted term. The scan loop is preserved in this branch as a defence-in-depth verifier: if the scanned-minimum index disagrees with $N^*$ by more than a factor of 2 on cap-not-reached cases, emit a `truncation-disagreement` warning into the success record's `warnings` field. PK always wins the truncation decision; the warning is informational only.

**Regime decision rationale.** An earlier draft of this ADR specified the PK trigger as "`n < p` OR `κ ≤ 1`" — the literal Paris–Kaminski divergent-series condition. Implementation revealed that the `n = p` AND `κ = 1` boundary case is empirically *convergent-inner-pFq* at moderate $|z|$ (the formal series in $z^{-1}$ has radius 1 and the inner is convergent for $|z| > 1$): the PK index $N^* \approx |z|$ underestimates the number of terms required to reach user-stated precision when $|z|$ is small. Anchor 5 of the existing test suite ($z = 10+5i$, 25 dps target) needs $\sim$ 25 terms; PK would have stopped at 11 and failed the test. The narrower trigger `n < p AND κ ≥ 1` preserves byte-identical regression on all `n = p` cases while still capturing the genuinely-asymptotic regime `43i` was filed against (the `ap` parameters in the inner pFq introduce additional Gamma factors that drive divergence faster than PK predicts in the convergent-inner case). The implementation comment in `findOptimalTruncation` documents this decision in code.

The dispatcher pre-filter `canUseAsymptotic` in `dispatcher.ts:368-410` gains one regime check: refuse with `non-asymptotic-regime` when `κ ≤ 0` (i.e. `p ≥ q + 1`) AND `n < p`, because in that regime even the optimal truncation diverges and exponential corrections from `egf` are mandatory. (For `n = p` AND `κ = 0`, DLMF 16.11.6 reduces the G-function to a convergent ${}_{q+1}F_q$ and the existing Slater Series 2 path is already correct.)

**`egf`** ~~adds two new code paths and consumes the `43i` foundation~~ **RETRACTED 2026-05-16 — see §D3 amendment block below and §D7.** The original three bullets are kept verbatim for historical context but the entire connection-formula assembly was deleted by bead `ulze`. After the retraction, `egf` reduces to the κ-aware `classifySector` (which is preserved) and the wire-schema labels `method="braaksma-stokes"` / `sector="stokes"` (which are preserved as bookkeeping). The numerical formula in the Stokes-classified path is `H_workbench(z)` alone — the same `assembleAlgebraic` call as the principal path.

The original (retracted) bullets:

- ~~A new module `packages/meijer-core/src/exponential.ts` exporting `evaluateEpq(params, z, sign, workingBits)` that computes $E^{m,n}_{p,q}(z e^{i\,\text{sign}\,\pi})$ via DLMF 16.11.3 with the coefficient recurrence of DLMF 16.11.4-5. The `sign` argument is one of `-1`, `0`, `+1` corresponding to the three branches the connection formula calls for.~~ Deleted by `ulze`.
- ~~A new module `packages/meijer-core/src/stokes.ts` exporting `stokesMultiplier(kappa, sectorIndex, signOfImZ, workingBits)` — a pure function returning the multiplier `S_k ∈ {0, 1, −1, i, −i}` for the (κ, sector, sign) triple in v0.1 scope. The mapping is the closed table from Paris-Kaminski §2.3 Table 2.1, reproduced in `docs/refs/dlmf-16-11.md` §4.4.~~ Deleted by `ulze`.
- ~~The public entry `meijergAsymptotic` gains a connection-formula assembly path: when `classifySector` returns `"stokes"` or `"secondary"`, instead of refusing, the path computes $G^{m,n}_{p,q}(z) = H^{m,n}_{p,q}(z) + \mathcal{S}_0\, E^{m,n}_{p,q}(z) + \mathcal{S}_{-1}\, E^{m,n}_{p,q}(z e^{-2\pi i}) + \cdots$ for the covered $(κ, m, n, p, q)$ regimes.~~ Replaced by `assembleAlgebraic(params, z, z, …, "braaksma-stokes", "stokes")` — identical numerics to the principal path, different wire labels.

The `coverage-gap` refusal tag for κ=2 is **retained** — that's the genuine three-term `H + E^- + E^+` formula (DLMF 16.11.8), filed as `fc83` and outside this ADR's v0.1 scope. The `stokes-band-refused` refusal class is **deleted** (was filed under v0.1 §D5 Option C; without a discontinuous multiplier to smooth there is nothing to refuse on, see §D6 amendment).

### D2 — v0.1 coverage matrix

| Regime | $\kappa$ | $n$ vs $p$ | In-scope for | Method label |
|---|---|---|---|---|
| Current path | $\ge 1$ | $n = p$ | already shipped | `braaksma-algebraic` |
| Algebraic, `ap` non-empty | $\ge 1$ | $n < p$ | `43i` | `braaksma-algebraic` (label unchanged; warnings may surface) |
| Stokes for $p = q$ | $= 1$ | any | `egf` | `braaksma-stokes` |
| Stokes for $p \le q - 2$ | $\ge 3$ | any | `egf` | `braaksma-stokes` |
| Three-term `p = q - 1` | $= 2$ | any | **out** — follow-up bead | refuses `coverage-gap` |
| Divergent algebraic with $\kappa \le 0$ and $n < p$ | $\le 0$ | $n < p$ | out — needs exponentials always; refuses `non-asymptotic-regime` in `43i` | — |
| `n = p$ with $\kappa = 0$ | $= 0$ | $n = p$ | already shipped via DLMF 16.11.6 (Slater path) | — |

The `coverage-gap` refusal is the third refusal class introduced by this ADR (after the existing six). The pre-existing `stokes-line` refusal class **narrows** under this ADR: it remains as the fallback when `egf`'s multiplier table cannot resolve the input (a defence-in-depth path), but in the covered regimes the Stokes-line input is a numerical success.

### D3 — Wire schema extensions (non-breaking)

The output success-record fields `method: string` and `sector: string` (per `tools/meijer-g-asymptotic-only/tool.ts:100-104`) are extended additively:

- `method`: new value `"braaksma-stokes"` — emitted when the connection formula was assembled (algebraic + one or more exponential contributions with multipliers). The existing `"braaksma-algebraic"` is unchanged and continues to be emitted on principal-sector inputs.
- `sector`: new value `"stokes"` — emitted when $|\arg z|$ was inside the Stokes band but the multiplier table covered the regime. The existing `"principal"` is unchanged.

No new top-level wire fields. The `coverage-gap` refusal tag is added to the output-schema union in `tools/meijer-g-asymptotic-only/tool.ts:112-119` and `tools/meijer-g/tool.ts` correspondingly.

### D4 — Determinism contract

`arbprec: true` is preserved end-to-end. Specifically:

- **`carg(z, workingBits)` replaces `Math.atan2(toFloat64(z.im).value, toFloat64(z.re).value)`** in `classifySector` (`asymptotic.ts:240-242`) and in `canUseAsymptotic` (`dispatcher.ts:395-401`). The BigFloat-precision arg already exists at `packages/bigfloat/src/complex.ts:185`. The sign-of-$\Im z$ decision that drives the connection-formula branch (`sign_H = -sign(arg z)`) is read from the BigFloat `carg` return value; float64 casts in this decision are forbidden.
- The Stokes-band width is computed at BigFloat precision: $W = c_W |z|^{-1/(2\kappa)}$ with $c_W = 5$ (giving $\operatorname{erfc}(5) \approx 1.5\times 10^{-12}$ safely below working precision for any reasonable user request). The comparison `|arg z − θ_S| <? W` is a BigFloat comparison.
- The `c_W = 5` constant is part of the input identity for caching purposes: changing it changes the output bytes near the Stokes band. It is documented in `docs/refs/dlmf-16-11.md` §5.4 and is fixed for v0.1; a future ADR can widen it without breaking the contract because it strictly narrows the refusal envelope.

### D5 — Berry smoothing: deferred to follow-up

The Stokes-multiplier transition is mathematically smooth via Berry's universal $\frac{1}{2}\operatorname{erfc}$ profile (Berry 1989). Implementing this requires `bigErfc(x, prec)` — not yet available in `@workbench/bigfloat`. Three options were considered (`docs/refs/dlmf-16-11.md` §6.2):

- **Option A** — implement `bigErfc` via series+asymptotic.
- **Option B** — implement `bigErfc` via incomplete-gamma.
- **Option C** — sharp switch within the band; refuse inputs whose $|\arg z − \theta_S|$ falls inside $c_W |z|^{-1/(2\kappa)}$ when that band exceeds the working precision.

**Choice: Option C for v0.1.** The sharp switch is deterministic, bit-identical, and honest about its scope. The Stokes band shrinks as $|z|$ grows ($\sim |z|^{-1/(2\kappa)}$) so the refusal region is narrow at the asymptotic-relevant magnitudes. A follow-up bead `egf-erfc-bigprec` will implement `bigErfc` and replace the sharp switch with Berry smoothing in a subsequent ADR. The acceptance criterion for `egf` v0.1 is *not* "smooth across the line"; it is "correct on each side of the line, with honest refusal in the smoothing band."

The bench tolerance for inputs near the line under Option C: tier-E. Inputs at $|\arg z − \theta_S| > c_W |z|^{-1/(2\kappa)}$ tighten to tier-A (full working precision).

## Amendments

### Amendment 1 (2026-05-16, bead `43i`) — PK regime narrowed to `n < p AND κ ≥ 1`

See §D1's rationale paragraph. Empirically the `n = p AND κ = 1` boundary case has a convergent inner-pFq where Olver's scan-for-minimum legitimately gains digits past the PK index; the ADR's literal "`n < p` OR `κ ≤ 1`" trigger would have broken anchor 5 ($z = 10+5i$, 25 dps target). Narrowed to `n < p AND κ ≥ 1`.

### Amendment 2 (2026-05-16, bead `ulze`) — §D3 connection-formula assembly RETRACTED

**Empirical finding.** For every `(m, n, p, q)` shape in v0.1 scope with `δ = m + n − (p+q)/2 ≥ 1`, the right-closing Slater residue series $H^{m,n}_{p,q}(z)$ computed by `assembleAlgebraic` is **equal to $G(z)$ everywhere on the principal Riemann sheet** to at least working precision. Verified empirically across shapes `G^{1,1}_{1,1}, G^{2,2}_{2,2}, G^{1,1}_{2,2}, G^{2,1}_{2,2}, G^{1,2}_{2,2}` at mpmath dps=50 with `|G − H_workbench| < 10⁻⁴⁹` at multiple test points spanning both half-planes, near the negative real axis, and past the Stokes line at `arg z = ±π/2`. For κ=3 with δ≥1 the relation holds asymptotically with subdominant `e^{−κ|z|^{1/κ}}` remainder (below user precision for $|z| ≫ 10$).

**Why the original §D3 was wrong.** DLMF 16.11.7-9 give asymptotic formulas $G_{\text{DLMF}}(z) \sim H_{\text{DLMF}}(z \cdot e^{∓πi}) + E(z)$ where $H_{\text{DLMF}}$ is DLMF-16.11.2's *formal asymptotic series for ${}_qF_q$*, NOT the workbench's $H^{m,n}_{p,q}$ (Slater residue *for G itself*, ref doc §2.2). The Stokes multipliers in DLMF 16.11(iii) Table 2.1 compose with DLMF-H, not workbench-H. Applying them to workbench-H adds a fictitious E contribution that the formula doesn't actually contain. At $|z| = 10000$ (golden 19) the spurious contribution is $\sim 10⁻⁴³⁵$ and invisible; at $|z| = 10$ it's $\sim 10⁻⁴$ and visibly wrong (2-6 dps vs 30 dps expected).

**What changed in code (bead `ulze`).** Three modules and ~1500 LOC deleted:
- `packages/meijer-core/src/exponential.ts` — deleted (was the E_{p,q} evaluator).
- `packages/meijer-core/src/stokes.ts` — deleted (was the multiplier table).
- `packages/meijer-core/test/exponential.test.ts` and `stokes.test.ts` — deleted.
- The Stokes-band assembly block in `meijergAsymptotic` (asymptotic.ts ~lines 1297-1450 pre-fix) — replaced with a direct call to `assembleAlgebraic(params, z, z, …, "braaksma-stokes", "stokes")`. Identical numerics to the principal branch, different wire labels.
- The `stokes-band-refused` refusal class — deleted from both `SectorVerdict` and the wire schema (no multiplier to smooth means no band-guard refusal).
- `classifyAroundLine` simplified to a single principal-vs-stokes sign check (no `bandW`, no `subPrecisionThreshold`, no `insideBand`).
- Goldens 17, 19, 20, 21, 22, 23 regenerated against mpmath truth. Golden 17 (G^{1,1}_{1,3} δ=0) **deleted** entirely with a placeholder pointing to bead `atip` (see §D6 below) — the kernel was silently producing values wrong by ~125× for δ≤0 shapes.

**Coverage matrix (post-amendment).** Replaces §D2:

| Regime | κ | δ | Verdict | Numerical formula | Status |
|---|---|---|---|---|---|
| κ=1, δ≥1, principal | 1 | ≥1 | `principal` | `H_workbench(z)` | ✓ shipped (43i + ulze) |
| κ=1, δ≥1, past Stokes line | 1 | ≥1 | `stokes` | `H_workbench(z)` — **same as principal** | ✓ shipped (ulze) |
| κ=3, δ≥1, principal | 3 | ≥1 | `principal` | `H_workbench(z)` | ✓ shipped |
| κ=3, δ≥1, past π Stokes line | 3 | ≥1 | `stokes` | `H_workbench(z)` — **same as principal** | ✓ shipped (ulze) |
| **κ=3, δ=0** | 3 | 0 | currently routes as principal but **wrong** — H_workbench ≠ G | n/a — needs full Braaksma E path | ⚠ pending bead `atip` |
| κ=2 | 2 | any | `out-of-coverage` (`coverage-gap`) | n/a | filed as `fc83` |
| κ≤0 AND n<p | ≤0 | any | refused at dispatcher | n/a | shipped — refuses |

**Wire-schema state (post-amendment).** `method ∈ {"braaksma-algebraic", "braaksma-stokes"}` and `sector ∈ {"principal", "stokes"}` are preserved as bookkeeping — they record which side of the κ-aware classifier the input landed on, even though the numerical formula is the same. The `stokes-band-refused` refusal class is deleted. The `coverage-gap` refusal class is retained (for κ=2).

### D6 — δπ algebraic-sector envelope (bead `atip`, implemented 2026-05-16)

The original §D3 (and pre-`atip` `classifySector`) used `|arg z| < κπ/2` as the principal-sector boundary for κ-aware classification. The math-research diagnosis (worklog 125) surfaced that this is the **E-Stokes geometry** (where E representatives sit), not the **algebraic-sector geometry** (where $H_{\text{workbench}}$ converges to $G$).

The Paris–Kaminski algebraic-sector defect is

$$
\delta = m + n - \tfrac{1}{2}(p + q),
$$

and the algebraic envelope is `|arg z| < δπ` (P&K §2.2.2; reproduced in `docs/refs/dlmf-16-11.md` §2.4). For shapes with δ≤0 the envelope is empty/degenerate and the H-only path is mathematically invalid — H diverges or fails to converge to G.

**Visible casualty (pre-fix).** Golden 17 `G^{1,1}_{1,3}([1/3]; ; [1/2]; [2/3, 3/4] | 50)` has δ=0 and κ=3; the workbench was silently emitting `+4.4×10⁻³` for a true value of `-0.5549...` (wrong by ~125× AND wrong sign). Golden 17 was deleted by `ulze` pending this bead.

#### D6 amendment 1 (`atip` implementation, 2026-05-16)

Implementation **narrowed the refusal to κ ≥ 3** rather than the blanket "refuse all δ≤0" the bead description originally specified. The narrowing follows from the math story for the inner pFq in Slater Series 2:

- **κ = 1** (p = q). The inner is `pFp-1(1/z)` with radius of convergence 1 (DLMF §16.2). For the asymptotic-regime gate `|z| > 1` the inner converges as a normal power series, and Slater 1966 §5.5's q≥p convergence theorem makes the right-closing residue series equal G exactly — δ has no role in the formula's validity. The κ=1 δ=0 shapes (bead 43i's `G^{1,1}_{2,2}`, `G^{1,2}_{3,3}`, `G^{1,3}_{4,4}` family) are **mpmath-verified to 30+ dps** in the shipped test suite; refusing them would deprecate working behaviour for no mathematical reason. Per §D7's empirical observation, these cases hold honestly.

- **κ ≥ 3** (p ≤ q − 2). The inner is `qFp-1(1/z)` with q ≥ p+2 upper > p−1 lower — formally divergent for any z. The algebraic series is asymptotic-to-G inside the envelope `|arg z| < δπ` and breaks down outside it. With δ ≤ 0 the envelope is empty and the asymptotic has no valid sector → refuse with `degenerate-principal-sector`.

- **κ = 2** is already out-of-coverage (`fc83`) and not affected.

For κ ≥ 3 with δ ≥ 1 the algebraic envelope `δπ ≥ π` straddles or exceeds the principal-Riemann-sheet boundary (the branch cut at `|arg z| = π`), so the effective principal-vs-stokes boundary is `min(δπ, π)`. For the common case δ = 1 (e.g. `G^{2,1}_{1,3}`, `G^{3,0}_{1,3}`, the Bessel-K-style reductions) this matches the pre-`atip` `θ_S = π` code byte-for-byte. For higher κ with half-integer δ (κ = 4, 6, …) δπ may be less than π and becomes the active boundary; v0.1 doesn't anchor these with tests.

**Implementation locations:**
- `packages/meijer-core/src/asymptotic.ts:classifySector` — adds `degenerate-principal-sector` verdict (κ≥3 path only) and uses `min(δπ, π)` as the κ≥3 principal/stokes boundary.
- `packages/meijer-core/src/asymptotic.ts:meijergAsymptotic` — plumbs the verdict to a new `MeijerGAsymptoticRefusal.status === "degenerate-principal-sector"`.
- `packages/meijer-core/src/dispatcher.ts:canUseAsymptotic` — adds the same δ≤0 ∧ κ≥3 check upstream so the integrated dispatcher surfaces the refusal without invoking the layer.
- `tools/meijer-g-asymptotic-only/tool.ts` — adds the refusal class to the output schema union and the header comment.
- `tools/meijer-g-asymptotic-only/goldens/17-3-0-…-degenerate-principal-.golden.json` — refusal golden at the exact deleted-golden-17 input.
- `packages/meijer-core/test/asymptotic.test.ts` — adds 5 new tests: classifier κ=3 δ=0, classifier κ=3 δ<0 (half-integer), classifier κ=1 δ=0 admission, layer refusal at the deleted-golden-17 input, layer refusal at κ=4 δ=-1/2.
- `packages/meijer-core/test/asymptotic-mutations.test.ts` — mutation 4b: degenerate principal sector → refuse, not silently emit.

**Out of scope:** the dominant-E Braaksma formula that would lift the refusal for κ≥3 δ≤0 shapes. That is substantial new mathematics — dominant exponential representatives in the algebraic-sector-degenerate regime, distinct from the multiplier-table assembly `ulze` retracted — and remains deferred.

### D7 — Post-amendment summary

After `43i` (Amendment 1), `ulze` (Amendment 2 + §D6), and `atip` (§D6 Amendment 1), the v0.1 state is:

- **κ=1 with δ≥1**: shipped and correct. Inner pFq converges for |z|>1; H = G as a convergent formula. The Stokes-classified branch and principal-classified branch produce identical numerics via `assembleAlgebraic`. The wire labels `method` and `sector` are diagnostic-only (encoding which side of the E-Stokes line at ±π/2 the input landed on).
- **κ=1 with δ=0**: shipped and correct (bead 43i `G^{1,1}_{2,2}`/`G^{1,2}_{3,3}`/`G^{1,3}_{4,4}` tests at 30+ dps mpmath-verified). Promoted from "appears empirically" to "shipped and tested" via the bead-43i mpmath corpus. The math: same as δ≥1 — Slater 1966 §5.5's q≥p convergence theorem makes H = G as a convergent formula irrespective of δ.
- **κ=3 with δ≥1**: shipped and correct. `H_workbench(z) = G(z) + O(e^{−κ|z|^{1/κ}})` with no Stokes-line crossings inside the principal Riemann sheet.
- **κ=3 with δ≤0**: refuses with `degenerate-principal-sector` (bead `atip`, 2026-05-16). Was silently broken pre-`atip`. Lifting the refusal requires the deferred dominant-E Braaksma path.
- **κ=2**: refuses with `coverage-gap`; filed as `fc83`.
- **κ≤0 with n<p**: refuses at dispatcher with `non-asymptotic-regime`; correct (the algebraic series genuinely diverges).
- **κ≥4 (and ≠ 2)**: untested coverage. Half-integer δ is possible; the κ≥3 codepath handles them defensively (`min(δπ, π)` as the boundary, `degenerate-principal-sector` refusal for δ≤0). No anchors exist yet.

The `bigErfc` bead `ybrw` is reconsidered: the multiplier table it was meant to smooth no longer exists. `ybrw` may still be useful for unrelated future work but is no longer the unblocker for any open Stokes-band-refused refusal (those refusals are themselves removed). The bead's notes were updated 2026-05-16 to reflect this.

## Alternatives considered

- **Unify `43i` and `egf` into one bead.** Rejected. The truncation-index fix is meaningful on its own — it improves the existing `braaksma-algebraic` path's precision on `n < p` cases (which directly resolves bead `qlld`'s "Slater Series-2 precision ceiling at $|z| \approx 16$"). Landing it separately gives a verifiable intermediate state, in the spirit of ADR-0019's bench discipline.

- **Use float64 `Math.atan2` inside the Stokes band, with the determinism note in provenance.** Rejected. Float64 `Math.atan2` is IEEE-754-deterministic across platforms in practice, but the sign-of-$\Im z$ decision drives a connection-formula branch whose two arms differ by an *exponentially-divergent* amount in $|z|$ for large arguments. The cost of misclassification is unbounded; the cost of using BigFloat `carg` is one extra arctangent per call (negligible relative to a pFq evaluation). The honest-computation principle (CLAUDE.md rule 8) requires BigFloat.

- **Implement Berry smoothing via `bigErfc` for v0.1.** Rejected as scope creep. The smoothing band is below working precision for any input where $|z| \ge 2^{2\kappa}$ (i.e. $|z| \ge 4$ for $\kappa = 1$), which covers the vast majority of asymptotic-regime inputs. Inputs inside the band at $|z| < 4$ are unusual; refusing them is honest. Option A or B can be implemented later without breaking the wire shape.

- **Cover $p = q - 1$ (κ = 2) in v0.1.** Rejected. The three-term formula $H + E^- + E^+$ (DLMF 16.11.8) is structurally different from the $\kappa = 1$ and $\kappa \ge 3$ cases — different sector geometry, different multiplier values. Bundling it in would double the test surface. Filed as a follow-up bead instead (see Open follow-ups).

## Consequences

**Determinism.** `arbprec: true` is preserved. Bit-identical cross-platform forever given `--precision=N`. The Stokes-band refusal is deterministic at all platforms (same band width from BigFloat arithmetic).

**Bench impact.** Bench cases currently expected-tagged with `meijer-g-asymptotic-only/stokes-line` will need to be re-classified after `egf` lands: those whose $(κ, m, n, p, q)$ falls into the covered regimes become numerical successes (with `method: "braaksma-stokes"`, `sector: "stokes"`); those outside (notably $κ = 2$) keep their refusal expectation but the tag updates to `coverage-gap`. The bench tolerance tier-E applies to inputs inside the smoothing band (Option C refusal); tier-A applies outside.

**Wire compatibility.** Adding new string values to `method` and `sector` is additive. Adding a new refusal tag to the union is additive. **Existing goldens and downstream consumers are unaffected** in any case where the input was already a principal-sector success.

**Mutation-prove discipline.** Per CLAUDE.md rule 6, both beads ship with mutation-prove tests: for `43i`, perturb the $N^*$ formula and confirm a Series-2-precision-ceiling bench case goes red; for `egf`, perturb a multiplier table entry and confirm a Stokes-crossing bench case goes red. Triple-witness verification (mpmath + wolframscript + closed-form benchmarks) per `docs/refs/dlmf-16-11.md` §8.

## Open follow-up beads

Filed alongside this ADR; not in scope for `43i` or `egf` v0.1:

1. **`scientist-workbench-fc83` ($\kappa = 2$, $p = q - 1$).** Three-term connection formula. Mathematically distinct from $\kappa = 1$ and $\kappa \ge 3$. Note (2026-05-16): post-`ulze` retraction, this bead's scope may collapse if `H_workbench = G` also holds for κ=2 with δ≥1 — needs an empirical probe before reopening. If it does hold, `fc83` becomes another "delete `coverage-gap` refusal, route to `assembleAlgebraic`" change.
2. **`scientist-workbench-ybrw`.** ~~Implement `bigErfc(x, prec)` in `@workbench/bigfloat` and switch the Stokes band from Option C (sharp switch + refusal) to Berry smoothing.~~ **Reconsidered 2026-05-16 (ulze):** the multiplier table this would smooth has been deleted; the `stokes-band-refused` refusal class it would remove no longer exists. `bigErfc` may still be useful for unrelated future work but is no longer an `egf`-path blocker.
3. **`scientist-workbench-uaxz`.** Refactor `series.ts`'s `evaluateSeries2` so the prefactor and inner-pFq summation can be invoked separately, eliminating the ~25-line duplication between `series.ts` and `asymptotic.ts:residuePrefactor` noted in the ADR-0026 commentary. Pure refactor.
4. **`scientist-workbench-atip` (P1 bug, filed 2026-05-16, ~~implemented 2026-05-16~~).** δπ algebraic-sector envelope. ~~Currently `classifySector` uses `κπ/2` as the principal-sector boundary; correct is `δπ` (Paris-Kaminski §2.2.2).~~ **Implemented as `degenerate-principal-sector` refusal for κ ≥ 3 ∧ δ ≤ 0 (the narrowed scope — see §D6 amendment 1 for the math story underwriting the κ=1 carve-out).** Lifting the refusal for κ≥3 δ≤0 requires the dominant-E Braaksma path and remains deferred. See §D6.

## References

- DLMF §16.11 — `docs/refs/dlmf-16-11.md` is the local canonical reference, with DLMF equation numbers reproduced verbatim.
- Paris, R. B. & Kaminski, D. (2001). *Asymptotics and Mellin-Barnes Integrals*, Cambridge University Press. §2.2-2.3 (algebraic + exponential series), §6 (Berry smoothing). Theorems 2.2 and 6.1 cited explicitly.
- Berry, M. V. (1989). "Uniform asymptotic smoothing of Stokes's discontinuities," *Proc. R. Soc. Lond. A* **422**, 7-21.
- ADR-0026 §7 — original deferred-scope filing for `hv0.9.1`-`hv0.9.5`.
- `packages/meijer-core/src/asymptotic.ts:215-253` (`classifySector`), `:367-435` (`findOptimalTruncation`), `:457-494` (`residuePrefactor`), `:529-565` (refusal envelope).
- `packages/meijer-core/src/dispatcher.ts:368-410` (`canUseAsymptotic`).
- `tools/meijer-g-asymptotic-only/tool.ts:89-119` (input/output schemas).
- `packages/bigfloat/src/complex.ts:185` (`carg`, the BigFloat-precision arg).
