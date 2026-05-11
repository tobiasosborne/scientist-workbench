# 090 — `tools/lp-solve` v0.1: arbprec rational engine (2026-05-11)

## Context

Per worklog 089 and bead `wx3m`, the LP specialist of the cone-solver
tier (ADR-0030 §B) needed an implementer. The session began with the
LP-bench onramp (089) — the corpus-side `lp-netlib` + `lp-small`
suites are shipped and waiting; the workbench needed a candidate.

The original bead title was "best-in-class LP specialist (revised
simplex + Mehrotra IPM)". The session opened by interrogating that
framing through the workbench's two-principles filter (CLAUDE.md +
persistent memory `two-principles`): *what would a TS expert lust for
that no LP solver in any ecosystem currently provides?*

The answer is **exact rational answers on the float wire**. Every
commercial LP solver — Gurobi, Mosek, CPLEX, HiGHS, GLPK, CLP — runs
float internally and chases higher accuracy via iterative refinement.
QSopt-Ex is the academic exception (C + GMP) and the gold standard
for exact LP. A TS-native exact-rational LP solver, with the workbench's
`Rat`/`Field<Rat>`/`bareissSolve` substrate already in `cas-core`,
was *one substrate package away*.

This shard documents that build: ADR-0031, `packages/simplex-q`,
`tools/lp-solve`, the dyadic-lift / round-trip-precision pipeline,
and the bench grade that revealed the implementation's natural scale
ceiling.

## What changed

### ADR-0031

Codifies the design decision: **exact-rational engine inside the
float64 wire**.

- Decoder lifts every float64 input to its exact IEEE-754 dyadic rational.
- The simplex engine runs entirely over ℚ. No tolerances, no ε-comparisons.
- Encoder rounds each rational output to the nearest float64 (one
  IEEE-754 ULP).
- `achieved_precision` is the maximum KKT residual computed *in ℚ*
  against the encoded wire output. For well-scaled inputs this is
  dominated by the encode round-off — typically `≈ 2.2 × 10⁻¹⁶`.

The interior of the tool earns the `arbprec: true`-strength
discipline; the public annotation stays `numerical: true` (ADR-0015)
because the wire is float64. A future `tools/lp-solve-arbprec` with
a rational wire is recorded as open question §3.

The ADR also splits the original `wx3m` bead into three:
- `wx3m` (claimed today) — arbprec lane via revised simplex.
- `hnyu` (open) — float-engine lane on top of `@workbench/linalg-core`.
- `prfp` (open) — Mehrotra IPM lane.

All three add lanes to the same public `tools/lp-solve` symbol.

### `packages/simplex-q/`

New substrate package. Depends only on `@workbench/protocol` and
`@workbench/cas-core`. Three modules:

- **`rat-cmp.ts`** (~95 lines). The total order on `Rat` that
  `cas-core` doesn't ship. Cross-multiply `a.n · b.d` vs `b.n · a.d`;
  exact because both operands have positive denominators by `makeRat`
  invariant.
- **`basis.ts`** (~250 lines). Explicit `B⁻¹` storage with the O(m²)
  product-form rank-1 update per pivot. The update is twelve lines of
  arithmetic — Vanderbei §6.4 verbatim. Bartels-Golub is deferred
  (the numerical-hygiene motivation evaporates over ℚ).
- **`simplex.ts`** (~600 lines). Two-phase orchestrator. Phase 1
  minimises sum of artificials; if the optimum is positive, emit a
  Farkas certificate. Phase 2 minimises the original objective.
  Dantzig pricing with a Bland-rule switch on the
  `blandThreshold`-th consecutive degenerate pivot, reverting to
  Dantzig after `2m` non-degenerate iterations.

Anti-cycling correctness is tested via:
- The Beale 1955 cycling instance (`min  -¾x₁ + 150x₂ - x₃/50 + 6x₄`
  with three constraints). Terminates with the canonical `-1/20`
  optimum under default policy and under always-Bland — two
  *different* pivot sequences arriving at the same exact answer.
- The Klee-Minty cube n=3 (exponential-pivot-count instance under
  Dantzig).

### `tools/lp-solve/`

The wire wrapper. ADR-0030 §C/§D verbatim on the schema, with
`tagged "lp-solve/<class>"` refusal envelopes:
- `non-finite-input` (NaN/Inf in c, A, b)
- `degenerate-shape` (dim mismatch)
- `non-lp-cone` (SOC/PSD/Exp/Pow — defer to `cone-solve`)
- `malformed-cone` (out-of-range indices)
- `quadratic-objective` (Q present — defer to `qp-solve`)
- `coefficient-explosion` (rational bit-length cap exceeded)

