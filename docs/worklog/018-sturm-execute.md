# 018 — tools/sturm-execute (Phase 1, v0.1 float64)

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-tkx (closed); scientist-workbench-jfj (filed
  as deferred-exact-path follow-up)

## Context

Shard 017 closed the cas-core algebraic-numbers rung — `Q_SQRT2_I`
(`Q[√2, i]`) is now available as a `Field<AlgebraicElement<AlgebraicElement<Rat>>>`,
unblocking the long-standing tkx issue. The acceptance for tkx names
exact-symbolic Clifford+T amplitudes as the natural payoff: simulate
ry/rz at π-rational angles into a state vector with rational
probabilities, no floating-point comparison needed.

This shard is Phase 1's third tool slot (`sturm-execute`). What it
ships and what it doesn't ship are both notable, so the body of this
shard is heavier on rationale than on what-changed.

## What changed

`tools/sturm-execute/{tool.ts, package.json, README.md, goldens.spec.ts,
goldens/}` — full 7-artefact contract. Float64-only state-vector
simulator over the Sturm IR (ADR-0006), emitting the distribution shape
factored out by ADR-0007. 24 goldens covering trivial cases,
deterministic outcomes, uniform superposition, parametrised rotations,
Bell pair, GHZ-3, cases-driven feedback, multi-control, input-signature
seeding, every out-of-scope reason. Determinism + probabilities-sum-to-
one property tests in the `--test` hook. README with ADR cross-
references, main `README.md` catalog row, and `scripts/demo-scope.sh`
gains an end-to-end Bell-pair pipeline (demo 11):

```sh
echo "$BELL_PAIR_IR" | bun tools/sturm-simplify/tool.ts \
                     | bun tools/sturm-execute/tool.ts
```

`bun run check`: 18/18 phases pass. The check matrix grew from 16
phases (after shard 017) to 18 — the extra two are the new
`tool --test: sturm-execute` and `oracle: sturm-execute (24 goldens)`.

## Why these choices

### v0.1 ships float64-only; the exact path is deferred to scientist-workbench-jfj

The big deviation from the issue's "exact distributions over Q[√2, i]"
acceptance text. The reasoning, surfaced during implementation:

While amplitudes for the Clifford-like fragment {prepare(0|1|1/2),
ry(kπ/2), rz(kπ/2)} stay in Q[√2, i] under the gate-application
matrices, the *individual* basis-state probabilities |amp|² generally
land in Q[√2], not Q. Worked counterexample: the channel

```
prepare 2 qubits in |0⟩;  ry(π/2) on wire 0;
ry(π/2) controlled by wire 0 on wire 1;  ry(π/2) on wire 0
```

produces amps `[1/2 - √2/4, 1/2 + √2/4, -√2/4, √2/4]` (in Q[√2]). The
marginal P(wire_0 = 0) = (1/2 - √2/4)² + (-√2/4)² = 1/2 - √2/4 — an
*irrational* probability, even though Σ|amp|² = 1 holds rationally.

The schema's `prob: rational | float64` cannot honour these without a
new variant (a `Q[√2]`-rational shape, or extending `extras: "allow"`
on records, or…). That's a non-trivial design decision, captured in
issue scientist-workbench-jfj. Shipping float64-only first, with the
unblocker (1s4) staying useful for the future exact path, beats trying
to land both in one shot.

The tool's `precision` field is the literal `"float64"` in v0.1; the
schema admits `"exact"` as a future literal so the eventual exact
implementation slots in additively.

### Branch-with-sub-normalised-amps (no renormalisation)

After `observe`, the standard textbook formulation renormalises by
1/√Prob(outcome). For circuits in our restricted gate set, Prob(outcome)
can be irrational (per the worked example above), and √Prob is
generally even further out of any algebraic closure we'd want to live
in. The cleaner formulation: drop renormalisation entirely; carry
sub-normalised amps; the branch's probability is simply Σ|amp|² over
its current state vector. Mathematically identical; numerically
cleaner; transparently extends to the future exact path (where the
amps stay in Q[√2, i] forever, no irrational √-of-prob sneaks in).

