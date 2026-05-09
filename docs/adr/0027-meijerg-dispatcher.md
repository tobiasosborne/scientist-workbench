# ADR-0027 — `meijer-core` top-level dispatcher (Layer 7, v0.1)

**Status:** Accepted — 2026-05-09
**Beads:** `scientist-workbench-hv0.10` (this ADR +
`packages/meijer-core/src/dispatcher.ts` kernel + `tools/meijer-g`
wire tool); parent epic `scientist-workbench-hv0` (problem-13
Meijer G mega-test).
**Related:**
- ADR-0003 (three output categories — happy / record-with-flag /
  tagged-boundary). The dispatcher is the canonical example: a
  single happy-path success record, a structured tagged refusal
  envelope, and `ToolError` for malformed input.
- ADR-0010 (`defineTool` / `runTool` shape — the wire wrapper).
- ADR-0012 (in-process composition; `executeToolDef`). The
  dispatcher reaches for the in-process surface for every layer
  hop; subprocess composition would put a 50-300 ms floor on every
  hop and obliterate the cost-ascending discipline.
- ADR-0017 (solution-set shape — `tools/solve`'s discriminated
  union of "happy / refused" precedent). Mirrored here for "happy
  symbolic / happy numerical / refused".
- ADR-0020 (arb-prec tier — `arbprec: true` + standard
  `--precision=<int>` flag). Inherited by `tools/meijer-g`.
- ADR-0021 / ADR-0022 (BigComplex G7K15 driver). Underpins the
  contour layer the dispatcher calls.
- ADR-0023 (cas-core special-function vocabulary). The symbolic
  output's AST lives in this vocabulary.
- ADR-0025 (Layer 4 symbolic dispatch — `meijergSymbolic`). The
  cost-zero head of the dispatch ladder.
- ADR-0026 (Layer 6 Braaksma asymptotic — `meijergAsymptotic`). The
  far-field tail of the dispatch ladder.

**References:**
- B. L. J. Braaksma 1964. *Compositio Math.* **15**: 239–341. (via
  Layer 6.)
- R. B. Paris & D. Kaminski 2001. *Asymptotics and Mellin–Barnes
  Integrals.* CUP. (via Layer 5.)
- L. J. Slater 1966. *Generalized Hypergeometric Functions.* CUP.
  §5 (via Layer 3.)
- NIST DLMF §16.17.1. *Branch convention for the Meijer G integral.*
  The principal-branch convention `log z = log|z| + i·arg z` with
  `arg z ∈ (−π, π]` that this dispatcher pins for every numerical
  path.
- NIST DLMF §16.21. *Differential equation for the Meijer G.* The
  ODE residual self-test.
- `docs/worklog/054-solve-dispatcher.md`. The `tools/solve`
  precedent. Two principles applied: a TS expert reading a flat
  switch over a discriminated union of verdicts.

## Context

Layer 7 of the seven-layer Meijer G stack — the **top-level
dispatcher**. Six lower layers are now in place:

- Layer 3 (Slater residue summation, `slater.ts`, `hv0.5`) — sums one
  of two formal residue series; refuses in the `|z|≈1` quarantine
  band when `p=q ∧ m+n=p`.
- Layer 4 (symbolic dispatch, `dispatch.ts`, `hv0.6`) — pattern-table
  reducer; emits closed-form AST when a rule fires.
- Layer 5 (Mellin–Barnes contour quadrature, `contour.ts`, `hv0.8`)
  — direct vertical-contour numerical integration; refuses when the
  integrand does not decay (`2(m+n) ≤ p+q`) or when the Γ-pole
  clusters overlap.
- Layer 6 (Braaksma asymptotic, `asymptotic.ts`, `hv0.9`) — far-field
  algebraic dominant asymptotic; refuses outside the principal
  sector and for `|z| < 1`.

Each layer has its own structured-refusal envelope. Composing them
into a single `tools/meijer-g` evaluator is the climactic deliverable
of `scientist-workbench-hv0`: every tier of the
`tstournament/.../problem-13` verifier (Tiers 0 / A / B / C / D / E
/ F / G / H) lands cleanly in one of three output shapes — symbolic
AST, arbprec numerical record, or tagged refusal envelope.

