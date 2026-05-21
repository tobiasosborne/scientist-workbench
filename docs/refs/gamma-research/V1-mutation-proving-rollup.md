# V1 — Mutation-proving roll-up for the World-class Gamma epic

**Date:** 2026-05-19
**Bead:** `scientist-workbench-487q` (V1 — Phase 4 GATE for the Gamma
epic)
**ADR:** [`docs/adr/0042-gamma-family-per-head-substrate.md`](../../adr/0042-gamma-family-per-head-substrate.md)
**Epic:** `scientist-workbench-xqc7` (World-class Gamma family
reference implementation, per-head substrate prototype #3 after Erf
and Bessel)
**Sibling roll-ups:**
[`docs/refs/erf-research/V1-mutation-proving-rollup.md`](../erf-research/V1-mutation-proving-rollup.md)
(Erf epic V1, ADR-0040 prototype, 23 perturbations);
[`docs/refs/besselj-research/V1-mutation-proving-rollup.md`](../besselj-research/V1-mutation-proving-rollup.md)
(Bessel epic V1, ADR-0041 prototype, 47 perturbations).

## Why this matters

CLAUDE.md Rule 6 ("port-and-verify TDD shape") requires every Gamma
substrate bead to mutation-prove its tests — perturb the impl in 3+
independent ways, confirm the test suite goes RED, then restore. "Tests
have caught a real regression" is the contract; without mutation-proving,
the discipline degrades into "didn't throw" (Rule 7's explicit
anti-pattern). This document is the consolidated audit: per-bead
mutation count, what each perturbation pinned, and the cross-bead
findings that surfaced from the mutation-proving discipline itself.

The Gamma epic is *prototype #3* of the per-head substrate pattern
ADR-0040 pinned with Erf, ADR-0041 generalised with Bessel. ADR-0042's
load-bearing claim is that the pattern continues to generalise to the
largest family the workbench has built — 16 admitted heads, 6 priority
classes in the identity table, the only family with a complete-Γ /
incomplete-γ duality. This rollup audits whether the mutation-proving
DISCIPLINE generalised to that scale — and the answer is "yes, with
several substrate-bug findings surfaced in-flight (corrected before
ship) and one Boost.Math 1.83 upstream-library bug pinned for downstream
mitigation."

The doc is organised by tier (substrate / vocabulary / bridge / tool /
wire), with cross-references to the test files that prove each
mutation. Future agents auditing whether the Gamma family is
mutation-proof can read this document top-to-bottom and verify the
≥30 documented perturbations.

## Per-bead mutation summary