### Numerical-precision floor at 1e-12

After `observe`, branches with Σ|amp|² below 1e-12 are dropped as
IEEE-754 noise. Without this, identities like cos(π/2) ≈ 6e-17 produce
phantom branches with prob ~1e-32 cluttering Bell-pair output (the
first run had three outcomes including (r0=1, r1=0) at ~1e-32). The
threshold is well above the IEEE noise floor (~1e-15) and well below
any physically-meaningful probability the simulator would encounter.
Documented in the tool's `--invariants` and README so callers know
exactly what's dropped; the future exact path won't need it.

### `classical_resolutions` as list-of-pairs, not record-keyed-by-ref

ADR-0007 sketched `classical_resolutions: S.record({}, { extras: "allow" })`
to encode a per-classical-ref mapping. The v0.1 schema language doesn't
admit `extras: "allow"` (per ADR-0004 §"Three deliberate omissions";
records are closed by default). Two paths considered:

1. Implement `extras: "allow"` in the schema layer.
2. Encode resolutions as a `list<record{ref, value}>` of pairs.

Path 2 wins for v0.1 — it stays within the existing schema language and
matches the `classical_refs` declaration-order list as the canonical
column ordering. Path 1 is filed implicitly under future-schema-work
(no specific issue yet); when a second tool (sturm-sample) lands and
also needs open records, that's the right time to revisit. Documented
in the tool's README as a deliberate departure from ADR-0007.

### v0.1 op support: prepare, ry, rz, observe, cases (only)

The IR vocabulary is closed at seven heads. Five of them are simulated;
two (`oracle`, `discard`) are out-of-scope:

- **oracle** would need the embedded circuit's permutation lifted into
  the simulator's state vector. Doable but non-trivial; not on the v0.1
  critical path for the killer demos (Bell, GHZ, parametrised
  rotations, feedback-conditioned execution).
- **discard** is partial trace on an entangled state. Pure-state
  simulation can't represent the resulting mixed state; we'd need
  density-matrix simulation. Honest scope says boundary-tag and file
  follow-up rather than approximate.

Both emit `tagged "sturm-execute/out-of-scope" <reason-string>` per
ADR-0003. Examples and goldens cover the boundary cases.

### Honest scope on `prepare` probabilities

`prepare(p, w)` accepts any numeric p in [0, 1]. Free symbolic p (e.g.
`sym("p")` for an unresolved parameter) → boundary-tag. Out-of-range p
→ boundary-tag with the offending value in the reason string. This
mirrors `mod-inv`'s record-with-flag pattern (ADR-0003) for boundary
conditions but uses the `tagged` shape because the failure is at
*input level*, not "the operation has no answer." `prepare(2, w)` is
malformed quantum mechanics, not "no inverse exists."

### Qubit cap at 12

`QUBIT_CAP = 12` → 4096 amplitudes max. State vector ~64 KiB. This is
enough headroom for every v0.1 example and a clean refusal point past
which a tensor-network or density-matrix simulator would be needed.
Configurable via constant for now; could become a flag in a future
iteration but YAGNI.

## Frictions surfaced

- **The exact-path realisation kicked in mid-implementation.** Initial
  plan was to ship both paths under tkx. About 30% into the exact-path
  design I worked through the Q[√2]-rational-probability counterexample
  above and realised the schema couldn't represent it without further
  design. Pivoted to "float64-only ships under tkx; jfj captures the
  exact path with its design questions." This is the kind of detail the
  worklog exists for: the unblocker (1s4) is *still* useful for the
  future path even though tkx itself doesn't consume it. The decision
  should not be re-litigated as "wasted work."

- **Phantom-branch noise is annoyingly large.** The first Bell-pair run
  produced three outcomes; the third was (r0=1, r1=0) with prob 1.6e-32
  from `cos(π/2) ≈ 6e-17`. The 1e-12 threshold strips this cleanly, but
  it reminds you that float64 simulation is not numerically clean even
  for the simplest entangled circuits — every gate matrix is computed
  via `Math.cos`/`Math.sin` and accumulates error. The exact path is
  the right answer for this; in the meantime, the threshold is
  documented invariant rather than hidden hack.