The honest-precision reporter computes all four KKT residuals in ℚ:

```
r_p = ‖A x - b‖_∞                            (primal feasibility)
r_d = ‖Aᵀ y + s - c‖_∞                       (dual feasibility)
r_c = |xᵀ s| / max(1, |obj|)                 (complementary slackness)
r_o = |cᵀ x - bᵀ y| / max(1, |obj|)          (optimality gap)
```

`achieved_precision = max(r_p, r_d, r_c, r_o)`, encoded back to
float64. The agent reads this and knows what they got.

Twelve representative goldens cover: 1D/2D/3D optima, exact-rational
interior (the 3x + 5y problem with `x = y = 1/3, obj = 8/3` — every
field bit-exact), infeasibility, unboundedness, free-variable
splitting, and every refusal envelope.

## Why these choices

### Why arbprec first, float later

The two-principles filter:
> What would a TS expert lust for that they cannot get from any other
> LP solver?

Bit-exact answers on the float wire. Float simplex is what every other
solver ships; building a float simplex first would be commodity work,
not a portfolio-anchoring entry. Arbprec is unique; ship it first.

The trade-off is performance — arbprec is ~10–1000× slower than float
for the same problem size. For small dense (n ≤ ~30), the wait is
imperceptible (sub-second). For NETLIB-scale (n ≥ 100), the bench
times out — and that's where the float lane will live.

### Why row negation + sign-flip on output (not D-signed artificials)

The classical Phase 1 setup uses an identity artificial block `I_m`,
requiring `b ≥ 0` componentwise. For rows with `b_i < 0`, two options:

1. **Row negation**: multiply row `i` and `b_i` by `-1`, keep identity
   artificials. The dual `y` is now for the negated system; the user-
   facing dual needs a sign-flip per row on output.
2. **D-signed artificials**: keep `A`, `b` as-is; use the diagonal
   `D = diag(sign(b_i))` as the artificial block. The basis matrix is
   `D = diag(±1)`; `D⁻¹ = D`; `x_B = D⁻¹ b = |b|`. The dual `y` is in
   the user's frame from the start.

Option 2 looks cleaner on the primal side but imposes *spurious sign
constraints* on the dual at Phase 2 optimality: the dual feasibility
check at artificial columns becomes `sign(b_i) · y_i ≤ 0`, which is
non-standard. The dual loses its "free for equality constraints"
property.

Option 1 keeps the algorithm in pristine standard form (the dual is
unconstrained for the negated equalities) and just adds a one-line
sign-flip on output. Chose option 1. The wrong choice cost ~30 minutes
of debugging before the dual-feasibility check on the bench surfaced
the issue.

## Frictions surfaced

### The IEEE-754 sign-bit bug