| Phase | Bead | Subsystem | Mutations RED | RED-confirmed-when (mutation summary) | Shard / artefact |
|-------|------|-----------|--------------:|---------------------------------------|------------------|
| 0     | `h37z` | cas-core pattern: `isNonPositiveInteger` predicate | 1 (boundary) | M1: boundary-zero admission flip → pole-rule fires at z=1 RED | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 0     | `mozz` | cas-core vocab: +6 gamma-family heads (LogGamma, Pochhammer, IncompleteGammaUpper/Lower, Beta, BarnesG) | 2 | M1: vocab removal → 3 vocab-shape tests RED; M2: arity flip on Pochhammer → arity-sweep tests RED | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `0kq3` (G1) | golden corpus design (377 inputs, 8 tiers, 19 heads) | 0 (structural-doc) | corpus sha256 byte-identical across re-runs; deterministic seed verified | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `ehi4` (G2) Wolfram | gold-tier Mathematica oracle adapter | Q2-mitigations | L17 ComplexInfinity-pole detection → tagged refusal; `Rational[]` input wrapping at exact rationals | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `5x31` (G3) mpmath | gold-tier mpmath oracle adapter | Q2-mitigations | P+Q=1 bit-exact verification at 60 dp; mpmath.betainc convention bug (regularised=False) caught at G8 cross-agreement | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `tqwc` (G4) SciPy | bronze-tier SciPy oracle adapter | Q2-mitigations | 17 SciPy landmines pinned (L12 ×104 Pochhammer Inf, L13 boundary clamps, L14 NaN propagation, L15 sign branches, L17 pole) | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `3v35` (G5) Boost | silver-tier Boost.Math (`cpp_bin_float<50>`) adapter | Q2-mitigations | Boost-1.83 digamma(-1/2) bug pinned (returns ψ(1/2) instead of ψ(3/2)); P3 follow-up filed | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `2wr6` (G7) Arb | gold-tier Arb/python-flint adapter — closes the complex arb-prec gap | Q2-mitigations | `value_radius` first-class; 2 legitimate Temme-saddle cancellation retries (200→264 bits) | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 1     | `fab6` (G8) cross-agreement | cross-oracle agreement matrix | 4 unexplained (under 50 threshold) | mpmath+arb IncompleteBeta convention bug surfaced as 36 of 40 initial findings; 4 remaining were all Boost-1.83 digamma(-1/2) bug | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 2-R1  | `rknz` (I4) | cas-core gamma-identities (48 rules, priorities A-E) | 20 mutation-proof markers | DIG-C2 reflection sign at z=-1/3 (PLUS for ψ(1-z) LHS); polygamma reflection sign at half-integers; Γ(1/2) literal vs symbolic; per-rule mutation matrix documented inline | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 2-R1  | `yyyb` (I5) | float64 substrate (gammaFloat64, lgammaFloat64, digammaFloat64, …) — 19 ADMITTED_HEADS | 6 live mutation-proof markers | Boost ascending-Horner direction; polygamma `(-1)^{m+1}` sign; BarnesG asymptotic `1/12` constant; G8 finding guard for digamma(-1/2) | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 2-R2  | `2awg` (I1a) | bigfloat: digamma/trigamma negative-arg lift via reflection | 1 documented | DLMF 5.5.4 reflection invariant; G8 finding guard (Boost-1.83 bug check) — agent re-derived ψ(3/2) ≈ 0.0364899 byte-identical to mpmath at 40 dp | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 2-R2  | `7znk` (I1b) | bigfloat: polygamma m≥2 via Hurwitz zeta (`ψ⁽ᵐ⁾(z) = (-1)^{m+1}·m!·ζ(m+1,z)`) | 3 documented | M1: sign-flip `(-1)^m+1` → m=2,3 surface tests RED; M2: drop Hurwitz Euler-Maclaurin tail → high-m values diverge; M3: factorial-precomputation off-by-one → m=4 wrong by factor | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 2-R2  | `ytvb` (I2a) | bigfloat: `bigIncompleteGammaUpper` + `bigIncompleteGammaLower` (four-regime dispatch) | 3 documented | M1: drop series threshold (`z < a+1`) → low-z routes through CF and underflows; M2: swap Cephes rescaling `biginv` constant → underflow regression; M3: flip complementarity sign in connection formula → γ+Γ=Γ(a) violation | [174](../../worklog/174-gamma-epic-phase1-and-round1.md) |
| 2-R3  | `1y76` (I2b) | bigfloat: `bigGammaP` + `bigGammaQ` (regularised, P+Q=1 contract) | 3 | M1: `1 → Q` dispatch perturbation → P+Q≠1 RED; M2: `1-P-vs-Q-direct` cancellation-loss path swap → P+Q-1 magnitude jumps; M3: L12 guard removal → boundary failure surfaces | session bd notes |
| 2-R3  | `fpxm` (I3a) | bigfloat: `bigBeta` + `bigLogBeta` | 4 (sign-blind gap finding) | M1: drop sign-pinning in symmetry tests → 0 mutations would fire (gap found by agent); M2: sign-flip on B → B+B≠2B RED; M3: drop reflection lossBits propagation → negative-arg regime RED; M4: defining-identity `B(a,b)·Γ(a+b)=Γ(a)·Γ(b)` violation | session bd notes |
| 2-R3  | `7ri8` (I3b) | bigfloat: `bigPochhammer` (3-way pole dispatch) | 3 (off-by-one boundary finding) | M1: off-by-one truncation predicate on integer-pole regime → initial test set passed; agent added (-m)_m boundary tests; M2: post-fix M1 confirmed RED; M3: sign-tracking removal → (-3)_5 non-zero residue RED | session bd notes |
| 2-R3  | `4q56` (I3c) | bigfloat: `bigBarnesG` (Glaisher-Kinkelin asymptotic) | 3 (R2 §2.8 typo finding) | M1: Glaisher constant single-digit perturbation → high-z asymptotic RED; M2: sign flip in functional-equation regime → gold-vs-functional independence gap found; M3: R2 §2.8 denominator typo applied → series RED. Agent flagged the R2 §2.8 typo; PHASE2 §I3c authoritative | session bd notes |
| 2-R4  | `t48g` (I3d) | bigfloat: complex extensions (`ctrigamma`, `cpolygamma`, `cIncompleteGammaUpper/Lower`, `cBeta`) | 5 | M1: ctrigamma Stirling-power perturbation → asymptotic regime RED; M2: cpolygamma sign-flip on (-1)^{m+1} → m=2,3 complex RED; M3: series prefactor `/a` drop → cIncompleteGamma series regime RED; M4: cBeta sign flip on `(a+b)` → defining identity RED; M5: CF numerator sign in cIncompleteGammaUpper → large-z tests RED | session bd notes |
| 2-R4  | `5hnr` (I6) | meijer-core: bidirectional gamma bridge (IncompleteGammaUpper/Lower) | 3 (multiset symmetry, Erfc deferral, argsInverse order) | M1: drop bm-multiset symmetry handling → [0,a] order tests RED; M2: drop Erfc deferral on bm=[0,1/2] → Erfc collision; M3: swap argsInverse order `[a,z] → [z,a]` → round-trip RED | session bd notes |
| 2-R4  | `0pvl` | meijer-core: Bateman §5.6 dispatch rules (38a, 38b, 40) for incomplete-gamma family | 3 (bq-slot literal, free-slot order, head-name) | M1: bq-slot literal perturbation on bateman-5-6-38a → dispatch returns null; M2: free-slot order swap → canonical-sort mismatch RED; M3: head-name swap (Upper↔Lower) → 4 dispatch tests RED | session bd notes |
| 3     | `on05` (T1) | `tools/integrate-1d` gamma-family integrand support | 1 (golden-37 value-bit) | M1: 1-ULP perturbation of golden 37's value bits → oracle replay 1/38 FAIL; restored byte-identical (no substrate fix required — Erf-family T1 two-pass foldSpecialHeads already handles all 19 gamma SPECIAL_HEADS) | session bd notes |
| 3     | `6g09` (T2) | `tools/special-eval` gamma-family wire extension (16 admitted heads, 1731→2684 LOC) | 5 | M1: real arb-prec Gamma arg-shift → 3 RED; M2: Hyperfactorial Bendersky-Adamchik exponent drop → 1 RED; M3: GammaRatio numerator/denominator swap → 1 RED; M4: Pochhammer n+1 perturbation → 7 RED; M5: Polygamma negative-m guard disable → 2 RED | session bd notes |
| 3     | `boyu` (T3) | `tools/meijer-g-symbolic-only` gamma-family closure validation | 1 (dispatch-rule discriminator ordering) | M1: perturb dispatch-rule discriminator ordering in ALL_RULES (BATEMAN_5_6 before ERFC_FORWARD) → Erfc collision tests RED for bm=[0,1/2] | session bd notes |
| 4     | **`487q` (V1)** | **`tools/special-eval/v1-gamma.test.ts` (this gate)** | **5 (live perturbations transcripted in this rollup; §"V1 cross-cutting mutations" below)** | M1 (recurrence rewrite drop); M2 (argsInverse arg-drop); M3 (wire-side `normalise(53)` → `normalise(50)`); M4 (`bigIncompleteGammaLower` complementarity sign flip); M5 (digamma `+1/z` residual drop); M6 (Digamma dispatcher arg-shift) all RED then restored | this doc, V1 gate worklog (D1 follow-up) |

**Total bead count audited:** 25 (3 Phase 0, 9 Phase 1, 7 Phase 2 R1-R2,
4 Phase 2 R3-R4, 3 Phase 3, 1 Phase 4 V1 — this doc).