- **The header-comment grew long.** ~80 lines of literate docs at the
  top of `tool.ts` covering intent, scope, output shape, algorithm,
  references. Per CLAUDE.md Rule 10 ("literate programming"), source
  files are exposition. Reading the tool from line 1 to line 100 should
  give a fresh reader the full picture. I think it does, but the file
  is now ~900 lines total — at the upper end of "single tool.ts" before
  extraction to a sturm-sim/ package becomes warranted. Not warranted
  yet; the simulation logic is small enough.

- **`Math.cos(Math.PI/4)` round-trips through cos²+sin² = 1 ± ulp.** The
  goldens for H-equivalent (`prepare(0); ry(π/2); observe`) show probs
  `3fe0000000000001` (≈ 0.5000000000000001) and `3fdffffffffffffe`
  (≈ 0.49999999999999983). The 1-ulp gap is below the precision floor
  but above byte-equality, so goldens snapshot the exact bytes. Future
  changes to gate-matrix construction (e.g., using
  `Math.cos(theta * 0.5)` vs `Math.cos(theta) / 2`) would shift these
  ulps; goldens catch the drift. Standard float64-determinism cost of
  doing business.

## Acceptance

- 7-artefact contract — tool.ts, package.json (sans cas-core dep —
  removed when float64-only path was settled), README.md,
  goldens.spec.ts, goldens/ (24 entries), --test hook, --schema
  conformance.
- `bun run check`: 18/18 phases green.
- 24 goldens regenerate cleanly (`bun scripts/generate-goldens.ts
  --check --tool sturm-execute` is a no-op on a clean run).
- Bell-pair end-to-end pipeline works in `scripts/demo-scope.sh`
  (demo 11), composed through `sturm-simplify | sturm-execute`.
- Main README catalog row added.
- ADR-0007's distribution shape implemented (with the documented
  list-of-pairs deviation for `classical_resolutions`).
- ADR-0006 channelSchema consumed verbatim as the input shape via
  `decodeChannel`.
- ADR-0003's three output categories all exercised: in-scope happy-
  path record (deterministic outcomes), in-scope happy-path with
  multiple outcomes (uniform / Bell), boundary-tag for every
  out-of-scope reason.
- Issue scientist-workbench-tkx closed.
- Issue scientist-workbench-jfj filed for the deferred exact path,
  with the design questions explicitly captured (probability shape,
  renormalisation strategy, recogniser API).

## Pointers

- `tools/sturm-execute/tool.ts` — the literate implementation.
- `tools/sturm-execute/README.md` — agent-facing reference.
- `tools/sturm-execute/goldens.spec.ts` — 24 representative inputs.
- `docs/adr/0006-sturm-ir-as-value.md` — input shape (channelSchema).
- `docs/adr/0007-distribution-vs-sampling.md` — output shape; this
  shard implements it.
- `docs/adr/0003-tool-output-error-patterns.md` — the boundary-tag
  pattern for out-of-scope inputs.
- `scripts/demo-scope.sh` demo 11 — the end-to-end pipeline.
- Shard 015 — `sturm-simplify`, the IR canonicaliser that flows into
  this tool.
- Shard 017 — `cas-core` algebraic numbers, the unblocker (still
  useful for the future exact path despite v0.1 not consuming it).
- Issue scientist-workbench-jfj — the deferred exact path; the next
  rung when the schema-shape design for irrational probabilities is
  resolved.
- Issue scientist-workbench-564 (`sturm-equivalent`) — now naturally
  next on the Phase 1 critical path; can use `sturm-execute` to
  decide circuit equivalence by distribution comparison.

Next ready: scientist-workbench-564 (`sturm-equivalent`), or
scientist-workbench-bir (`sturm-sample`, Phase 2) once `entropy-source`
ships under kw1.