The mathematical surface is too large for any single layer. The
dispatcher's job is the *routing*: each layer's "I can handle this"
check is a fast pre-filter; the dispatcher tries methods in
**cost-ascending order**; the first success wins; if every method
refuses, the dispatcher constructs a single integrated refusal
envelope that names which methods refused and why.

This ADR pins the conventions. The implementation is deliberately
mechanical so a TS expert reading the dispatch loop sees a flat
switch over four lanes — no bespoke envelope handling per layer.

## Decision

### 1. Cost-ascending dispatch order

The dispatcher tries layers in this fixed order:

| Order | Layer | Cost (empirical, 50 dps) | Refuses on |
|---|---|---|---|
| 1 | symbolic (`meijergSymbolic`) | < 1 ms | no rule matches |
| 2 | Slater (`meijergSlater`) | 1–100 ms | `|z|≈1 ∧ p=q ∧ m+n=p`; non-convergent inner pFq |
| 3 | contour (`meijergContour`) | 50 ms – 5 s | `2(m+n) ≤ p+q`; overlapping pole clusters |
| 4 | asymptotic (`meijergAsymptotic`) | 1 ms – 100 ms | `|arg z| ≥ π/2 − π/64`; `|z| < 1`; `n = 0`; non-asymptotic regime |
| 5 | refuse | n/a | (always; emits the integrated refusal envelope) |

The empirical costs come from worklogs 070 (Slater), 073 (contour),
and 078 (asymptotic). Symbolic is essentially free — it is one
table walk over `~30` rules at v0.1.

The order is **not data-dependent**: we don't try to predict which
method will be cheapest for a given input. The pre-filters are the
prediction. If symbolic doesn't match, Slater is tried regardless
of `|z|`; if Slater refuses with `quarantine-band`, contour is
tried; if contour refuses with `non-convergent-contour`, asymptotic
is tried. The order is **correctness-first**: symbolic is always
exact when it fires; Slater is convergent in the bulk of the
parameter space; contour and asymptotic cover the corners.

The asymptotic **before** the contour would not be wrong — they
cover overlapping regimes — but reaching for asymptotic when
contour also applies is wasteful (the asymptotic typically gives a
slightly worse achieved precision than the contour at the same
working precision). The chosen order means asymptotic is the
*last* numerical resort, not a first guess.

### 2. Pre-filters per layer

Each layer's "can I handle this?" check is a **pure-function
predicate** colocated with the dispatcher, not buried inside the
layer's body. The dispatcher reads the predicate; if the predicate
returns false, the layer is skipped entirely (no speculative call).

```
canUseSymbolic(params)            // try the rule table
canUseSlater(params, z)           // n + m ≥ 1; not in the quarantine band
canUseContour(params, z)          // 2(m+n) > p+q; pole clusters separate
canUseAsymptotic(params, z, prec) // n ≥ 1; |z| ≥ 1; |arg z| < π/2 − π/64
```

These predicates sometimes shadow checks the layers themselves
perform. That's deliberate redundancy: the dispatcher needs to know
which lanes are *applicable* before invoking any of them, so the
refusal envelope (when every lane is inapplicable) can list precise
reasons. If the predicate says "yes" but the layer refuses anyway
(e.g. cancellation-driven retries exhausted), that refusal is
folded into the envelope identically.

### 3. Principal-branch convention pin

DLMF §16.17.1 defines the Meijer G integral with `z^s = exp(s · log
z)`, taking the **principal branch**:
`log z = log|z| + i·arg z` with `arg z ∈ (−π, π]`.

Every numerical layer uses `clog` from `@workbench/bigfloat`, which
implements this branch. The dispatcher does *not* re-pre-process
`z` — the branch is already correct on input. It does, however,
*assert* the convention via the Schwarz reflection self-test (§5
below).

What the dispatcher pins explicitly: when `Im(z) = 0 ∧ Re(z) < 0`
(the cut), the principal-branch convention places the value
infinitesimally above the cut (`arg z = +π`). This is a structural
choice; the dispatcher does not silently flip to the
"infinitesimally below the cut" branch even if it would give a
prettier answer. Inputs that genuinely live on the cut and want
the *other* branch are the caller's responsibility — they pass `z`
with a small negative imaginary part.

### 4. Two output shapes (plus refusal)

Per ADR-0003 / ADR-0017:

```
output:
  | record { kind: "symbolic", expr: <AST>, rule: string,
             source: string, note: string, method: string }
  | record { kind: "numerical", value: <bigcomplex>,
             achieved_precision: integer, method: string,
             warnings: list<string> }
  | tagged "meijer-g/<class>" record { ... }
```

Refusal classes:
- `out-of-region` — every method refused; payload lists which
  layers said no and why.  This is also the integrated envelope
  for ≥3-pole integer-spaced coalescence (worklog 085 / bead
  `scientist-workbench-fwsz`): the Slater layer's
  `coalescence-needs-higher-order-residue` refusal short-circuits
  the remaining numerical lanes (contour and asymptotic both
  inherit the same Γ-pole-cluster cost-unbound issue), and the
  ruled-out-methods list surfaces the Slater status verbatim so a
  caller can act on it.
- `branch-cut-ambiguous` — input lies on the negative real axis
  with `Im(z) = 0` and the dispatcher cannot honestly decide which
  branch the caller wanted (we deliberately do *not* hide this
  behind silent "principal branch wins").
- `non-finite-input` — z contains NaN or Inf.
- `degenerate-shape` — m + n = 0 (no Γ-pole line for any layer to
  close).

Slater-layer refusal sub-classes (surfaced via the `ruled_out_methods`
list when Slater refuses):
- `quarantine-band` — `|z|≈1 ∧ p=q ∧ m+n=p`; neither residue series
  converges at the contour boundary.
- `non-convergent-pfq` — inner pFq refused after retries (Borel
  region or unrecoverable parameter-pole).
- `coalescence-budget-exhausted` — the working-precision cap
  (`maxWorkingBits`, default `12 · target_bits + 256`) was reached
  while still chasing cancellation bumps.  The orchestrator refuses
  rather than continue doubling — bounded cost beats unbounded
  hang.  (Bead `scientist-workbench-fwsz`.)
- `coalescence-needs-higher-order-residue` — ≥3 parameters in `bm`
  (or `an`) lie in the same integer-spacing equivalence class.  The
  Johansson odd-coefficient perturbation handles 2-pole pairs
  cleanly but ≥3-pole clusters require the closed-form Slater 1966
  §5 higher-order residue (`digamma`/`polygamma` formulae) which
  v0.1 does not implement; the dispatcher emits the structured
  refusal upfront rather than chase a hang.  (Bead
  `scientist-workbench-fwsz`.)

The two-record discriminated-union shape (`kind: "symbolic"` vs
`kind: "numerical"`) is loaded with intent: a TS expert
pattern-matches on `kind` and gets the rest of the fields typed
straightforwardly. The alternative — one record with optional
`expr` and optional `value` — would have every consumer testing
"does `expr` exist?" before reading. The two-shape discrimination
is one switch deep; the optional-field shape is two-conditional
deep.

### 5. Output-tier conditioning

Per the CLAUDE.md hallucination-risk callout on the determinism
contract: per-output tier conditioning is honest. When the symbolic
path returns, the result is exact and contains no precision-bearing
floats; the output record carries no `achieved_precision` field
(symbolic outputs *cannot* claim a precision). When the numerical
path returns, the `achieved_precision` field is populated with the
user-requested precision (which the layer guarantees by
construction; `arbprec: true` is bit-deterministic given precision).

The wire schema permits both shapes via the union; the in-process
caller pattern-matches on `kind`.

#### Empirical precision estimator on the perturbation path

Worklog 084 / bead `scientist-workbench-7usr` adds a second-order
honesty layer for the Slater perturbation path.  When integer-spaced
coalescence triggers Johansson's `hmag` perturbation, the simple-pole
Slater formula is being treated as the `(ε_i − ε_j) → 0` L'Hôpital
limit — and the closed-form bound on its residual (and on the
floating-point cancellation noise that survives at finite working
precision) is fragile.  Empirically, the dispatcher's earlier
default of `pertBits = workingBits / 2` left the result with only
~14 dps of relative agreement vs mpmath at 110 dps for some 2-pole
half-integer-spaced cases, while the orchestrator reported
`achieved_precision = 50`.

