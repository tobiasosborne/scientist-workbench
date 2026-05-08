# ADR-0025 — `meijer-core` Adamchik–Marichev + Roach symbolic dispatch (Layer 4)

**Status:** Accepted — 2026-05-08
**Beads:** `scientist-workbench-hv0.6` (this ADR + the
`packages/meijer-core/src/dispatch.ts` orchestrator + the
`dispatch-rules/` files it organises + the `tools/meijer-g-symbolic-only`
wire wrapper); parent epic `scientist-workbench-hv0` (problem-13
Meijer G mega-test).
**Related:** ADR-0023 (the special-function vocabulary the dispatcher
emits *into*: 27 heads, 15-head differentiable subset; the dispatched
candidate is in this AST). ADR-0009 (TS-native idiom — what does a
TS expert want when reading a rule table?). ADR-0010 (`defineTool` /
`runTool` shape — the wire wrapper). ADR-0003 (three output categories;
no-known-reduction is a *boundary failure*, tagged). ADR-0013 (the
`cas-simplify` engine reused for canonicalisation post-dispatch).
ADR-0020 (arb-prec tier — adjacent; the symbolic path itself is
*not* arbprec but its outputs feed numerical-tier consumers).
**References:**
- V. Adamchik & O. I. Marichev 1990. "The algorithm for calculating
  integrals of hypergeometric type functions." *Proc. ISSAC '90*,
  212–224. [DOI 10.1145/96877.96930](https://doi.org/10.1145/96877.96930).
  The three-step algorithm: pattern-recognition → reduction → simplify.
- K. Roach 1996. "Hypergeometric function representations." *Proc.
  ISSAC '96*, 301–308.
- K. Roach 1997. "Meijer G function representations." *Proc. ISSAC
  '97*, 205–211. [DOI 10.1145/258726.258784](https://doi.org/10.1145/258726.258784).
- A. Erdélyi, W. Magnus, F. Oberhettinger, F. G. Tricomi 1953.
  *Higher Transcendental Functions Vol. I* (Bateman Manuscript
  Project), McGraw-Hill, §5.6 pp. 215–222. The starter-table source
  of truth.
- NIST DLMF §16.18 [dlmf.nist.gov/16.18](https://dlmf.nist.gov/16.18).
  Contemporary index of elementary-function reductions.
- V. S. Adamchik 1997. "Definite Integration in Mathematica V3.0."
  Self-published preprint. Pedagogical exposition of the
  Adamchik–Marichev pipeline.

## Context

Layer 4 of the seven-layer Meijer G stack (`PLAN.md` table row 4) is
the **symbolic dispatcher**: given input parameters `(m, n, p, q, an,
ap, bm, bq, z)`, walk a curated table of ~1300 reduction rules
(Bateman §5.6 + PBM Vol 3 §8.4 + Mathai 1993 + DLMF §16.18 + Wolfram
Functions Site) and emit a closed-form expression in the
special-function vocabulary just shipped by `hv0.2` /
ADR-0023. Tier A (12 elementary cases) and Tier B (25 special-function
cases) of the problem-13 verifier are the symbolic-output tiers and
hit this layer exclusively. The numerical Slater path (Layer 3,
`hv0.5`) is independent — when the dispatcher has no rule, the input
falls through to the numerical layer; when it does, the closed form
is the cheaper and exact answer.

**Curating ~1300 rules is multi-session-scale.** This ADR pins the
*infrastructure* and the *starter rule set*. Follow-up beads carry
the bulk:
- `dispatch-rules/pbm-vol3-8-4.ts` — the ~600 PBM rules.
- `dispatch-rules/mathai-3.ts` — Mathai 1993 ch. 3 cross-check.
- `dispatch-rules/wolfram-functions-{bessel, whittaker, …}.ts` — the
  1363 Wolfram formulas, sharded by family.

The starter ships ≥30 Bateman rules + the 7 elementary DLMF §16.18
rules — enough to exercise every rule shape (Series-1, Series-2,
elementary, Bessel-family, half-integer, integer-relationships) and
to cover the bulk of Tier A. Coverage of Tier B follows in the PBM
and Wolfram-functions follow-up beads.

## Decision

### 1. The package boundary: `packages/meijer-core/src/dispatch.ts`

The dispatcher lands as a sibling of `slater.ts` and `contour.ts`
inside the existing `@workbench/meijer-core` package. It is *not* a
new package: the symbolic dispatcher is one of the algorithmic layers
of the same Meijer G stack, and the layer-7 top-level dispatcher
(future `hv0.10`) will compose `meijergSymbolic` → `meijergSlater` →
`meijergContour` → `meijergAsymptotic` → refuse. Same package, same
import path, same memory model.

### 2. Rule files live one-per-source

```
packages/meijer-core/src/dispatch-rules/
  bateman-5-6.ts           — Bateman §5.6 pp. 215–222
  dlmf-16-18.ts            — DLMF §16.18 elementary reductions
  pbm-vol3-8-4.ts          — Prudnikov–Brychkov–Marichev §8.4 (deferred)
  mathai-3.ts              — Mathai 1993 ch. 3 (deferred)
  wolfram-functions-*.ts   — Wolfram Functions Site, sharded (deferred)
```

Each file `export`s `RULES: readonly ReductionRule[]`. The dispatcher
in `dispatch.ts` aggregates them via static import:

```ts
import { RULES as BATEMAN } from "./dispatch-rules/bateman-5-6.js";
import { RULES as DLMF_16_18 } from "./dispatch-rules/dlmf-16-18.js";
const ALL_RULES: readonly ReductionRule[] = [...BATEMAN, ...DLMF_16_18];
```

No runtime registration; no plugin loader; no auto-discovery. The TS
expert who opens `dispatch.ts` reads a literal list of every rule
file in scope — and a follow-up bead's diff to add a new file is a
two-line edit visible in code review.

### 3. The `ReductionRule` shape

```ts
interface ReductionRule {
  /** Stable handle for diagnostics: `"bateman-5-6-1"`, `"dlmf-16-18-2"`. */
  readonly id: string;

  /** Human-readable citation: `"Bateman §5.6 (1)"`, `"DLMF 16.18.2"`. */
  readonly source: string;

  /** Free-form context for the reader: which formula family, which
   *  classical function this reduces to. */
  readonly note?: string;

  /** Match shape over `(an, ap, bm, bq)` plus optional integer-relation
   *  predicates. See `PatternSpec` below. */
  readonly match: PatternSpec;

  /** Build the closed-form expression. `bindings` carries the captured
   *  pattern-variable values; `z` is the input argument. Output is a
   *  `Value` AST in the special-function vocabulary. */
  readonly rewrite: (bindings: Bindings, z: Value) => Value;
}
```

The structure is irresistible to a TS expert: the rule is a literal
record they can read top-to-bottom. The citation is right there. The
rewrite is a function from bindings to output — no string templating,
no DSL, just TS.

### 4. The `PatternSpec` shape (v0.1, ad-hoc by design)

```ts
interface PatternSpec {
  readonly mnpq: { m: number; n: number; p: number; q: number };
  readonly an:  readonly SlotSpec[];
  readonly ap:  readonly SlotSpec[];
  readonly bm:  readonly SlotSpec[];
  readonly bq:  readonly SlotSpec[];
  /** Optional cross-slot integer-relation guards (e.g. "a − b ∈ ℤ"). */
  readonly relations?: readonly RelationSpec[];
}

type SlotSpec =
  | { kind: "lit-int";   value: number }                     // 0, 1
  | { kind: "lit-rat";   num: number; den: number }          // 1/2, 3/2
  | { kind: "free";      name: string }                      // any value, captured
  | { kind: "free-shift"; name: string; shift: number };     // value with explicit ±k offset

type RelationSpec =
  | { kind: "integer-difference"; lhs: string; rhs: string };
```

`v0.1` is *deliberately ad-hoc*: every published Bateman / DLMF rule
fits one of these slot kinds, and the closed enumeration is what
makes the rule files readable. A richer pattern grammar (general
linear constraints, nested patterns) is a follow-up bead's territory
once the rule-curation discipline reveals which shapes are actually
needed at scale (per friction discipline: don't generalise until the
second concrete need arrives).

### 5. Pattern-engine reuse vs. extension

The brief says "reuses `cas-simplify`'s pattern-matching engine."
Reading `packages/cas-core/src/simplify.ts`: the engine is a
`Value → Value` ratfn-canonicaliser, *not* a `(pattern, value) →
bindings | null` matcher. The closest reusable surface is the
`valueToRatFn` / `ratFnToValue` round-trip used to canonicalise
**output** expressions; we reuse it for that purpose
(`canonicalise` step below).

**For input matching itself**, the v0.1 `PatternSpec` engine (the
slot-by-slot matcher in `dispatch.ts`) is separate and tiny (~80
LOC). This is honest scope: the structural-`(m,n,p,q)`-then-slot
shape of MeijerG patterns does not benefit from the
`cas-simplify`-engine's polynomial-canonical-form path. Forcing
the dependency would be a categorical mismatch: the simplify engine
canonicalises terms in `Q[x_1..x_n]`; MeijerG patterns match
parameter *tuples*. Future expansion: when (if) a rule needs to
match a complex sub-expression as a Mellin-transform argument, that
match step can call `valueToRatFn` and compare canonicalised
ratfns, but the v0.1 rules don't.

### 6. Canonicalisation post-dispatch

After `rewrite(bindings, z)` produces the candidate, the dispatcher
runs the result through `casSimplify` (from `@workbench/cas-core`).
Out-of-scope subterms (which include all special-function heads
shipped by ADR-0023) wrap as `tagged "cas-simplify/out-of-scope"`
*around the smallest non-Q(x) subtree*; the algebraic Q(x) parts
canonicalise. This handles the common case where a rule emits an
expression like `Γ(1+b−a) · z^b · (1+z)^{a−b−1}` and the `(1+z)` and
the integer-arithmetic `1+b−a` exponent are Q(x)-normalisable. The
output is structurally equivalent to the rewrite's literal output;
the multi-point-sampling verifier (`VERIFIER-PROTOCOL.md` §
"symbolic check") doesn't care about canonical form, only numerical
equivalence at K=20 sample points.

### 7. Parameter-set canonicalisation — input-side

The mathematical contract: order within `an`, `ap`, `bm`, `bq` is
*irrelevant* (the MeijerG integrand is symmetric in each sub-tuple's
Γ-products). The dispatcher canonicalises the input by sorting each
sub-tuple by the value-canonical-bytes of each parameter Value. Two
inputs with permuted `bm` lists — `bm = [0, 1/2]` vs `bm = [1/2, 0]`
— canonicalise to the same shape and hit the same rule.

The rule patterns themselves are written assuming canonical
parameter order. `bateman-5-6.ts` rule `(2)` (`G^{1,1}_{1,1}`) is
written assuming the single `bm` entry is the smaller of the two
slot values, etc.

(The numerical Slater path *also* preserves parameter order
verbatim because residue-line indices reference parameters by
position; canonicalisation here is symbolic-side only and does not
affect the Slater layer.)

### 8. I/O contract — `dispatch.ts` public surface

```ts
type DispatchResult =
  | { kind: "matched";
      expr: Value;
      ruleId: string;
      ruleSource: string;
      note?: string }
  | { kind: "no-known-reduction";
      reason: string };

function meijergSymbolic(
  params: { an: readonly Value[];
            ap: readonly Value[];
            bm: readonly Value[];
            bq: readonly Value[] },
  z: Value,
): DispatchResult;
```

The wire-side wrapper (`tools/meijer-g-symbolic-only`) maps
`matched` to a `record { expr, rule, source }` and `no-known-reduction`
to `tagged "meijer-g-symbolic-only/no-known-reduction" record { reason }`.
Per ADR-0003, no-known-reduction is a **boundary failure** — the
dispatcher operated on a well-formed input but the input lies
outside the rule table's coverage. Callers route to the numerical
path.

### 9. No-direct-porting audit grep, in-source

`packages/meijer-core/test/dispatch-audit.test.ts` greps every file
under `packages/meijer-core/src/dispatch*.ts` and
`packages/meijer-core/src/dispatch-rules/*.ts` for the forbidden
short-form tokens enumerated in `PROMPT.md` § "Audit grep
dimensions": `hypercomb`, `hyper(?!_)`, `_hyp_borel`, `nint_distance`,
`hmag(?!_)`, `eliminate(?!d)`, `inhomogeneous_series`,
`_my_unpolarify`. The test fails CI if any are present.

The `(?!_)` negative lookahead admits the substring inside other
identifiers (`hyperexpand` would be flagged, but no legitimate
reason exists to use it). Each occurrence flagged is a file:line
report, not a count, so leakage is auditable.

### 10. Out of scope for this ADR

- **Integer-relation pattern syntax beyond `lit-int / lit-rat / free /
  free-shift`.** The starter rules don't need it; future rules from
  PBM §8.4 may, and that's a follow-up bead's territory.
- **Recursive MeijerG matches.** Some PBM rules emit `MeijerG[...]`
  on the right-hand side (a reduced G to a smaller `(p, q)`).
  v0.1 emits the bare `MeijerG` head with reduced parameters; the
  recursive evaluation back through `meijergSymbolic` is *out of
  scope* for v0.1 (a stop condition is needed). Top-level
  `tools/meijer-g` integration in `hv0.10` will sequence symbolic →
  recursive-symbolic → numerical.
- **Per-head arbprec evaluator.** The dispatcher emits AST; the
  numerical evaluator at AST nodes (`Gamma(1/3)`, `BesselJ(0, 1)`,
  …) is a separate substrate, deferred to a follow-up bead.

## Why these choices

### TS-native rule shape (Two Principles)

The user's framing memory: "what would a TS expert want?" For a
dispatch table, that's a typed array of records, each citing where
the equation came from. Not a string DSL, not a registry, not a
plugin system — a literal:

```ts
export const RULES: readonly ReductionRule[] = [
  {
    id: "bateman-5-6-1",
    source: "Bateman §5.6 (1)",
    note: "G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}",
    match: {
      mnpq: { m: 1, n: 0, p: 0, q: 1 },
      an: [],
      ap: [],
      bm: [{ kind: "free", name: "b" }],
      bq: [],
    },
    rewrite: ({ b }, z) =>
      mkTimes(mkPower(z, b), expr("exp", [mkNeg(z)])),
  },
  // ...
];
```

A reader following the citation back to Bateman §5.6 (1) sees
`G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}`. The TS code is literally
that. No translation layer.

### One file per source

Two reasons: (a) audit traceability — each file's leading comment
cites the source page and the licence under which it's used; (b)
maintenance — Wolfram's 1363 formulas are best curated in shards
indexed by the function family they reduce *to*, so a future agent
adding "the Bessel-family rules from the Wolfram Functions site"
can land a single file without touching the rest.

### Smart-constructor reuse

Worklog 074 §"Frictions" notes the `mkPlus / mkMinus / mkNeg /
mkTimes / mkDiv / mkPower` smart constructors in
`packages/cas-core/src/diff.ts` are now `export`ed for downstream
reuse. The dispatcher's `rewrite` functions use them directly — same
canonicalisation discipline as cas-diff. No new helpers.

## Acceptance

- `packages/meijer-core/src/dispatch.ts` shipped with the
  orchestrator + slot-by-slot pattern engine + canonicalisation
  pass + audit-grep test.
- `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` — ≥30
  rules from Bateman §5.6 pp. 215–222, each with explicit
  equation-number citation.
- `packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts` — the 7
  elementary-function identities from
  https://dlmf.nist.gov/16.18#i, each with DLMF equation number.
- `packages/meijer-core/test/dispatch.test.ts` — pattern-matcher
  invariants + permutation-invariance + no-match envelope +
  cross-validation against mpmath at 60 dps for ≥5 cases. Mutation-
  prove ≥ 3 invariants per CLAUDE.md Rule 6.
- `packages/meijer-core/test/dispatch-audit.test.ts` — the audit
  grep test.
- `tools/meijer-g-symbolic-only/` — the wire wrapper, with goldens
  + a row in the workbench's main `README.md` catalog.
- `packages/meijer-core/README.md` extended with a "Dispatch layer"
  section.
- This ADR + worklog `077-meijerg-symbolic-dispatch.md`.
- `bun run check` green.
- Follow-up beads filed for the deferred rule files.
