# Ground truth — Euclidean cone projections (SOC + PSD)

Primary source, staged locally:
**`docs/refs/parikh-boyd-2014-proximal-algorithms.pdf`** — Neal Parikh,
Stephen Boyd, *Proximal Algorithms*, Foundations and Trends in
Optimization 1(3):123–231 (2014), DOI 10.1561/2400000003. §6.3 "Cones",
pp. 183–184.

This file transcribes the projection *formulas* `packages/cone-core`
ports for the second-order (SOC) and positive-semidefinite (PSD) cones.
O'Donoghue et al 2016 (`docs/refs/odonoghue-2016-scs.pdf`, §6.1 p. 1059)
gives only the cone *definitions* and explicitly defers the projection
formulas to this monograph (its ref [64]). Per CLAUDE.md Law 1 +
ADR-0030 §E the port derives **from this paper, never from `scs.c`'s
`cones.c`**. Code in `cone-core` cites this file plus the Parikh-Boyd
section/equation.

It is the companion to `docs/ground-truth/convex/scs-algorithm.md` §6,
which transcribes the three *definitional* projections (zero / free /
nonneg) that need no second reference and shipped in cone-core v0.1.

---

## 1. The projection problem and the Moreau decomposition (§6.3, p. 183)

Let `K` be a proper cone with dual cone `K*`. The Euclidean projection
of a point `v` onto `K` is the unique minimiser of

```
minimise   ‖x − v‖₂²
subject to x ∈ K .
```

Its optimality conditions (§6.3, p. 183) are

```
x ∈ K ,    v = x − λ ,    λ ∈ K* ,    λᵀx = 0 .
```

So projecting `v` onto `K` **decomposes** it into the difference of two
mutually orthogonal vectors: `x = Π_K(v)`, nonnegative with respect to
`K`, and `λ = Π_{K*}(−v)`, nonnegative with respect to `K*`. This is the
**Moreau decomposition** (§2.5):

```
v = Π_K(v) − Π_{K*}(−v) ,    with   ⟨Π_K(v), Π_{K*}(−v)⟩ = 0 .
```

Two corollaries used directly in cone-core:

- **`v ∈ K*` ⟹ `Π_K(v) = 0`** (§6.3, p. 183). The point is already in
  the polar direction; its nearest point of `K` is the apex.
- For a **self-dual** cone (`K* = K`, which holds for SOC and PSD) the
  Moreau decomposition reads `v = Π_K(v) − Π_K(−v)` with the two
  summands orthogonal. This is exactly the form the cone-core property
  tests assert — identical in shape to the nonnegative-orthant test
  (`z = max(0,z) − max(0,−z)`), because `ℝⁿ₊` is self-dual too.

---

## 2. Second-order cone (§6.3.2, p. 184)

Parikh-Boyd write the second-order ("quadratic" / "Lorentz" / "ice-cream")
cone with the **vector first, scalar last**:

```
C = {(x, t) ∈ ℝⁿ⁺¹ : ‖x‖₂ ≤ t} .
```

The projection (their eq., §6.3.2 p. 184) of a point `(v, s)` is the
three-case closed form

```
            ⎧ 0                                if ‖v‖₂ ≤ −s
Π_C(v, s) = ⎨ (v, s)                            if ‖v‖₂ ≤  s
            ⎩ ½·(1 + s/‖v‖₂)·(v, ‖v‖₂)          if ‖v‖₂ ≥ |s| .
```

Case 1 is "the point lies in the polar cone, project to the apex" — it
is the `v ∈ C* = C` corollary of §1 (the SOC is self-dual). Case 2 is
"the point is already in the cone." Case 3 is the genuine boundary
projection; the three cases agree on their shared boundaries, so the
formula is well-defined.

### cone-core's ordering — scalar first

`cone-core`'s `SOCone` (and ADR-0030 §C's `SOCone [indices]` wire form,
`x_{indices[0]} ≥ ‖x_{indices[1..]}‖₂`) puts the **scalar first**:
block `(t, x) ∈ ℝ × ℝ^{dim−1}` with `t ≥ ‖x‖₂`. Re-deriving Parikh-Boyd
in that ordering, with `ρ := ‖x‖₂`:

```
              ⎧ (0, 0)                       if ρ ≤ −t          (polar → apex)
Π_soc(t, x) = ⎨ (t, x)                       if ρ ≤  t          (already in cone)
              ⎩ ((ρ+t)/2 , ((ρ+t)/(2ρ))·x)   if ρ ≥ |t| .       (boundary projection)
```

The case-3 scalar is `½·(1 + t/ρ)·ρ = (ρ + t)/2`; the case-3 vector is
`½·(1 + t/ρ)·x = ((ρ + t)/(2ρ))·x`.

**Implementation order of the branches matters for the `ρ = 0` corner.**
Test `ρ ≤ t` first, then `ρ ≤ −t`, else case 3:

- `ρ = 0, t ≥ 0`: `ρ ≤ t` fires → returns `(t, 0) = (t, x)`. ✓
- `ρ = 0, t < 0`: `ρ ≤ t` false, `ρ ≤ −t` fires → returns `(0, 0)`. ✓
- case 3 is reached only when `ρ > t` *and* `ρ > −t`, i.e. `ρ > |t| ≥ 0`,
  so `ρ > 0` strictly — the `/(2ρ)` division is always safe there.

`dim = 1` (a bare scalar `t`, empty `x`): `ρ = 0` always, so the cone
degenerates to the nonnegative half-line `{t : t ≥ 0}` and the
projection degenerates to `max(0, t)` — consistent, no special case
needed.

### membership

`(t, x) ∈ C` iff `t ≥ ‖x‖₂`. Tolerance-gated (ADR-0030 determinism
contract — no implicit-zero gates): `inCone` returns `t − ‖x‖₂ ≥ −tol`.

The SOC is **self-dual**: `C* = C` (§6.3 names SOC among the self-dual
cones; standard, e.g. Boyd-Vandenberghe §2.6.1). `dualCone` returns the
cone unchanged.

---

## 3. Positive-semidefinite cone (§6.3.3, p. 184)

For the cone `C = Sⁿ₊` of symmetric positive-semidefinite `n × n`
matrices, the projection (Parikh-Boyd eq. (6.6), §6.3.3 p. 184) is

```
            n
Π_C(V) =    Σ   (λᵢ)₊ · uᵢ uᵢᵀ ,
           i=1
```

where `V = Σ λᵢ uᵢ uᵢᵀ` is the eigenvalue decomposition of the symmetric
matrix `V` and `(·)₊ = max(0, ·)`. In words: **form the eigenvalue
expansion and drop the terms with negative eigenvalues** (equivalently,
clamp every negative eigenvalue to zero and re-assemble). The PSD cone
is **self-dual** (`(Sⁿ₊)* = Sⁿ₊` under the trace inner product).

### the svec wire block and the √2 off-diagonal scaling

Parikh-Boyd state the projection on the matrix `V ∈ Sⁿ` directly. But a
`cone-core` `Cone` block is a **vector** slice of the SCS iterate, not a
matrix. ADR-0030 §C + open-question 4 fix the wire/block representation
of a `PSDCone` of side `n` as the **upper-triangular vectorisation**
`svec(V) ∈ ℝ^{n(n+1)/2}` with the **strict-Mosek √2 off-diagonal
scaling**:

```
svec(V) = ( V₀₀,  √2·V₀₁,  √2·V₀₂, …,  V₁₁,  √2·V₁₂, …,  V_{n−1,n−1} )
```

— upper triangle, row-major; each diagonal entry `Vᵢᵢ` carried as-is,
each off-diagonal entry `Vᵢⱼ` (`i < j`) carried as `√2·Vᵢⱼ`. The inverse
`smat` un-scales: `smat(w)ᵢⱼ = smat(w)ⱼᵢ = wₖ/√2` for the off-diagonal
slot `k`, `smat(w)ᵢᵢ = wₖ` for the diagonal slot.