The fix: when perturbation fires, run a *second* residue-summation
pass at a minimally smaller perturbation magnitude (`pertBits + 1`
— ε halved exactly once) and compute
`achievedPrecision = floor(−log10(|Δ|/|S|)) − 1`, capped at the
user-requested precision.  The reported `achieved_precision` is now
honest about the L'Hôpital + cancellation noise floor; the wire
verifier's `_check_self_reported_precision` enforces
`achieved_precision ≤ requested_precision` separately.

Cost: one extra residue-summation pass when perturbation fires (no
cost on the non-coalescent fast path).  The estimator can be
disabled via `MeijerGSlaterOptions.estimatePrecision = false` for
regression-mode comparison against pre-fix goldens.

### 6. Schwarz reflection self-test

For non-cut `z` (`Im(z) ≠ 0` and not at the boundaries `arg z = ±π`),
`G^{m,n}_{p,q}(real_params; z̄) = conj(G^{m,n}_{p,q}(real_params; z))`.

This is a load-bearing invariant of the principal-branch
convention. The dispatcher exposes a self-test mode (off by default
in production; on in test mode and via the `--schwarz-check` flag)
that:

1. Computes `g_z = dispatch(params, z)`.
2. Computes `g_zbar = dispatch(params, conj(z))`.
3. Asserts `cabs(g_zbar - conj(g_z)) ≤ 10^{-(precision − 5)}`.

A mismatch is surfaced as a warning on the success record, not a
hard failure. The threshold accepts the per-method precision
margin without false-positiving on the working-precision
discipline.

### 7. Force-method flag for self-tests

`--force-method=symbolic|slater|contour|asymptotic` short-circuits
the dispatch ladder and forces the named method. If the forced
method refuses, the dispatcher emits the layer's refusal directly
(wrapped in the `meijer-g/forced-method-refused` tag). The flag is
load-bearing for the method-agreement self-test (worklog
shard); on inputs where multiple methods can succeed, force each
in turn and assert all agree to user precision.

### 8. Request mode

`--request-mode=auto|symbolic-required|numerical-required`:

- `auto` (default) — full cost-ascending dispatch; first success wins.
- `symbolic-required` — only try the symbolic layer; refuse if no
  rule fires (with the layer's `no-known-reduction` reason wrapped
  in `meijer-g/symbolic-required-no-match`).
- `numerical-required` — skip the symbolic layer; start at Slater.
  Useful when the caller wants a numerical answer with diagnostics
  (e.g. `achieved_precision`, `working_precision`, `warnings`) even
  for inputs that have a symbolic match.

The mode is part of the input shape, not a flag, so it threads
through the value-protocol's caching identity.

### 9. The integrated refusal envelope

When every applicable layer refuses, the dispatcher emits a single
`tagged "meijer-g/out-of-region"` envelope:

```json
{
  "kind": "tagged",
  "tag": "meijer-g/out-of-region",
  "payload": {
    "kind": "record",
    "fields": {
      "reason": "every layer refused; see ruled_out_methods",
      "ruled_out_methods": [
        {"method": "symbolic", "status": "no-known-reduction", "reason": "..."},
        {"method": "slater", "status": "quarantine-band", "reason": "..."},
        {"method": "contour", "status": "non-convergent-contour", "reason": "..."},
        {"method": "asymptotic", "status": "secondary-sector", "reason": "..."}
      ]
    }
  }
}
```

This is the *single* envelope the caller (notably `hv0.11`'s golden
battery) consumes for refused inputs. No bespoke per-layer error
handling at the call site.

### 10. Determinism

`arbprec: true`. Default `--precision=50`. Same `(input, precision,
explicit-flags)` ⇒ same output bytes, on every platform, forever.
The precision flag is part of the input identity; different
precisions cache to different output hashes.

### 11. `--precision=N` flag wiring (lc1 / rn2 — landed worklog 083)

Earlier drafts of this ADR called out a runner-side gap (bead
`scientist-workbench-lc1`) where the standard `--precision=N` flag was
parsed but not threaded into the arbprec tool's `flags` object visible
to `fn` — CLI invocation always ran at default `precision = 50`. The
companion bead `rn2` named the parallel gap in `@workbench/compose`'s
`runWorkbench`, which validated partial flags against `def.flags`
directly and rejected `{ precision: 50n }` as an unknown flag.