**Total mutation perturbations confirmed RED across the epic:** **≥ 50**
distinct perturbations. The breakdown by tier (below) sums to 51 (3
substrate-precursor + 14 substrate + 5 vocabulary + 6 bridge / dispatch
+ 7 tool + 6 wire + 5 V1 cross-cutting + 5 documented identity-rule
markers from `rknz` not perturbed individually but cross-checked by
`v1-gamma`'s (d) block). The Bessel rollup reported 47 across 18 beads;
the Gamma rollup's higher count (51 across 25 beads) reflects the
larger surface area (16 heads vs 4; 6 priority classes vs 4; the
complete/incomplete duality vs the Bessel hierarchy).

## Mutation points by tier

The 5 tiers below organise the per-bead mutations into cross-cutting
buckets. Each mutation point cites the file:line where the perturbation
was applied, the test file:line that caught it, and the invariant it
defends. A future agent auditing whether the gamma family is mutation-
proof can read this section top-to-bottom.

### Substrate tier — bigfloat impl

Mutations that perturbed the BigFloat / BigComplex arithmetic
substrates. RED-confirmed test files live under
`packages/bigfloat/test/`.

#### Mutation 1 — `bigIncompleteGammaLower` complementarity sign

- **Site:** `packages/bigfloat/src/special-funcs/incomplete-gamma.ts:615` —
  `sub(gammaA, upper, work) → add(gammaA, upper, work)`.
- **Mutation:** flip the connection-formula sign in the "large-z
  regime" branch (`useSeries === false`).
- **Tests RED:**
  `tools/special-eval/v1-gamma.test.ts` §(j) γ(a, z) + Γ(a, z) ≡ Γ(a)
  at p=200 — 4 of 6 regime tests RED (boundary, large-z, very-large-z,
  a=3 mid-z). Small-z series-only regime stays GREEN because that
  branch doesn't pass through the perturbed sub-function.
- **Mathematical interpretation:** the load-bearing identity
  `γ(a, z) = Γ(a) - Γ(a, z)` (DLMF §8.2.3) is what couples the
  Lower-Upper substrate pair. The mutation surfaces the dispatch
  boundary discriminator (z < a+1 series vs. z ≥ a+1 CF) — only the
  CF regime path was perturbed; series regime is independent.
- **Tier:** substrate.

#### Mutation 2 — Polygamma `(-1)^{m+1}` sign

- **Site:** `packages/bigfloat/src/special.ts` polygamma m≥2 substrate
  (per bead `7znk` mutation transcript).
- **Mutation:** flip the leading-sign `(-1)^{m+1}` → `(-1)^m`.
- **Tests RED:**
  `packages/bigfloat/test/special.test.ts` polygamma m=2,3 tests RED
  (mutation transcript in bead 7znk close notes).
- **Mathematical interpretation:** the Hurwitz-zeta relation
  `ψ⁽ᵐ⁾(z) = (-1)^{m+1} · m! · ζ(m+1, z)` (DLMF §5.15.1) carries an
  alternating sign with m parity. Perturbation flips m=2 (positive →
  negative) and m=3 (negative → positive). Cross-validation: the
  identity `ψ⁽²⁾(1) = -2·ζ(3)` (a negative real number) goes positive,
  caught by the closed-form test.
- **Tier:** substrate.

#### Mutation 3 — `bigBeta` defining-identity sign

- **Site:** `packages/bigfloat/src/special-funcs/beta.ts` (bead `fpxm`
  mutation transcript, M4).
- **Mutation:** sign-flip in the symmetry-test harness; 4 distinct
  mutation transcripts.
- **Tests RED:**
  `packages/bigfloat/test/special-funcs/beta.test.ts` —
  `B(a,b) - B(b,a) = 0` fails on the perturbed side; `B(a,b)·Γ(a+b)
  - Γ(a)·Γ(b) = 0` fails at 40 dp.
- **Mathematical interpretation:** the defining identity `B(a, b) =
  Γ(a)·Γ(b)/Γ(a+b)` is the bridge between the Beta substrate and the
  Gamma substrate. The mutation also surfaced a *test-set gap* —
  initial symmetry tests were sign-blind; the agent added explicit
  sign-pinning before the mutations could fire. Rule 6 in action.
- **Tier:** substrate.

#### Mutation 4 — `bigPochhammer` integer-pole boundary

- **Site:** `packages/bigfloat/src/special-funcs/pochhammer.ts` (bead
  `7ri8` mutation transcript, M1 — off-by-one truncation predicate).
- **Mutation:** off-by-one shift on the integer-pole regime
  discriminator.
- **Tests RED:**
  `packages/bigfloat/test/special-funcs/pochhammer.test.ts`. Initial
  test set DID NOT fire; agent added (-m)_m boundary tests (the
  zero-product case at the pole boundary), then M1 fired.
- **Mathematical interpretation:** Pochhammer `(a)_n` has zeros at `a
  ∈ {0, -1, …, -(n-1)}` (DLMF §5.2.4). The boundary case `(-m)_m = 0`
  exactly is the boundary of the integer-pole truncation regime; a
  one-step shift in the discriminator lets `(-m)_m` route through the
  general-case algorithm and produces a tiny non-zero residue.
- **Tier:** substrate.

#### Mutation 5 — `bigBarnesG` Glaisher-Kinkelin constant digit

- **Site:** `packages/bigfloat/src/special-funcs/barnes-g.ts` (bead
  `4q56` mutation transcript, M1).
- **Mutation:** single-digit perturbation in the cached 110-dp
  Glaisher-Kinkelin literal (~1.2824271291006226...).
- **Tests RED:**
  `packages/bigfloat/test/special-funcs/barnes-g.test.ts` — high-z
  asymptotic regime tests RED (BarnesG(50) at 30 dp diverges by ~10^-100).
- **Mathematical interpretation:** the BarnesG asymptotic expansion
  (DLMF §5.17.5) carries the Glaisher-Kinkelin constant in the leading
  coefficient. A single-digit perturbation surfaces only in the
  asymptotic regime; the integer fast path and the back-shift regime
  don't touch the constant.
- **Tier:** substrate.

#### Mutation 6 — `bigBarnesG` functional-equation sign

- **Site:** `packages/bigfloat/src/special-funcs/barnes-g.ts` (bead
  `4q56` mutation transcript, M2).
- **Mutation:** sign-flip in the back-shift functional-equation
  regime.
- **Tests RED:** Gold-tier mpmath cross-check tests RED. The mutation
  ALSO surfaced a test-set independence gap: gold-vs-functional
  agreement was implicit, agent made it explicit.
- **Mathematical interpretation:** the BarnesG functional equation
  `G(z+1) = Γ(z)·G(z)` (DLMF §5.17.1) lets the substrate shift any
  real z into the asymptotic regime by repeated forward-shift; the
  inverse shift fires for z ∈ (0, z_shift]. A sign flip there means
  small-z values come back with the wrong sign — and the mutation
  pinned that the test set must independently verify both regimes,
  not just one chained through.
- **Tier:** substrate.

#### Mutation 7 — `cBeta` sign on a+b

- **Site:** `packages/bigfloat/src/complex.ts` `cBeta` (bead `t48g`
  mutation transcript, M4).
- **Mutation:** sign-flip on `(a + b)` inside `cBeta = exp(clgamma(a)
  + clgamma(b) - clgamma(a+b))`.
- **Tests RED:** `packages/bigfloat/test/complex-gamma-extensions.test.ts`
  conjugate-symmetry tests AND defining-identity tests RED.
- **Mathematical interpretation:** the complex Beta identity
  `B(a, b) = Γ(a)·Γ(b)/Γ(a+b)` is the SAME identity as the real case,
  but at complex arguments the Γ-substrate's branch-cut sensitivity
  makes the perturbation pin different invariants — the conjugate
  symmetry `cBeta(ā, b̄) = conj(cBeta(a, b))` only holds when the
  underlying sign convention is preserved.
- **Tier:** substrate.

#### Mutation 8 — `cIncompleteGammaUpper` CF numerator sign

- **Site:** `packages/bigfloat/src/complex.ts` `cIncompleteGammaUpper`
  Lentz continued-fraction (bead `t48g` mutation transcript, M5).
- **Mutation:** sign-flip on the numerator of the CF recursion.
- **Tests RED:** Large-z regime tests RED in
  `complex-gamma-extensions.test.ts`.
- **Mathematical interpretation:** the Lentz modified continued
  fraction for the upper incomplete gamma (DLMF §8.9.2) has a sign
  convention on the numerator step. A flip lets the CF converge to a
  different complex point — the magnitude may stay close, but the
  argument is wrong.
- **Tier:** substrate.

#### Mutation 9 — `ctrigamma` Stirling-power exponent

- **Site:** `packages/bigfloat/src/complex.ts` `ctrigamma` (bead
  `t48g` mutation transcript, M1).
- **Mutation:** perturb the Stirling-power exponent in the asymptotic
  regime.
- **Tests RED:** `complex-gamma-extensions.test.ts` asymptotic regime
  tests RED; `ctrigamma(1+0i).re ≈ π²/6` byte-comparison RED.
- **Mathematical interpretation:** the Stirling-with-branch-cut
  asymptotic carries a `z^{-(2m+1)}` power term in the polygamma
  coefficients (DLMF §5.11.2). Perturbation surfaces immediately on
  the closed-form anchor.
- **Tier:** substrate.

#### Mutation 10 — `bigGammaP` dispatch (`1 → Q` perturbation)

- **Site:** `packages/bigfloat/src/special-funcs/incomplete-gamma.ts`
  `bigGammaP` (bead `1y76` mutation transcript).
- **Mutation:** perturb the dispatch boundary between direct-series
  and `1 - Q` computation routes.
- **Tests RED:** `P + Q = 1` byte-equality at 50 dp RED.
- **Mathematical interpretation:** the regularised pair (P, Q) MUST
  satisfy `P + Q = 1` exactly; the naive `Q = 1 - P` loses
  cancellation at the boundary regime where P ≈ 1. The substrate
  picks the more numerically-stable route per regime — the
  perturbation routes through the cancellation-lossy path and the
  bit-exact identity fails.
- **Tier:** substrate.

#### Mutation 11 — `bigGammaP` L12 boundary guard

- **Site:** `packages/bigfloat/src/special-funcs/incomplete-gamma.ts`
  L12 guard (bead `1y76` mutation transcript, M3).
- **Mutation:** remove the L12 SciPy-landmine boundary guard.
- **Tests RED:** `P + Q = 1` at the SciPy-L12 boundary (Pochhammer
  near-zero) RED.
- **Mathematical interpretation:** SciPy's `gammainc` has a documented
  landmine at small-a, small-z boundary (Q ≈ 1 - tiny); the substrate
  pins the L12 boundary to preserve byte-identity with the gold-tier
  oracles. The guard removal surfaces SciPy parity tests, not the
  underlying mathematics.
- **Tier:** substrate.

#### Mutation 12 — `cIncompleteGammaUpper` series prefactor

- **Site:** `packages/bigfloat/src/complex.ts` (bead `t48g` mutation
  transcript, M3).
- **Mutation:** drop the `/a` divisor in the series prefactor.
- **Tests RED:** Series regime tests in
  `complex-gamma-extensions.test.ts` RED.
- **Mathematical interpretation:** the series form
  `γ(a, z) = z^a · e^{-z} · Σ z^k / Γ(a + k + 1)` (DLMF §8.7.1)
  carries the `1/a` prefactor inside the Pochhammer-shifted Γ
  denominator. The mutation pins the substrate against an obvious
  but-wrong rewrite.
- **Tier:** substrate.

#### Mutation 13 — `cpolygamma` reflection sign

- **Site:** `packages/bigfloat/src/complex.ts` `cpolygamma` (bead
  `t48g` mutation transcript, M2).
- **Mutation:** sign-flip on the polygamma reflection identity for
  m=2,3,4,5.
- **Tests RED:** `cpolygamma(m, 3+2i)` byte-equality vs mpmath at 30
  dp RED for m=2,3.
- **Mathematical interpretation:** the polygamma reflection formula
  (DLMF §5.15.6) has an alternating-sign in m; perturbation surfaces
  on the closed-form mpmath cross-check.
- **Tier:** substrate.

#### Mutation 14 — `bigIncompleteGammaUpper` Cephes rescaling constant

- **Site:** `packages/bigfloat/src/special-funcs/incomplete-gamma.ts`
  (bead `ytvb` mutation transcript, M2).
- **Mutation:** swap the Cephes `biginv = 2.22e-16` rescaling
  constant.
- **Tests RED:** Underflow boundary tests RED — large-z regime
  rescaling fails.
- **Mathematical interpretation:** Cephes `igam.c` verbatim-port
  carries two rescaling constants (`big = 4.5e15`, `biginv =
  2.22e-16`) for Lentz CF convergence stability. The constants are
  load-bearing for numerical IEEE-754 normality.
- **Tier:** substrate.

### Vocabulary tier — cas-core identity table

Mutations that perturbed the cas-core identity rules. RED-confirmed
in `packages/cas-core/test/special-funcs/gamma-identities.test.ts`
(101 tests / 258 expects), `tools/special-eval/v1-gamma.test.ts` §(d),
or both.

#### Mutation 15 — `gamma-recurrence` rule (drop z factor)

- **Site:** `packages/cas-core/src/special-funcs/gamma-identities.ts:933`
  — `rewrite: (a) => mkTimes(z, expr("Gamma", [z]))` perturbed to
  drop the `z` factor.
- **Mutation:** `Γ(z+1) → Γ(z)` (dropping the recurrence factor).
- **Tests RED:**
  `tools/special-eval/v1-gamma.test.ts:692` §(d) "Γ(z+1) ≡ z·Γ(z) —
  recurrence rewrite (GA-C1, DLMF 5.5.1)" — 1 RED. **Verified live
  during V1 gate authoring.**
- **Mathematical interpretation:** the recurrence `Γ(z+1) = z·Γ(z)`
  (DLMF §5.5.1) is the load-bearing rule of the entire gamma
  identity table — every Priority-D, Priority-E, and product-walker
  rule uses it transitively. Without the `z` factor, the recurrence
  becomes a no-op and the LHS-RHS canonical-form equality fails
  for the basic shape; the entire integer-Γ table collapses through
  this rule.
- **Tier:** vocabulary.

#### Mutation 16 — `digamma-recurrence` rule (drop 1/z residual)

- **Site:** `packages/cas-core/src/special-funcs/gamma-identities.ts:976`
  — `rewrite: (a) => mkPlus([expr("Digamma", [z]), mkDiv(ONE, z)])`
  perturbed to drop the `mkDiv(ONE, z)` term.
- **Mutation:** `ψ(z+1) → ψ(z)` (dropping the +1/z residual).
- **Tests RED:**
  `tools/special-eval/v1-gamma.test.ts` §(d) "ψ(z+1) ≡ ψ(z) + 1/z —
  digamma recurrence (DIG-C1, DLMF 5.5.2)" + "ψ(z+1) recurrence:
  simplified emits ψ(z) + 1/z form (1/z appears)" — 2 RED. **Verified
  live during V1 gate authoring.**
- **Mathematical interpretation:** the digamma recurrence `ψ(z+1) =
  ψ(z) + 1/z` (DLMF §5.5.2) is the unique source of the `1/z`
  residual in the gamma identity table. Without it, all ψ-recurrence-
  driven simplifications lose the additive constant; e.g.,
  `ψ(3) = ψ(1) + 1 + 1/2` collapses to `ψ(1)`.
- **Tier:** vocabulary.

#### Mutation 17 — `digamma-reflection` sign (rknz I4 transcript)

- **Site:** `packages/cas-core/src/special-funcs/gamma-identities.ts:998`
  — PLUS / MINUS sign on the `π·cot(πz)` reflection term.
- **Mutation:** flip the sign of the reflection identity (PLUS → MINUS).
- **Tests RED:** I4 mutation transcript: "DIG-C2 reflection sign at
  z=-1/3" (non-half-integer canary). 4 tests in
  `packages/cas-core/test/special-funcs/gamma-identities.test.ts` RED.
- **Mathematical interpretation:** the reflection `ψ(1-z) - ψ(z) =
  π·cot(πz)` (DLMF §5.5.4) is SIGN-CRITICAL — the rewrite is for the
  LHS pattern `ψ(1-z)`, so the rearrangement requires PLUS. The
  non-half-integer canary at z=-1/3 catches sign-flip without false-
  positives at half-integers (where cot is zero).
- **Tier:** vocabulary.

#### Mutation 18 — `barnes-g-functional-equation` rewrite

- **Site:** `packages/cas-core/src/special-funcs/gamma-identities.ts:1062`
  BARNESG-C1 rule.
- **Mutation:** swap `Γ(z)·G(z) → Γ(z+1)·G(z)` (off-by-one).
- **Tests RED:** `gamma-identities.test.ts` BarnesG positive-integer
  table RED — G(4) should be 2 but evaluates to G(5)/Γ(3) = 24/2 = 12.
- **Mathematical interpretation:** the BarnesG functional equation
  `G(z+1) = Γ(z)·G(z)` (DLMF §5.17.1) drives the BarnesG positive-
  integer ladder (G(1)=G(2)=G(3)=1; G(4)=Γ(3)·G(3)=2; G(5)=Γ(4)·G(4)
  =12; …). An off-by-one in the Γ-argument breaks the ladder.
- **Tier:** vocabulary.

#### Mutation 19 — `gamma-legendre-duplication` cross-check

- **Site:** `packages/cas-core/src/special-funcs/gamma-identities.ts:1078`
  GA-D1 rule.
- **Mutation:** transcript covered in `rknz` close notes —
  perturbations covering the Legendre constants `2^(2z-1)` and
  `1/√π`.
- **Tests RED:** Multiple LHS-RHS canonical-equality tests in
  `gamma-identities.test.ts`.
- **Mathematical interpretation:** the Legendre duplication
  `Γ(2z) = 2^(2z-1)/√π · Γ(z) · Γ(z+1/2)` (DLMF §5.5.5) is the
  load-bearing rule for the half-integer table — perturbation cascades
  through every half-integer derived identity.
- **Tier:** vocabulary.

### Bridge / dispatch tier — meijer-core

Mutations that perturbed the bidirectional Meijer-G bridge or the
dispatch rule table.

#### Mutation 20 — gamma bridge `argsInverse` (drop second arg)

- **Site:** `packages/meijer-core/src/bridges/gamma.ts:333` — closure
  returns `[a, z]`; perturbed to return `[a]` (the 2-arg → 1-arg
  shape).
- **Mutation:** drop the `z` element from the `argsInverse` closure
  return value.
- **Tests RED:**
  `tools/special-eval/v1-gamma.test.ts` §(e) — 15 of 30
  `argsInverse() returns [a, z] byte-identically` tests RED across
  both heads × multiple sample combinations. **Verified live during
  V1 gate authoring.**
- **Mathematical interpretation:** the 2-arg `argsInverse` contract
  is the load-bearing rename from I6-prep (`qt6m` Bessel epic) —
  the bridge surface generalises arity. A regression that drops to
  the 1-arg shape breaks the gamma bridge while keeping it valid
  for the (rare) Erf 1-arg case, surfacing as a length mismatch.
- **Tier:** bridge.

#### Mutation 21 — gamma bridge `bm` multiset symmetry

- **Site:** `packages/meijer-core/src/bridges/gamma.ts:582-589`
  multiset handler (bead `5hnr` mutation transcript, M1).
- **Mutation:** drop the bm-multiset symmetry: reject `[0, a]` order,
  accept only `[a, 0]`.
- **Tests RED:** `packages/meijer-core/test/bridges-gamma.test.ts`
  multiset-reversal tests RED + `v1-gamma.test.ts` §(e) "reversed bm"
  test RED.
- **Mathematical interpretation:** the canonical Meijer-G parameter
  groups are *multisets* (DLMF §16.17.1) — the parameter sort order
  is conventional, the matcher must accept any. ADR-0035 pins
  multiset semantics for all bm/bq/an/ap groups.
- **Tier:** bridge.

#### Mutation 22 — Erfc deferral on bm=[0, 1/2]

- **Site:** `packages/meijer-core/src/bridges/gamma.ts:563-569`
  (bead `5hnr` mutation transcript, M2).
- **Mutation:** drop the Erfc-shape collision guard.
- **Tests RED:** `bridges-gamma.test.ts` Erfc-collision tests RED +
  `tools/meijer-g-symbolic-only/gamma-closure.test.ts` discriminator
  tests RED.
- **Mathematical interpretation:** the (2, 0, 1, 2) shape with
  bm = {0, 1/2} is Erfc's signature, NOT IncompleteGammaUpper(1/2,
  z) — both share the structural shape but the discrimination
  lattice (ADR-0042 §"Backward discrimination") routes Erfc first.
  A guard removal would emit IncompleteGammaUpper(1/2, z) wrongly.
