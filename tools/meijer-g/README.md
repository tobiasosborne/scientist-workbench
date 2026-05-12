# meijer-g

Top-level dispatcher for the Meijer G-function. Single integrated
evaluator that composes the four algorithmic layers of
`@workbench/meijer-core` (symbolic dispatch, Slater residue
summation, Mellin–Barnes contour quadrature, Braaksma asymptotic)
into a cost-ascending dispatch ladder with honest refusal.
ADR-0027 is the design pin; worklog 080 is the shipping shard.

Climax of the seven-layer Meijer G stack
([`docs/worklog/070`-…-`078`](../../docs/worklog/)). Every input
lands in one of three honest output shapes — symbolic AST,
arbprec numerical record, or tagged refusal envelope.

## When to use this vs the layer-only siblings

| Tool | Use for |
|---|---|
| `tools/meijer-g` (this) | **Production evaluation.** Cost-ascending dispatch; first applicable method wins. The user-facing entry point. |
| `tools/meijer-g-symbolic-only` | Diagnostic / regression: pin the symbolic layer's coverage. |
| `tools/meijer-g-slater-only` | Diagnostic / regression: force the Slater residue path. |
| `tools/meijer-g-asymptotic-only` | Diagnostic / regression: force the Braaksma asymptotic path. |
| (No `meijer-g-contour-only`) | Use `tools/meijer-g --force-method=contour` or call `meijergContour` directly via composition. |

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "an": { "kind": "list", "items": [/* bigcomplex */] },
    "ap": { "kind": "list", "items": [/* bigcomplex */] },
    "bm": { "kind": "list", "items": [/* bigcomplex */] },
    "bq": { "kind": "list", "items": [/* bigcomplex */] },
    "z":  /* bigcomplex */,
    "request_mode": "auto" | "symbolic-required" | "numerical-required"  // optional
  }
}
```

The four-tuple split `(an, ap, bm, bq)` is the same as
`tools/meijer-g-slater-only` and `tools/meijer-g-asymptotic-only`.
Each entry is a `bigcomplex` (encoded via `bigcomplexSchema` from
`@workbench/bigfloat`); `z` is a single bigcomplex.

For the symbolic layer to fire, integer-real BigComplex parameters
(e.g. `cfromInts(0n, 0n, …)` for the parameter `0`) get an `int(n)`
Value-AST view so the Bateman §5.6 / DLMF §16.18 rule patterns can
match them. Non-integer / complex BigComplexes round-trip through
the BigComplex codec; the symbolic dispatcher returns
`no-known-reduction` for those, and the numerical lanes handle them.

## Output

One of three honest shapes (ADR-0027 §4):

### Symbolic match

```jsonc
{
  "kind": "record",
  "fields": {
    "kind": "symbolic",
    "expr": /* AST in the special-function vocabulary */,
    "rule": "bateman-5-6-8",
    "source": "Bateman §5.6 (8)",
    "note": "G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}",
    "method": "symbolic-dispatch"
  }
}
```

### Numerical success

```jsonc
{
  "kind": "record",
  "fields": {
    "kind": "numerical",
    "value": /* bigcomplex */,
    "achieved_precision": 50,
    "method": "slater-series-1" | "slater-series-2" | "mellin-barnes" | "braaksma-algebraic",
    "working_precision": 196,
    "warnings": [/* string */],
    "diagnostics": { /* method-specific (n_terms, n_evals, perturbationApplied, …) */ }
  }
}
```

### Refusal

```jsonc
{
  "kind": "tagged",
  "tag": "meijer-g/<class>",
  "payload": {
    "kind": "record",
    "fields": {
      "reason": "every applicable method refused; see ruled_out_methods for per-layer reasons",
      "ruled_out_methods": [
        { "method": "symbolic-dispatch", "status": "no-known-reduction", "reason": "..." },
        { "method": "slater-series-1",   "status": "quarantine-band",     "reason": "..." },
        { "method": "mellin-barnes",     "status": "non-convergent-contour", "reason": "..." },
        { "method": "braaksma-algebraic","status": "secondary-sector",    "reason": "..." }
      ]
    }
  }
}
```

Refusal classes (the `<class>` suffix):

- `out-of-region` — every applicable layer refused.
- `non-finite-input` — z or a parameter contains NaN/Inf.
- `degenerate-shape` — m + n = 0.
- `symbolic-required-no-match` — `request_mode = symbolic-required` and no rule matched.
- `forced-method-refused` — `--force-method=<lane>` and that lane refused.
- `input-error` — malformed precision / out-of-range flag.

## How

Cost-ascending dispatch (ADR-0027 §1):

| Order | Layer | Cost (50 dps) | Refuses on |
|---|---|---|---|
| 1 | symbolic | < 1 ms | no rule matches |
| 2 | Slater | 1–100 ms | quarantine band; non-convergent inner pFq |
| 3 | contour | 50 ms – 5 s | `2(m+n) ≤ p+q`; overlapping pole clusters |
| 4 | asymptotic | 1 ms – 100 ms | `\|arg z\| ≥ π/2 − π/64`; `\|z\| < 1`; `n = 0` |
| 5 | refuse | n/a | (always; emits the integrated refusal envelope) |

Each layer's pre-filter (`canUseSlater`, `canUseContour`,
`canUseAsymptotic`) decides "applicable here?" before any
numerical work runs. The dispatch loop is a flat switch over
four lanes; no bespoke envelope handling per layer.

**Principal-branch convention (DLMF §16.17.1).** Every numerical
layer uses `log z = log|z| + i·arg z` with `arg z ∈ (−π, π]`.
On-cut z (`Im(z) = 0 ∧ Re(z) < 0`) places the value above the
cut by convention; the result's `diagnostics.onBranchCut` field
flags this for downstream consumers.

**Schwarz reflection self-test.** With `--schwarz-check`, after
a successful numerical evaluation the dispatcher computes G(z̄)
and asserts `cabs(G(z̄) − conj(G(z))) ≤ 10^{-(precision − 5)}`.
A mismatch attaches a warning to the success record; off by
default in production, on in `tool.test.ts`.

## Invariants

- **Deterministic.** `arbprec: true` — bit-identical cross-platform
  forever given `--precision=N`.
- **Cost-ascending dispatch.** Symbolic match wins over numerical
  on every input where it applies.
- **Honest refusal.** Inputs that fall through every applicable lane
  return tagged `meijer-g/out-of-region` with a `ruled_out_methods`
  list naming each refused lane.
- **Principal-branch pinned.** All numerical lanes share the
  DLMF §16.17.1 convention; Schwarz reflection self-test detects
  inconsistencies.
- **Method-agreement.** Forcing each lane via `--force-method`
  produces values that agree to user precision (less a 5-digit
  margin); covered in `tool.test.ts`.

## Run

```sh
# In-process composition (recommended for agents):
bun -e 'import("@workbench/compose").then(async (m) => {
  const wb = await m.workbench();
  const out = await wb.run("meijer-g", { /* input */ }, { precision: 50n });
  console.log(out);
})'