Both gaps are closed (worklog 083). The runner now exports
`mergedFlags` and `toolFacingFlags` as the single source of truth for
arbprec tools' admissible-flag set; both surfaces validate against the
same shape, keeping the ADR-0012 byte-identical contract honest.
`tools/meijer-g` inherits the fix transparently — no code change in
the dispatcher itself.

## Consequences

### Positive

1. **Single integrated tool.** A caller invokes `tools/meijer-g`
   with parameters and `z`; gets back one of three honest output
   shapes. No need to know that there are four numerical paths or
   six refusal classes.
2. **Cost-ascending discipline.** The fastest method that can
   handle the input is the one used. No speculative trying; no
   silent fallbacks.
3. **Honest refusal.** Inputs that fall through every layer
   produce a structured refusal envelope listing which methods
   said no and why. The next layer (planner, agent, human reader)
   can act on it.
4. **Branch-cut convention pinned.** Every numerical path uses the
   same principal branch; the Schwarz reflection self-test catches
   inconsistencies at test time, not at verifier-tier-F time.
5. **Two-shape output discrimination.** A TS expert switches on
   `kind: "symbolic"|"numerical"|tagged` and the rest of the
   fields are typed.

### Negative / accepted

1. **Method-agreement is an invariant, not a primitive.** The
   dispatcher does not run two methods and compare; it runs the
   first one that can handle the input. The method-agreement
   *test* is a separate thing — `--force-method` plus a wrapper
   that sweeps. This is the right factoring (the dispatcher's job
   is fast routing, not redundant computation), but it means a
   bug in one layer that produces a wrong-but-shaped value would
   pass the dispatcher's own contract checks; the method-
   agreement test is what catches it.
2. **Quarantine band beyond all four lanes.** Some inputs fall
   through every layer (e.g. `|z| ≈ 1` with `p ≠ q` and `2(m+n) ≤
   p+q`). The honest-refusal envelope is the right answer for
   v0.1; v0.2 may file targeted follow-up beads (saddle-point
   contour deformation, full Braaksma sectorial connection
   coefficients).
3. **~~`lc1` runner gap~~** — *Resolved (worklog 083).* The runner now
   threads `--precision=N` correctly into the tool's `flags.precision`
   slot for `arbprec: true` tools; CLI and in-process surfaces produce
   byte-identical outputs at the same precision per ADR-0012.
4. **No layer caching.** A layer that succeeded but the caller
   would prefer a *different* layer's answer (e.g. for diagnostic
   reasons) cannot retrieve it without re-running. The
   `--force-method` flag is the only re-entry. This is fine for
   v0.1; if a use-case for "give me all four method's answers"
   emerges, it can be added as a flag.

## Implementation pointers

- `packages/meijer-core/src/dispatcher.ts` — kernel and predicates.
- `packages/meijer-core/src/index.ts` — barrel export.
- `tools/meijer-g/tool.ts` — wire wrapper.
- `tools/meijer-g/tool.test.ts` — Schwarz reflection,
  method-agreement, mutation-prove, bit-determinism.
- `tools/meijer-g/goldens.spec.ts` — Tier 0 / A / C / D / E / F /
  G goldens.
- `docs/worklog/080-meijerg-dispatcher.md` — the shipping shard.

## Pointers to alternative designs considered

- **Tier-conditioned dispatcher.** A discriminated union
  `tier: "exact" | "convergent" | "asymptotic" | "refused"` instead
  of `kind: "symbolic" | "numerical" | tagged`. Rejected: the
  consumer cares about *what* they got back (an AST or a
  bigcomplex value), not which mathematical regime produced it.
  Method name is a diagnostic field, not a discriminator.
- **Try-all-and-vote.** Run every applicable layer; if they
  disagree, raise an error. Rejected: the cost-ascending
  discipline is fundamental — symbolic is essentially free,
  asymptotic is `O(precision)` Γ-evaluations, contour is
  `O(precision · log|z|)` Γ-evaluations, Slater is somewhere in
  between. Trying all of them is `5×` the cost of trying just the
  one that fits.
- **Auto-precision-bump on refusal.** If contour refuses with a
  precision-loss warning, retry at higher precision. Rejected: the
  layer's job is to be honest about what it can deliver; the
  caller's job is to pick a precision they can live with. The
  `precision` flag is part of input identity.