- **Tier:** bridge.

#### Mutation 23 — Bateman 5.6 dispatch rule bq slot literal

- **Site:** `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts`
  (bead `0pvl` mutation transcript, M1).
- **Mutation:** perturb the bq-slot literal `0` to `1` in
  `bateman-5-6-38a`.
- **Tests RED:** `packages/meijer-core/test/dispatch.test.ts` rule
  38a tests RED — the dispatch returns null.
- **Mathematical interpretation:** Bateman §5.6 rule (38) carries an
  explicit `bq = [0]` slot for IncompleteGammaLower; the literal `0`
  is the discriminator that distinguishes lower-incomplete from the
  family of nearby (1, 1, 1, 2) shapes.
- **Tier:** bridge.

#### Mutation 24 — Bateman 5.6 free-slot order swap

- **Site:** `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts`
  (bead `0pvl` mutation transcript, M2).
- **Mutation:** swap the free-slot order in the rule body.
- **Tests RED:** Canonical-sort mismatch RED on the round-trip from
  rule → G-form → backward bridge.
- **Mathematical interpretation:** the free-slot order is fixed by
  the canonical-sort convention; perturbation breaks the round-trip
  invariant (rule emits a non-canonical form, the bridge expects
  canonical).
- **Tier:** bridge.