**Why the √2 is load-bearing — the trap.** The √2 scaling is *exactly*
what makes `svec` a linear **isometry** between `(Sⁿ, ⟨·,·⟩_Frobenius)`
and `(ℝ^{n(n+1)/2}, ⟨·,·⟩_Euclidean)`:

```
⟨svec(A), svec(B)⟩ = Σᵢ AᵢᵢBᵢᵢ + Σ_{i<j} (√2 Aᵢⱼ)(√2 Bᵢⱼ)
                   = Σᵢ AᵢᵢBᵢᵢ + Σ_{i<j} 2 AᵢⱼBᵢⱼ
                   = Σ_{i,j} AᵢⱼBᵢⱼ  =  tr(AᵀB) = tr(AB)      (A, B symmetric).
```

Because `svec` is an isometry, the Euclidean projection in
svec-coordinates **equals** `svec` of the Frobenius projection in
matrix space:

```
Π_psd(w) = svec( Π_{Sⁿ₊}( smat(w) ) ) .
```

If the off-diagonals were carried *unscaled* (plain stacking), `svec`
would not be an isometry — off-diagonal directions would count once
instead of twice — and the cheap coordinate-wise route would project
onto the *wrong* set. This is the error that "has bitten every amateur
SDP implementer" (ADR-0030 OQ4). cone-core therefore implements
`projectCone(psd)` as the literal composition above:

```
1.  V  := smat(w)                          un-scale the √2 off-diagonals
2.  (λ, Q) := eigh(V)                       @workbench/linalg-core, λ ascending
3.  λ⁺ᵢ := max(0, λᵢ)                        clamp the negative spectrum
4.  V⁺ := Q · diag(λ⁺) · Qᵀ                  re-assemble  →  V⁺ᵢⱼ = Σₖ λ⁺ₖ QᵢₖQⱼₖ
5.  return svec(V⁺)                          re-scale the √2 off-diagonals
```

`eigh` is the real-symmetric cyclic-Jacobi eigensolver already in
`linalg-core` (ADR-0014); `V = smat(w)` is symmetric by construction, so
no Hermitian/complex path is needed here.

### membership

`w ∈ psd` iff `smat(w) ⪰ 0`, i.e. every eigenvalue of `smat(w)` is
`≥ 0`. Tolerance-gated: `inCone` eigendecomposes `smat(w)` and returns
`λ_min ≥ −tol`. (Since `eigh` sorts ascending, `λ_min` is the first
eigenvalue.)

`side = 1`: a `1 × 1` PSD cone is the nonnegative half-line; the general
path still works (`eigh` of a `1 × 1` matrix returns its single entry as
the eigenvalue), so no special case is needed.

---

## 4. Mapping to `packages/cone-core/src/cones.ts`

| Parikh-Boyd | cone-core |
|---|---|
| §6.3 p. 183 — Moreau decomposition `v = Π_K(v) − Π_{K*}(−v)` | the property-test invariant for every self-dual cone (`cones.test.ts`) |
| §6.3.2 p. 184 — SOC 3-case closed form | `projectCone` `case "soc"` |
| §6.3.2 — `(t,x) ∈ C ⇔ t ≥ ‖x‖₂` | `inCone` `case "soc"` |
| §6.3.3 eq. (6.6) p. 184 — `Π(V) = Σ (λᵢ)₊ uᵢuᵢᵀ` | `projectCone` `case "psd"` (via `smat` / `eigh` / clamp / `svec`) |
| §6.3.3 — `V ⪰ 0 ⇔ λ_min(V) ≥ 0` | `inCone` `case "psd"` |
| ADR-0030 §C + OQ4 — svec √2 off-diagonal scaling | the `svec` / `smat` helpers in `cones.ts` |
| SOC / PSD both self-dual | `dualCone` returns the cone unchanged (already shipped in v0.1) |

The exponential and power cones (§6.3.4 and Khanh Hien 2014) remain
deferred — tracked in `scientist-workbench-j282`.
