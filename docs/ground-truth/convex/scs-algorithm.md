# Ground truth — SCS (Splitting Conic Solver) algorithm

Primary source, staged locally:
**`docs/refs/odonoghue-2016-scs.pdf`** — Brendan O'Donoghue, Eric Chu,
Neal Parikh, Stephen Boyd, *Conic Optimization via Operator Splitting and
Homogeneous Self-Dual Embedding*, J. Optim. Theory Appl. (2016)
169:1042–1068, DOI 10.1007/s10957-016-0892-3.

This file transcribes the algorithm `packages/cone-core` ports. Per
CLAUDE.md Law 1 + ADR-0030 §E the port derives **from this paper, never
from `scs.c`**. Page numbers below are the journal pagination
(1042–1068); code in `cone-core` cites this file plus the page/equation.

Companion HSDE references also staged in `docs/refs/`:
`andersen-2009-homogeneous-self-dual.pdf` (the HSDE for LP, used by
`@workbench/solver-ipm`'s *different* IPM-based HSDE lineage — not this
one), `ye-warmstart-hsde.pdf` (Ye-Todd-Mizuno, the original HSDE),
`domahidi-2013-ecos.pdf` (ECOS).

---

## 1. The problem (paper §2, p. 1045)

The primal–dual pair of convex cone programs, eq (1):

```
minimise   cᵀx                  maximise   −bᵀy
s.t.       Ax + s = b           s.t.       −Aᵀy + r = c
           (x, s) ∈ ℝⁿ × 𝒦                 (r, y) ∈ {0}ⁿ × 𝒦*
```

Data: `A ∈ ℝ^{m×n}`, `b ∈ ℝᵐ`, `c ∈ ℝⁿ`, and a nonempty closed convex
cone `𝒦 ⊆ ℝᵐ` with dual cone `𝒦*`. `x` is the primal variable, `s` the
primal slack, `y` the dual variable, `r` the dual residual. `n ≤ m`.

**KKT optimality** (§2.1, p. 1045). `(x⋆, s⋆, r⋆, y⋆)` is primal–dual
optimal iff `Ax⋆ + s⋆ = b`, `s⋆ ∈ 𝒦`, `Aᵀy⋆ + c = r⋆`, `r⋆ = 0`,
`y⋆ ∈ 𝒦*`, and the gap `cᵀx⋆ + bᵀy⋆ = 0`.

**Infeasibility certificates** (§2.2, p. 1045–1046). If strong duality
holds, exactly one of: a point in `𝒫 = {(x,s): Ax+s=b, s∈𝒦}` (primal
feasible) or a `y ∈ 𝒟 = {y: Aᵀy=0, y∈𝒦*, bᵀy<0}` (primal-infeasibility
certificate). Symmetrically for dual infeasibility via
`𝒫̃ = {x: −Ax∈𝒦, cᵀx<0}`.

---

## 2. Homogeneous self-dual embedding (§2.3, p. 1046–1047)

The embedding, eq (7):

```
⎡r⎤   ⎡ 0    Aᵀ   c⎤ ⎡x⎤
⎢s⎥ = ⎢−A    0    b⎥ ⎢y⎥ ,   (x,s,r,y,τ,κ) ∈ ℝⁿ × 𝒦 × {0}ⁿ × 𝒦* × ℝ₊ × ℝ₊
⎣κ⎦   ⎣−cᵀ  −bᵀ   0⎦ ⎣τ⎦
```

`τ, κ ≥ 0` are introduced, complementary (at most one nonzero). With the
notation (p. 1047)

```
u = ⎡x⎤    v = ⎡r⎤    Q = ⎡ 0    Aᵀ   c⎤
    ⎢y⎥        ⎢s⎥        ⎢−A    0    b⎥
    ⎣τ⎦        ⎣κ⎦        ⎣−cᵀ  −bᵀ   0⎦
```

the embedding is eq (8): **find `(u, v)` s.t. `v = Qu`,
`(u, v) ∈ 𝒞 × 𝒞*`**, where

```
𝒞  = ℝⁿ × 𝒦* × ℝ₊            (the cone u lives in)
𝒞* = {0}ⁿ × 𝒦 × ℝ₊           (the cone v lives in — dual of 𝒞)
```

`Q` is **skew-symmetric** (`Qᵀ = −Q`); this is load-bearing throughout.

**Recovering the answer from a nonzero solution** (p. 1046–1047). Three
cases:

1. **`τ > 0, κ = 0`** — primal–dual solution:
   `(x̂, ŷ, ŝ) = (x/τ, y/τ, s/τ)` satisfies the KKT conditions of (1).
2. **`τ = 0, κ > 0`** — the gap `cᵀx + bᵀy` is negative, so the problem
   is primal or dual infeasible:
   - if `bᵀy < 0`: `ŷ = y/(bᵀy)` is a **primal-infeasibility
     certificate** (`Aᵀŷ = 0`, `ŷ ∈ 𝒦*`, `bᵀŷ = −1`).
   - if `cᵀx < 0`: `x̂ = x/(−cᵀx)` is a **dual-infeasibility
     (unboundedness) certificate** (`−Ax̂ ∈ 𝒦`, `cᵀx̂ = −1`).
3. **`τ = κ = 0`** — no conclusion about the original problem.

The embedding is **homogeneous**: if `(u,v)` solves it, so does
`t·(u,v)` for any `t ≥ 0`. It is also self-dual (paper proves this; not
needed for the port).

---

## 3. The operator-splitting iteration

### 3.1 Final algorithm (§3.2.3 eq (17), p. 1051)

After eliminating dual variables and applying the Moreau decomposition,
the iteration reduces to three steps:

```
ũ^{k+1} = (I + Q)⁻¹ (uᵏ + vᵏ)            — subspace projection
u^{k+1} = Π_𝒞 (ũ^{k+1} − vᵏ)             — cone projection
v^{k+1} = vᵏ − ũ^{k+1} + u^{k+1}          — dual update (running error sum)
```

Step 1 is a projection onto the subspace `{(u,v): v=Qu}`; `I+Q` is
invertible because `Q` is skew-symmetric. Step 2 is projection onto the
cone `𝒞`. Step 3 is integral-control-like: `v` accumulates the running
sum of the errors `uᵏ − ũᵏ`.

### 3.2 Over-relaxation (§3.3, p. 1051–1052)

In the `u`- and `v`-updates, replace every occurrence of `ũ^{k+1}` with

```
α · ũ^{k+1} + (1 − α) · uᵏ ,        α ∈ ]0, 2[
```

`α = 1` is the basic algorithm; `α ∈ ]1,2[` is over-relaxation. The
paper cites numerical experience that **`α ≈ 1.5`** improves
convergence. So with over-relaxation, writing `ǔ = α·ũ^{k+1} + (1−α)·uᵏ`:

```
u^{k+1} = Π_𝒞 (ǔ − vᵏ)
v^{k+1} = vᵏ − ǔ + u^{k+1}
```

### 3.3 Initialisation and zero-avoidance (§3.4, p. 1053–1054)

Zero is always a solution of the homogeneous embedding; the iteration
must be kept away from it. The paper's guarantee (exact-projection
case): initialise

```
u⁰ = (0, …, 0, 1)        — i.e. u⁰_x = 0, u⁰_y = 0, u⁰_τ = 1
v⁰ = (0, …, 0, 1)        — i.e. v⁰_r = 0, v⁰_s = 0, v⁰_κ = 1
```

(all entries zero except `u_τ = 1` and `v_κ = 1`). Then the iterates
stay bounded away from zero.

**Normalisation.** The candidate read off at termination uses the
*direction* of `(uᵏ, vᵏ)`, not its scale (the embedding is homogeneous).
The paper normalises `(ûᵏ, v̂ᵏ) = (uᵏ, vᵏ)/‖(uᵏ, vᵏ)‖₂` for the
convergence statement; operationally the termination check (below)
divides by `u_τ`, which already removes the scale.

### 3.4 Termination criteria (§3.5, p. 1054–1055)

Split the iterate `uᵏ = (u_x, u_y, u_τ)`, `vᵏ = (v_r, v_s, v_κ)`.

**If `u_τ > 0`** — read off the candidate primal–dual point:

```
xᵏ = u_x / u_τ ,    sᵏ = v_s / u_τ ,    yᵏ = u_y / u_τ
```

This candidate already satisfies the cone constraints and complementary
slackness by construction (steps 2–3 of the iteration). Compute the
residuals

```
pᵏ = A xᵏ + sᵏ − b           (primal residual)
dᵏ = Aᵀ yᵏ + c               (dual residual)
gᵏ = cᵀ xᵏ + bᵀ yᵏ           (duality gap)
```

**Terminate `optimal`** when all three hold:

```
‖pᵏ‖₂ ≤ ε_pri  · (1 + ‖b‖₂)
‖dᵏ‖₂ ≤ ε_dual · (1 + ‖c‖₂)
|gᵏ|  ≤ ε_gap  · (1 + |cᵀxᵏ| + |bᵀyᵏ|)
```

emitting `(xᵏ, sᵏ, yᵏ)` as approximately primal–dual optimal.

**Terminate `unbounded`** (dual-infeasibility certificate) when

```
‖A u_x + v_s‖₂ ≤ (−cᵀu_x / ‖c‖₂) · ε_unbdd
```

— then `u_x / (−cᵀu_x)` is the unboundedness certificate.

**Terminate `infeasible`** (primal-infeasibility certificate) when

```
‖Aᵀ u_y‖₂ ≤ (−bᵀu_y / ‖b‖₂) · ε_infeas
```

— then `u_y / (−bᵀu_y)` is the infeasibility certificate.

Reference default tolerances (paper §6.1, p. 1059):
`ε_pri = ε_dual = ε_gap = ε_unbdd = ε_infeas = 10⁻³`. ADR-0030 instead
drives these from the user-facing `precision` knob (default `1e-8`):
`ε_pri = ε_dual = ε_gap = precision`. `cone-core` exposes them as
`SCSOpts` fields so the tool layer maps the knob.

If `max_iter` is hit before any branch fires → `iter-cap`. A non-finite
iterate or a failed factorisation → `numerical-breakdown`.

---

## 4. Efficient subspace projection (§4.1, p. 1055–1057)

Step 1 of the iteration solves `(I + Q) ũ = w` for `w = uᵏ + vᵏ`. Write
(p. 1055–1056):

```
M = ⎡ I    Aᵀ⎤        h = ⎡c⎤        I + Q = ⎡  M    h⎤
    ⎣−A    I ⎦            ⎣b⎦                ⎣−hᵀ   1⎦
```

so `M` is `(n+m)×(n+m)`, `h` is `(n+m)`-vector, and the bottom-right `1`
is the `τ`-block. By block elimination of the `τ`-row,

```
⎡ũ_x⎤ = (M + h hᵀ)⁻¹ ( ⎡w_x⎤ − w_τ · h )
⎣ũ_y⎦                  ⎣w_y⎦

ũ_τ = w_τ + cᵀ ũ_x + bᵀ ũ_y
```

The Sherman–Morrison–Woodbury identity gives

```
(M + h hᵀ)⁻¹ = M⁻¹ − (M⁻¹ h)(M⁻¹ h)ᵀ M ... 
             = M⁻¹ − M⁻¹ h hᵀ M⁻¹ / (1 + hᵀ M⁻¹ h)
```

**Implementation (the factorisation-caching scheme, p. 1056).** `M`
depends only on `A` — it is *fixed across all iterations*. So precompute
**once**:

- factor `M` (LU; `M` is quasi-definite, any symmetric permutation has
  an LDLᵀ — but for dense small v0.1 problems a plain LU via
  `@workbench/linalg-core` is sufficient and simplest);
- `g := M⁻¹ h`   (one solve);
- `denom := 1 + hᵀ g`   (scalar).

Then **per iteration**, given `w = uᵏ + vᵏ` split into
`(w_x ∈ ℝⁿ, w_y ∈ ℝᵐ, w_τ ∈ ℝ)`:

```
rhs   = [w_x; w_y] − w_τ · h
p     = M⁻¹ · rhs                          (one solve against cached factor)
[ũ_x;ũ_y] = p − g · (hᵀ p) / denom          (SMW rank-1 correction)
ũ_τ   = w_τ + cᵀ ũ_x + bᵀ ũ_y
```

This is the *direct method*. The paper also gives an *indirect method*
(CG on `I + AᵀA`, eq 28 region) for large sparse `A`; ADR-0030 §"rejected
alternatives" defers sparse to v0.2, so `cone-core` v0.1 uses the direct
method only.

**Solving `M z = w` explicitly** (for the indirect derivation, and as a
sanity cross-check). With `M = [[I, Aᵀ], [−A, I]]`:

```
z_x + Aᵀ z_y = w_x
−A z_x + z_y = w_y     ⟹     z_y = w_y + A z_x
⟹  (I + AᵀA) z_x = w_x − Aᵀ w_y ,    z_y = w_y + A z_x
```