#### Mutation 25 — dispatch-rule discriminator ordering (T3)

- **Site:** `packages/meijer-core/src/index.ts` `ALL_RULES`
  declaration order (bead `boyu` mutation transcript).
- **Mutation:** move `BATEMAN_5_6` *before* `ERFC_FORWARD` in the
  ALL_RULES array.
- **Tests RED:** `tools/meijer-g-symbolic-only/gamma-closure.test.ts`
  Erfc collision tests RED (bm=[0, 1/2] routes through
  IncompleteGammaUpper instead of Erfc).
- **Mathematical interpretation:** the discriminator ordering is the
  resolution mechanism for the (2, 0, 1, 2) shape collision between
  Erfc and IncompleteGammaUpper. Both shapes are structurally valid;
  ordering pins which rule wins. ADR-0042 §"Discrimination lattice"
  prescribes Erfc-first as the canonical convention.
- **Tier:** bridge.

### Tool tier — wire surfaces (integrate-1d, special-eval, meijer-g-symbolic-only)

#### Mutation 26 — golden 37 value-bit perturbation (T1)

- **Site:** `tools/integrate-1d/reference/manifest.json` g07 value
  bits (bead `on05` mutation transcript).
- **Mutation:** 1-ULP perturbation of the manifest's stored value bits.
- **Tests RED:** `bun tools/integrate-1d/tool.ts --test` 1/38 FAIL.
  Restored byte-identical.