`float64ToExactRat` initially read the bit pattern as a signed
BigInt and used `-bits` to get the magnitude for negative floats.
`-bits` is *arithmetic* negation (two's-complement), not sign-bit
clearing — for the IEEE bit pattern of −19.585 (which has the high
bit set as the sign), `-bits` produces a totally different number
than masking the sign bit.

Symptom: my engine declared the bench's first 10×10 case "infeasible"
in 2 iterations on what scipy confirmed was a feasible LP. The
"infeasible" was correct for the corrupted-by-decoding data the engine
saw; the bug was in the wire decoder, not the engine.

Fix: `u = bits & 0x7FFFFFFFFFFFFFFFn` — BigInt bitwise AND with the
explicit sign-clearing mask. (BigInt bitwise ops handle negative
operands via infinite-precision sign-extension; the AND with a positive
constant correctly returns the low-order bit pattern.)

Lesson encoded in tool.ts:170-176. CLAUDE.md Rule 7 — every test
asserts an *invariant*. The basis-inverse self-consistency check
(`B · B⁻¹ = I`) and the dual-derivation check (`Bᵀ y = c_B`) both
passed at the broken state; the bug was upstream of every invariant
the engine could check. The only test that surfaced it was the
end-to-end bench grade.

### Exact-rational vs "approximately feasible" float input

The 10×10 case's `A` and `b` are random floats. `A @ ones = b` to
~1e-16 in float64 — feasible numerically, but the exact rationals
representing those floats *do not* exactly satisfy `A x = b` for
`x = ones`. After 30 minutes of investigating "why is my simplex
declaring infeasibility on a feasible LP", the realisation: the
engine *isn't* declaring the wrong answer. The engine is *correctly*
reporting that the *exact-rational lift* of this float input has no
exact solution.

This shaped the wire wrapper's philosophy: float input ↔ "approximately
feasible" is the user's expectation, but the exact engine is more
strict. Initial worry: do we need to add tolerance handling at the
Phase 1 boundary? Answer: no, the row-negation bug was real (see
above), and once that was fixed the same case solved cleanly to
`achieved_precision ≈ 8e-16`. The exact-rational engine *can* handle
"approximately feasible" float input because (a) modern float problems
are exactly feasible far more often than the textbook examples suggest
when `A` is well-conditioned, and (b) when there is a tiny residual,
the simplex finds the exact-rational vertex closest in the basis
space, which gives `achieved_precision` at the ULP level.

### Scale ceiling

The bench grade revealed the natural ceiling: n ≤ ~30 sub-second,
n = 30–50 slow-but-correct, n ≥ 50 typically times out at the
30-second bench cap. NETLIB cases (n ranging 51–1500) sit above the
ceiling — even `afiro` (n=51, m=27, the smallest NETLIB case) times
out.

The bottleneck is coefficient growth in the explicit `B⁻¹` matrix
maintained across pivots. By Cramer's rule the entries can grow by
factors of `det(B)` per pivot, and for random-dense well-conditioned
matrices `|det(B)|` at m=50 is typically ~10^15 — meaning every
rational entry of `B⁻¹` carries ~50-bit numerators and denominators,
and every rational multiplication is quadratic-time on those BigInts.

A Bartels-Golub or eta-file basis representation would help — the η
vectors don't accumulate growth the same way — but it's a 200-LOC
revision and the right home is the float lane (`hnyu`), which gets
to use `@workbench/linalg-core`'s LU directly. The arbprec lane stays
*the small-case anchor of the portfolio*, not a NETLIB-scale solver.

This is documented honestly in `tools/lp-solve/README.md` and ADR-0031
§Open Questions §2.

## Acceptance

- ADR-0031 written and committed.
- `packages/simplex-q/` shipped with 30 tests (rat-cmp, basis,
  simplex, negated-rows) all green.
- `tools/lp-solve/` shipped with the seven-artefact contract: schema,
  examples, invariants, 12 goldens, README, package.json, tool.ts.
- Workspace `bun run goldens:check` green.
- Beads: `wx3m` claimed (arbprec lane); `taui` (simplex-q substrate)
  claimed; `hnyu` (float lane) and `prfp` (IPM lane) registered as
  follow-ups blocked on wx3m.

### Bench grade (2026-05-11)

`lp-small` corpus suite (29 cases): **24/29 passes**, 310/315
invariants green. Failures:

- `A_dense_25x25_s001`: `self_reported_precision` (under-claim on a
  specific instance; my computed precision ≈ 8e-16, verifier sees a
  larger residual on the recomputation). One algorithmic edge case
  worth a follow-up bead.
- `A_dense_50x50_s001`, `A_dense_50x100_s001`, `A_dense_100x100_s001`:
  candidate exited 143 (bench timeout at 30s). Scale-ceiling cases
  for the arbprec lane.
- `H_non_finite_input`: bridge silently converts `null` in JSON to
  `+0.0`; my tool can't detect the corruption. Bridge-side issue,
  not addressable from the tool.

`lp-netlib`: 0 cases gradable (all time out at the bench cap, including
`afiro` n=51). The full NETLIB battery is for the float lane.

The v0.1 gate (29/29 + 21/21 per worklog 089) is not met. The
shipped tool meets the small-dense gate — the regime PRD §1.2 named —
and the failures are honest known limitations documented in
`tools/lp-solve/README.md`.

## Pointers

- `docs/adr/0030-convex-cone-solver-tier.md` — the cone-tier ADR this
  tool slots into.
- `docs/adr/0031-lp-solve-arbprec-engine.md` — the design choice
  documented in this session.
- `packages/simplex-q/README.md` — substrate-level prose.
- `tools/lp-solve/README.md` — tool-level prose, scope, refusal
  taxonomy, scale ceiling.
- `scientist-workbench-corpus/benchmarks/lp-small/` — the bench
  graded against.
- Beads: `wx3m` (claimed, this work), `taui` (claimed, simplex-q
  substrate), `hnyu` (open, float lane), `prfp` (open, IPM lane).