so the indirect method would Cholesky `I + AᵀA` (`n×n`, SPD). The direct
method LU-factors the full `(n+m)²` `M` instead — chosen for v0.1
because it makes no SPD assumption and reuses `linalg-core`'s `lu`
verbatim.

---

## 5. Data scaling (§5, p. 1057–1058)

The iteration (17) has no parameters, but the *relative scaling* of the
data strongly affects convergence. The paper scales `b, c` by positive
scalars `σ, ρ` and the equality constraints by diagonal positive-definite
`D, E`, solving the scaled program with `Â = D A E`, `b̂ = σ D b`,
`ĉ = ρ E c`, then recovering `x⋆ = E x̂⋆/σ`, `s⋆ = D⁻¹ ŝ⋆/σ`,
`y⋆ = D ŷ⋆/ρ`. `D` must preserve cone membership (block-constant on each
cone). The recommended target: columns of `A` and `b` near unit Euclidean
norm, rows of `A` and `c` similar norms (equilibration; Ruiz 2001,
ref [80]).

**v0.1 boundary.** `cone-core` v0.1 ships the iteration *without*
scaling — it converges, just slower. Scaling is a separable preprocessing
step (the paper presents it as exactly that) and is filed as a follow-up
bead. The LP bench gate (worklog 089: 21/21 lp-netlib + 29/29 lp-small)
is the test of whether unscaled convergence is adequate for v0.1; if a
bench case stalls on conditioning, scaling un-defers.

---

## 6. Cone projections — NOT in this paper

§3.1 (p. 1048) and §6.1 (p. 1059) defer cone projection to ref **[64]
Parikh & Boyd, *Proximal Algorithms*, Found. Trends Optim. 1(3) 2014,
§6.3** for SOC / PSD / exponential, and ref **[97] Khanh Hien 2014** for
the power cone. The paper gives the *cone definitions* (§6.1, p. 1059)
but not the projection formulas.

This file (transcribed from O'Donoghue 2016) covers only the projections
that are **definitional and need no second reference**:

- **`{0}ⁿ` (Zero cone)** — `Π(z) = 0`. Dual: `ℝⁿ` (Free).
- **`ℝⁿ` (Free cone)** — `Π(z) = z`. Dual: `{0}ⁿ` (Zero).
- **`ℝⁿ₊` (NonNeg cone)** — `Π(z)ᵢ = max(0, zᵢ)`. Self-dual.

These three close the **LP** case (LP = NonNeg cone, with equalities
absorbed into `Ax = b`), which is exactly the v0.1 bench gate.

The **second-order (SOC)** and **positive-semidefinite (PSD)**
projections are transcribed from Parikh-Boyd §6.3 — now staged at
`docs/refs/parikh-boyd-2014-proximal-algorithms.pdf` — in the companion
ground-truth file **`docs/ground-truth/convex/cone-projections.md`**
(bead `scientist-workbench-0wc7`). The **exponential** and **power**
projections still require Parikh-Boyd §6.3.4 and Khanh Hien 2014; until
those land (bead `scientist-workbench-j282`), `projectCone` throws a
loud `ConeError` naming the sub-bead for any not-yet-implemented family
— honest scope (CLAUDE.md Rule 8), never a silent wrong answer.

---

## 7. Mapping to `packages/cone-core`

| paper | cone-core |
|---|---|
| §1 eq (1) primal–dual pair | `ConeProblem` type (`hsde.ts`) — `A, b, c, cones` |
| §2.3 eq (7)/(8), `Q`, `𝒞`, `𝒞*` | `buildHSDE(problem)` → `HSDEMatrix` (`hsde.ts`) |
| §2.3 three-case recovery | `recoverPrimalDual(u, v, problem)` (`hsde.ts`) |
| §3.2.3 eq (17) + §3.3 over-relax | the iteration loop in `scsSolve` (`scs.ts`) |
| §3.4 init + zero-avoidance | `scsSolve` initial `u⁰, v⁰` |
| §3.5 termination taxonomy | `scsSolve` convergence checks → ADR-0030 status |
| §4.1 SMW factorisation-caching | the cached `M`-factor + `g`, `denom` in `scsSolve` |
| §5 scaling | deferred (v0.1 boundary, §5 above) |
| §6.1 / ref [64] cone projections | `projectCone` (`cones.ts`) — zero/free/nonneg here; SOC + PSD in `cone-projections.md`; exp/pow deferred (j282) |
