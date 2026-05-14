# ADR-0036 — Anderson acceleration for the SCS cone-solver iteration

**Status:** Accepted — 2026-05-14.
**Beads:** `scientist-workbench-k9mm` (this ADR + the `cone-core`
implementation). Unblocks `scientist-workbench-2ivi` (`tools/cone-solve`).
**Authors:** tobiasosborne + Claude Opus 4.7 (1M context).
**Related:** ADR-0030 (the convex-cone solver tier — establishes the
SCS-from-paper port discipline this ADR extends, §E); ADR-0015 (the
`numerical: true` determinism tier — this ADR's accelerator inherits it
verbatim); worklog 112 (the `cone-core` LP-complete substrate AA
accelerates); worklog 113 (the `cone-solve` tool whose bench grading
forced this ADR).

## Context

`tools/cone-solve` (worklog 113) ships the universal-primary cone solver
over the `@workbench/cone-core` SCS substrate (worklog 112). It is
*correct* — on NETLIB `afiro` it returns `status: "optimal"` with the
Gurobi/Mosek-consensus objective. But grading it against the corpus
`lp-netlib` suite surfaced a hard wall: the plain 2016-paper SCS
iteration is a **modest-accuracy first-order method with slow tail
convergence** (O'Donoghue 2016 §1 says so explicitly). Measured
iteration counts to reach the verifier's `1e-8` KKT tolerance:

| problem | size (`n × m`) | iterations to `1e-8` |
|---|---|---:|
| `afiro` | 51 × 27 | ~2 960 |
| `adlittle` | 138 × 56 | ~117 000 |
| `forplan`, `scsd1` | 514×183, 760×77 | not reached in 240 s |

The implementation is faithful to the paper and the convergence
behaviour is *exactly what the paper describes*. The gap is structural:
ADR-0030 §B sets `cone-solve`'s accuracy ceiling at `1e-6`, the
`lp-netlib` verifier hard-requires `1e-8`, and even at `1e-6` the
medium-tier problems take impractically many iterations. The standard
remedy — the one `SCS` itself adopted at version 2.0 — is **Anderson
acceleration** (AA): a derivative-free extrapolation that wraps the
fixed-point iteration and collapses the slow linear tail, at the cost of
one small least-squares solve per step.

Data scaling (O'Donoghue 2016 §5, shipped in worklog 112's
`scaling.ts`) was the first lever and is necessary but not sufficient;
acceleration is the second.

## Decision

### A. Port **Type-II Anderson acceleration** (AA-II), from the paper

`@workbench/cone-core` gains an `anderson.ts` module implementing the
classical Type-II method — Walker-Ni 2011, equivalently the AA-II of
Zhang-O'Donoghue-Boyd 2018 (arXiv:1808.03971) §2:

Given the fixed-point map `φ` and residual `g(x) = x − φ(x)`, with a
memory window `m` and `m_k = min(m, k)`:

```
γ^k = argmin_γ ‖ g_k − Y_k γ ‖₂ ,   Y_k = [Δg_{k−m_k} … Δg_{k−1}]
x_{k+1} = φ(x_k) − ℱ_k γ^k ,         ℱ_k = [Δφ_{k−m_k} … Δφ_{k−1}]
```

where `Δg_i = g_{i+1} − g_i` are residual differences and
`Δφ_i = φ(x_{i+1}) − φ(x_i)` image differences. The `m_k × m_k` normal
equations `(Y_kᵀ Y_k + λI) γ = Y_kᵀ g_k` are solved with a small
Tikhonov ridge `λ`. Ground truth:
`docs/ground-truth/convex/anderson-acceleration.md`, transcribed from
the canonical reference — **ported from the paper, never from the `scs`
C library's `aa` module** (ADR-0030 §E discipline).

**Why AA-II, not the paper's headline Type-I.** Type-I (a multi-secant
Jacobian estimate) can be faster but is unstable without the paper's
Powell-type regularisation (eq 10–13) and Gram-Schmidt restart rule
(eq 14) — a substantial globalisation scaffold. AA-II is the robust
classical method: one tall-skinny least-squares, no Jacobian estimate,
well-behaved under a light safeguard. v0.1 ships AA-II; Type-I and the
Powell globalisation are a documented v0.2 refinement.

### B. The v0.1 safeguard

AA is not monotone and a rank-deficient `Y_k` can extrapolate to
garbage. v0.1 ships a **light AA-II safeguard**, not the paper's full
Type-I globalisation:

1. **Tikhonov ridge** on the normal equations — the simple
   stand-in for Powell regularisation; a rank-deficient `Y_k` becomes
   harmless rather than catastrophic.
2. **Finiteness + non-explosion check** — a non-finite extrapolate, or
   one whose norm exceeds a large multiple of `‖φ(x_k)‖`, is rejected:
   take the plain step `x_{k+1} = φ(x_k)` and clear the history.
3. **History restart** on any safeguard trip.

The paper's residual-decrease safeguard needs an extra `φ` evaluation
per candidate; v0.1 omits it (finiteness + non-explosion + restart is
empirically sufficient for the LP-complete cone subset). The
residual-decrease globalisation is part of the v0.2 Type-I refinement.

### C. AA is on by default, tunable, and disable-able

`SCSOpts` gains `andersonMemory` (default `10`; `0` disables AA and
recovers the exact plain-SCS trajectory). On by default — the entire
point is to make `cone-solve` bench-viable, and a TS expert reaching for
`cone-solve` wants the fast path without a flag. `0` is kept so the
plain iteration stays reachable for testing and for the determinism
cross-check (the plain trajectory is the reference AA must not corrupt
the *answer* of, only the *speed*).

### D. The accelerator is generic over the fixed-point map

`makeAnderson(memory)` returns a stateful accelerator whose `next(z, Gz)`
consumes the current point `z` and its image `Gz = φ(z)`. It is *not*
SCS-specific — it accelerates any `Float64Array` fixed-point iteration —
so it is testable in isolation against a simple known contraction, and
`scs.ts` wires it by extracting one SCS iteration as the map `φ` on the
embedding pair `z = [u; v]`.

### E. Determinism is preserved

The accelerator carries `numerical: true` (ADR-0015) unchanged: a fixed
window `m`, a fixed-order normal-equations solve, no implicit-zero
gates. The accelerated trajectory is bit-identical given
`(problem, opts, platform)`, exactly as the plain iteration is. AA
changes *how fast* the iterate reaches the terminal region, never *what
counts as* terminal — the §3.5 termination test (`recoverPrimalDual`)
is untouched.

## Why rejected alternatives

**Just raise `max_iter`.** `adlittle` needs ~117 000 iterations to `1e-8`
and the medium tier does not converge in practical time. No `max_iter`
default makes plain SCS bench-viable; the tail convergence is the
problem, and acceleration is the only lever that addresses it.

**Type-I AA from the start.** Faster in principle, but its stability
demands the full Powell-regularisation + restart globalisation —
materially more code and more ways to be subtly wrong. AA-II delivers
the order-of-magnitude iteration-count reduction with a fraction of the
surface area. Type-I is the v0.2 move once AA-II is proven against the
bench.

**Switch `cone-solve` to an interior-point method.** That *is* the
specialist path — `tools/lp-solve`'s IPM lane (ADR-0032) and the
deferred `sdp-solve` IPM. ADR-0030 §B is deliberate: `cone-solve` is the
*universal* SCS-based primary, the specialists are the structure-aware
high-accuracy paths. Abandoning SCS for `cone-solve` would collapse that
architecture. AA keeps SCS the engine and makes it accurate enough.

**Re-profile the `lp-netlib` verifier to `1e-6` for `cone-solve`.**
Considered (it would align the bench with ADR-0030 §B's stated ceiling).
Rejected as the *primary* fix because even at `1e-6` plain SCS is
impractically slow on the medium tier — the verifier tolerance is not
the binding constraint, the tail convergence is. AA addresses the root
cause; a verifier re-profile would only paper over it.

## Determinism contract (summary)

| property | with Anderson acceleration |
|---|---|
| annotation | `numerical: true` (ADR-0015), unchanged |
| bit-identical | given `(problem, opts, platform)` — `opts` now includes `andersonMemory` |
| `andersonMemory` default | `10`; `0` disables AA (exact plain-SCS trajectory) |
| least-squares solve | ridge-regularised normal equations, fixed op order |
| termination | unchanged — §3.5 `recoverPrimalDual` on the accepted iterate |

## Pointers

- `docs/ground-truth/convex/anderson-acceleration.md` — the algorithm
  transcription (Zhang-O'Donoghue-Boyd 2018 / Walker-Ni 2011).
- `docs/ground-truth/convex/scs-algorithm.md` — the SCS iteration AA wraps.
- ADR-0030 — the convex-cone solver tier; §B (accuracy ceilings), §E
  (the from-paper port discipline).
- worklog 112 (`cone-core` substrate + §5 scaling), worklog 113
  (`cone-solve` tool + the bench-grading finding that forced this ADR).