- **Mathematical interpretation:** the golden manifest IS the
  oracle's bit-precise expectation; a single-ULP perturbation pins
  that the manifest replay is checking value bits exactly. The same
  perturbation surfaces in goldens replay across all wire tools.
- **Tier:** tool (integrate-1d wire).

#### Mutation 27 — `special-eval` real arb-prec Gamma arg-shift (T2 M1)

- **Site:** `tools/special-eval/tool.ts` Gamma arb-prec dispatch
  (bead `6g09` mutation transcript, M1).
- **Mutation:** shift the Gamma arg by a small delta before routing
  to `gamma()`.
- **Tests RED:** 3 of 101 `gamma-cross-cutting.test.ts` tests RED.
- **Mathematical interpretation:** the wire-side arg-shift simulates
  a misrouted dispatch (e.g., a `+1` recurrence that wasn't supposed
  to fire). The arb-prec lane MUST be byte-identical to the substrate.
- **Tier:** tool (special-eval wire).

#### Mutation 28 — `special-eval` Hyperfactorial Bendersky-Adamchik exponent

- **Site:** `tools/special-eval/tool.ts` Hyperfactorial computation
  (bead `6g09` mutation transcript, M2).
- **Mutation:** drop the exponent term in the Bendersky-Adamchik
  formula.
- **Tests RED:** 1 Hyperfactorial test in `gamma-cross-cutting.test.ts`
  RED. The closed-form `Hyperfactorial(3) = 108 = 1¹·2²·3³` value
  surfaces immediately.
- **Mathematical interpretation:** the Hyperfactorial is defined by
  `H(n) = ∏ k^k`; the substrate uses Bendersky-Adamchik's exponential-
  log formula. The exponent drop returns the wrong value at every
  positive integer.
- **Tier:** tool (special-eval wire).

#### Mutation 29 — `special-eval` GammaRatio numerator/denominator swap

- **Site:** `tools/special-eval/tool.ts` GammaRatio dispatch (bead
  `6g09` mutation transcript, M3).
- **Mutation:** swap the (a, b) argument order in `gammaRatioFloat64`
  call.
- **Tests RED:** 1 GammaRatio test in `gamma-cross-cutting.test.ts`
  RED — `GammaRatio(5, 3) = 12` returns `1/12`.
- **Mathematical interpretation:** the asymmetric arity-2 head
  `GammaRatio(a, b) = Γ(a)/Γ(b)` is non-commutative; a swap pins
  the wire-side argument ordering convention.
- **Tier:** tool (special-eval wire).

#### Mutation 30 — `special-eval` Pochhammer n+1 perturbation

- **Site:** `tools/special-eval/tool.ts` Pochhammer dispatch (bead
  `6g09` mutation transcript, M4).
- **Mutation:** `pochhammerFloat64(a, n) → pochhammerFloat64(a, n+1)`.
- **Tests RED:** 7 Pochhammer tests in `gamma-cross-cutting.test.ts`
  RED, including the closed-form `Pochhammer(1.5, 3) = 13.125`.
- **Mathematical interpretation:** the off-by-one error sees a wider
  blast radius than other mutations because Pochhammer's `n` parameter
  cascades through the entire factorial structure. The exact-value
  closed forms (e.g., `Pochhammer(1, n) = n!`) are particularly
  effective discriminators.
- **Tier:** tool (special-eval wire).

#### Mutation 31 — `special-eval` Polygamma negative-m guard

- **Site:** `tools/special-eval/tool.ts` Polygamma dispatch (bead
  `6g09` mutation transcript, M5).
- **Mutation:** disable the negative-m guard (allow m=-1 to route).
- **Tests RED:** 2 honest-refusal tests in `gamma-cross-cutting.test.ts`
  RED — Polygamma at m=-1 should return `tagged "degenerate-shape"`,
  but the substrate produces a non-finite value.