# Subprocess (for shell composition / tool isolation):
echo '<canonical input json>' | bun tools/meijer-g/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --precision=<int>`

## Tool-specific flags

- `--force-method=<lane>` — force a specific dispatch lane
  (`symbolic|slater|contour|asymptotic`). Bypasses the
  cost-ascending dispatch. Useful for the method-agreement
  self-test.
- `--schwarz-check` — run the Schwarz-reflection self-test on
  numerical success.

## Validation

The golden battery has been migrated to the corpus (ADR-0028):
`scientist-workbench-corpus/benchmarks/meijer-g/` — 95-case battery,
450 invariant assertions, nine tiers (0 closed-form anchors through
G refusal envelope + H cross-cutting speed gate). Oracles: mpmath at
110 dps + Wolfram at 110 dps (dual-oracle per ADR-0019 §3); Tier-0
symbolic anchors re-evaluated at 200 dps. Mutation-proven via
`golden/test_mutations.py`.

To run: `PATH=/home/tobias/.amp/bin:$PATH bash scripts/bench-grade.sh meijer-g`
from the workbench root.

35 wire tests (`tool.test.ts` + the Schwarz-reflection self-test on
every numerical success case in the batch).

Additional details:

- **`canUseContour` pre-filter**: refuses `m = 0` or `n = 0` at `|z| ≥ 1`
  (contour quadrature requires at least one pole sequence on each
  side). Tested explicitly in Tier-G.
- **`request_mode` three-way gate semantics**: `"auto"` (cost-ascending
  default), `"symbolic-required"` (returns
  `meijer-g/symbolic-required-no-match` if no rule fires), and
  `"numerical-required"` (skips the symbolic layer). The verifier
  checks all three gate behaviours for applicable inputs.
- **`diagnostics.onBranchCut`**: boolean field set `true` when `z` is
  on the branch cut (Im(z) = 0 ∧ Re(z) < 0). Downstream consumers
  match on this flag to decide whether to perturb or accept the
  above-cut convention (DLMF §16.17.1).

## Related

- ADR-0027 — design pin.
- `docs/worklog/080-meijerg-dispatcher.md` — shipping shard.
- `packages/meijer-core/src/dispatcher.ts` — the kernel.
- `tools/meijer-g-symbolic-only`, `tools/meijer-g-slater-only`,
  `tools/meijer-g-asymptotic-only` — diagnostic siblings.
- `tstournament/.../problem-13/PLAN.md` — the seven-layer plan;
  `tools/meijer-g` closes Layer 7.