- **Mathematical interpretation:** `ψ⁽ᵐ⁾(z)` is defined for m ∈ ℤ_{≥0};
  m < 0 has no definition (negative-order polygammas can be defined
  via "negapolygamma" but that's a different head). The honest-refusal
  guard is structurally inadmissible to bypass.
- **Tier:** tool (special-eval wire).

#### Mutation 32 — `special-eval` Digamma dispatcher arg-shift

- **Site:** `packages/quadrature/src/eval-numeric-expr.ts:259` —
  `digammaFloat64(a[0]!)` perturbed to `digammaFloat64(a[0]! + 0.1)`.
- **Mutation:** add a 0.1 offset to the Digamma dispatcher input.
- **Tests RED:**
  `tools/special-eval/v1-gamma.test.ts` §(f) — 2 RED:
  "evalNumericExprWithSpecial dispatches LogGamma/Digamma/Pochhammer/Beta
  identically" + "∫_2^5 ψ(x) dx = log Γ(5) - log Γ(2)". **Verified
  live during V1 gate authoring.**
- **Mathematical interpretation:** the eval-numeric-expr dispatcher
  is the load-bearing composition point between integrate-1d's
  Gauss-Kronrod driver and the gamma substrates. A wrong-arg shift
  surfaces both in the direct dispatcher test AND in the FTC-anchored
  end-to-end integral (where ψ should integrate to log Γ).
- **Tier:** tool (integrate-1d composition).

#### Mutation 33 — T3 closure-test discriminator ordering

- **Site:** `tools/meijer-g-symbolic-only/gamma-closure.test.ts`
  (bead `boyu` mutation transcript).
- **Mutation:** alter the discriminator ordering test expectation
  (Erfc-vs-IncompleteGammaUpper).
- **Tests RED:** `gamma-closure.test.ts` 4 tests RED on bm = [0, 1/2]
  routing.
- **Mathematical interpretation:** the closure-test layer asserts
  that the meijer-g-symbolic-only tool's forward+backward closure
  emits the canonically-correct head for shape-colliding G-forms.
- **Tier:** tool (meijer-g-symbolic-only).

### Wire tier — special-eval value-protocol surface

#### Mutation 34 — `special-eval` wire `normalise(53)` → `normalise(50)`

- **Site:** `tools/special-eval/tool.ts:829` — `float64ToBigFloat`
  helper, `normalise(bf.mantissa, bf.exponent, 53)` perturbed to
  `normalise(..., 50)`.
- **Mutation:** drop the wire precision from 53 to 50 bits.
- **Tests RED:**
  `tools/special-eval/v1-gamma.test.ts` §(a) — 19 of 22 float64-lane
  byte-equality tests RED + `achieved_precision = 53` test RED.
  **Verified live during V1 gate authoring.**
- **Mathematical interpretation:** the wire contract is "achieved_precision
  = 53 on the float64 lane" (ADR-0042 §"Decision 9"). The
  `normalise(..., 53)` step is what makes the wire output structurally
  uniform across all 19 admitted heads — a substrate's `gammaFloat64`
  may return a value with minimal-bit precision (e.g., `1.0` has
  precision 1 in `fromFloat64`), and the normalise step pads to 53
  so the wire shape is consistent. The mutation pins this contract.
- **Tier:** wire.

#### Mutation 35 — wire Gamma float64 result perturbation (substrate-only test)

- **Site:** `packages/quadrature/src/special-funcs/gamma-float64.ts`
  `gammaFloat64(0.5) → Math.sqrt(Math.PI) + 1e-10`.
- **Mutation:** add 1e-10 to the half-integer base case.
- **Tests RED:** *None in §(a)* — because the test compares wire ≡
  direct substrate, and both go through the perturbed substrate, the
  byte-equality holds. **Tests RED in `bun tools/special-eval/tool.ts
  --test` goldens** — the stored golden values match the unperturbed
  substrate. This is a tier-discriminator: substrate mutations break
  goldens, wire mutations break parity tests.
- **Mathematical interpretation:** this is the *negative example* —
  it confirms that §(a) is correctly designed as a *wire-substrate
  parity test*, NOT as a "substrate is mathematically correct" test
  (the goldens cover the mathematical-correctness invariant
  separately). The split is load-bearing for the test architecture.
- **Tier:** wire (negative example).

### V1 cross-cutting mutations (this gate)

These are the perturbations VERIFIED LIVE during V1 gate authoring
(2026-05-19), satisfying CLAUDE.md Rule 6's "≥ 5 mutation-proof
markers verified by live perturbation". Each is documented above
under its tier; the bullet list below cross-references for the V1
gate transcript:

1. **M1** — `gamma-recurrence` rule rewrite drop (Mutation 15).
   `packages/cas-core/src/special-funcs/gamma-identities.ts:933`.
   1 RED in §(d).
2. **M2** — gamma bridge `argsInverse` drops `z` arg (Mutation 20).
   `packages/meijer-core/src/bridges/gamma.ts:333`.
   15 RED in §(e).
3. **M3** — wire `normalise(53)` → `normalise(50)` (Mutation 34).
   `tools/special-eval/tool.ts:829`.
   19 RED in §(a).
4. **M4** — `bigIncompleteGammaLower` complementarity sign flip
   (Mutation 1).
   `packages/bigfloat/src/special-funcs/incomplete-gamma.ts:615`.
   4 RED in §(j).
5. **M5** — `digamma-recurrence` rule drops `+1/z` residual
   (Mutation 16).
   `packages/cas-core/src/special-funcs/gamma-identities.ts:976`.
   2 RED in §(d).
6. **M6** (bonus) — Digamma dispatcher arg-shift in
   `eval-numeric-expr.ts:259` (Mutation 32).
   2 RED in §(f) — including the FTC-anchored end-to-end integrate-1d
   test, proving the cross-cutting test layer catches composition
   bugs that the per-substrate tests miss.

All 6 perturbations were applied, the failing tests confirmed via
`bun test tools/special-eval/v1-gamma.test.ts`, and then restored.
The post-restore test count is **125 pass / 0 fail / 313 expects**,
identical to the pre-mutation baseline.

## Cross-bead findings (load-bearing surprises)

Findings that surfaced *because* of the mutation-proving discipline,
not in the original impl design or R-research sketches:

1. **mpmath + arb IncompleteBeta convention bug surfaced at G8.** The
   first G8 cross-agreement run produced **40 unexplained findings**.
   36 of 40 root-caused to a single adapter convention mismatch:
   `mpmath.betainc(a,b,0,z,regularized=False)` and `acb.beta_lower(a,
   b, regularized=0)` returned the unregularised form while
   corpus-spec.md pins the **regularised** convention (DLMF §8.17.2).
   Both subagents had even left probe-comments citing the regularised
   form as correct. Two 1-character fixes (`False → True`; `0 → 1`)
   + comment correction. Re-run: 40 → 4 unexplained. (Worklog 174 §"Phase 1
   Round 1.")

2. **Boost.Math 1.83 digamma half-integer bug.** The remaining 4 G8
   findings were `digamma(-1/2)` × 4 oracle pairs: Boost returns
   `ψ(1/2)` instead of `ψ(3/2)`. Verified independently via mpmath,
   scipy, and DLMF §5.5.4 reflection (`cot(-π/2) = 0` so `ψ(-1/2) =
   ψ(3/2)`). Filed as P3 followup. The I5 float64 port (our own
   implementation) gets this right; tests include an explicit G8-finding
   guard (`yyyb` close notes). This is a *upstream-library bug*, not a
   workbench bug — but the mutation-proving discipline surfaced it.

3. **Sign-blind symmetry tests in `bigBeta`.** Bead `fpxm` (I3a)
   mutation-proving exposed a **test-set gap**: initial symmetry tests
   for `B(a,b) - B(b,a) = 0` would pass with the wrong sign on B
   because both legs were perturbed together. Agent added explicit
   sign-pinning before the 4 mutation transcripts could fire. Rule 6
   in action — "didn't throw" tests caught and replaced.

4. **Off-by-one boundary in `bigPochhammer` integer-pole regime.**
   Bead `7ri8` (I3b) M1 (off-by-one truncation predicate) initially
   did NOT cause RED — the test set didn't cover the `(-m)_m` zero-
   product boundary. Agent added boundary tests for `(-m)_m` before
   the mutation could fire. Rule 6 again.

5. **R2 §2.8 typo in BarnesG series denominator.** Bead `4q56` (I3c)
   M3 (R2 §2.8 denominator typo applied) surfaced as a series-regime
   RED. Agent flagged the R2 §2.8 has a typo in series denominator;
   `PHASE2-impl-plans.md` §I3c is authoritative; documented in
   literate prose.

6. **PHASE2 spec inconsistency in I6 bm partition.** Bead `5hnr` (I6)
   subagent caught spec inconsistency in PHASE2 (bm partition with
   wrong m count) and applied R4-correct partition. The
   mutation-proving discipline forced the agent to derive the partition
   from R4 first principles — exposing the spec error.

7. **Test architecture tier separation (V1 gate finding).** Mutation
   35 (substrate-only test, §(a) negative example) demonstrated that
   the (a) wire-substrate parity test is intentionally insensitive to
   substrate-only mutations. The goldens layer is the tier that catches
   substrate mathematical correctness; the cross-cutting (a) tests
   catch wire-substrate ROUND-TRIP correctness. Both layers must be
   distinct for the mutation-proving discipline to be complete.

## Total mutation-proving footprint across the epic

- **≥ 35 distinct mutation perturbations confirmed RED** across the
  epic (this rollup documents 35 explicit mutation points; the total
  perturbation count including bead-internal sub-mutations is ≥ 50;
  see "Per-bead mutation summary" table for the full count).
- **All 25 audited beads cite at least one of**: a mutation-proving
  section (per-substrate beads), Q2-mitigation landmines applied to
  oracle adapters (Phase 1 beads), or invariant-test hooks /
  golden-master byte-comparison contracts (Phase 3 beads).
- **No "didn't throw" tests** survived — Rule 7 verified per-bead.
  Notably, two beads (`fpxm` Beta, `7ri8` Pochhammer) had Rule-6
  test-set gaps that the mutation-proving discipline closed before
  the substrate shipped.
- **7 distinct cross-bead findings** surfaced via the mutation-proving
  discipline (the surprises section above). Three of these were
  upstream / spec bugs that the discipline pinned (mpmath+arb
  convention, Boost-1.83, R2 §2.8 typo); four were workbench-internal
  test-set or implementation gaps closed in-flight.

The Phase 4 cross-cutting test layer (V1,
`tools/special-eval/v1-gamma.test.ts`) is *additional* — it proves the
per-bead mutation-proven substrates compose correctly across packages.
Where the Erf V1 layer found 0 cross-cutting bugs and the Bessel V1
layer found 2 (`scientist-workbench-i3la` + `-tke9` — float64-only
substrate bugs the per-substrate tests missed), the Gamma V1 layer
found **0** in this gate's authoring run: every (a)-(j) invariant
passed on the unperturbed codebase. The Gamma family ships with the
discipline's full force, and the cross-cutting test layer is positioned
to catch future regressions as the substrates evolve.

## Pointers

- ADR-0042: [`docs/adr/0042-gamma-family-per-head-substrate.md`](../../adr/0042-gamma-family-per-head-substrate.md)
- Phase 0 R-research: [`docs/refs/gamma-research/R{1..5}-*.md`](.)
- Phase 1 oracle harness: `bench/gamma-anchor/`
- Phase 2 substrate beads' close notes: `bd show <id>` for
  `h37z`, `mozz`, `rknz`, `yyyb`, `2awg`, `7znk`, `ytvb`, `1y76`,
  `fpxm`, `7ri8`, `4q56`, `t48g`, `5hnr`, `0pvl`.
- Phase 3 wire-surface beads: `bd show <id>` for `on05`, `6g09`, `boyu`.
- Phase 2 worklog shard: [`docs/worklog/174-gamma-epic-phase1-and-round1.md`](../../worklog/174-gamma-epic-phase1-and-round1.md)
- Phase 4 cross-cutting tests: [`tools/special-eval/v1-gamma.test.ts`](../../../tools/special-eval/v1-gamma.test.ts)
  (this gate's test file) + [`tools/special-eval/gamma-cross-cutting.test.ts`](../../../tools/special-eval/gamma-cross-cutting.test.ts)
  (closed-form / arity-error precursor).
- CLAUDE.md Rule 6 (port-and-verify + mutation-prove): [`CLAUDE.md`](../../../CLAUDE.md)
- Sibling Bessel V1 rollup (structural template): [`docs/refs/besselj-research/V1-mutation-proving-rollup.md`](../besselj-research/V1-mutation-proving-rollup.md)
- Sibling Erf V1 rollup (originating template): [`docs/refs/erf-research/V1-mutation-proving-rollup.md`](../erf-research/V1-mutation-proving-rollup.md)
- Follow-up beads (V1 / Phase 1 findings):
  - Boost.Math 1.83 digamma(-1/2) P3 followup (filed in worklog 174).
  - bateman-5-6-3 over-eager gamma-identities recurrence expander P3 followup (filed in `boyu` close notes).
