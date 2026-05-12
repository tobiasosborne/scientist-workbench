# meijer-g-symbolic-only

Adamchik–Marichev + Roach symbolic dispatch for the Meijer G-function.
Pattern-matches input parameters against a curated table of reduction
rules from primary literature (Bateman §5.6, DLMF §16.17–§16.18,
future PBM Vol 3 §8.4 and Wolfram Functions Site shards) and emits a
closed-form expression in the cas-core special-function vocabulary
(ADR-0023).

This is the layer-4 fast path of the seven-layer Meijer G stack
(`tstournament/ts-bench-infra/problems/13-meijer-g/PLAN.md`). The
numerical Slater path lives in `tools/meijer-g-slater-only`; the
eventual top-level dispatcher (`tools/meijer-g`, future bead) will
compose symbolic-first → Slater → contour → asymptotic → refuse.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "an": {"kind": "list", "items": [...]},   // upper params, n entries
    "ap": {"kind": "list", "items": [...]},   // upper params, p−n entries
    "bm": {"kind": "list", "items": [...]},   // lower params, m entries (residue line)
    "bq": {"kind": "list", "items": [...]},   // lower params, q−m entries
    "z":  <Value>                              // argument
  }
}
```

Each parameter Value should live in the protocol's
`integer / rational / symbol / expression` subset. Floats and
arbitrary tagged values are accepted at the schema level but the
dispatcher's pattern matcher returns the no-known-reduction envelope
if it cannot reason about them.

## Output

Successful dispatch:

```jsonc
{
  "kind": "record",
  "fields": {
    "expr": <Value>,           // closed-form AST in the special-function vocab
    "rule": "bateman-5-6-1",   // stable rule id
    "source": "Bateman §5.6 (1)",
    "note": "G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}"
  }
}
```

No matching rule:

```jsonc
{
  "kind": "tagged",
  "tag": "meijer-g-symbolic-only/no-known-reduction",
  "payload": {
    "kind": "record",
    "fields": {"reason": <string>}
  }
}
```

Per ADR-0003, no-known-reduction is a *boundary failure* — the
dispatcher operated on a well-formed input but the input lies outside
the rule table's coverage. Callers route to the numerical path
(`tools/meijer-g-slater-only` or the eventual integrated dispatcher).

## How

The orchestrator in `@workbench/meijer-core/src/dispatch.ts`:

1. **Canonicalises input.** Sorts each sub-tuple (`an`, `ap`, `bm`,
   `bq`) by canonical-bytes order so permutations within a sub-tuple
   match the same rule (the Mellin–Barnes integrand's Γ-products are
   symmetric within each).

2. **Walks the rule list.** First-match-wins over `ALL_RULES`. Within
   each rule file (`dispatch-rules/<source>.ts`) rules are ordered
   most-specific-first.

3. **Emits the candidate.** The matched rule's `rewrite(bindings, z)`
   builds a `Value` AST in the closed special-function vocabulary
   shipped by ADR-0023.

4. **Canonicalises output.** Pipes through `casSimplify`. Q(x) parts
   collapse; special-function subterms wrap in
   `tagged "cas-simplify/out-of-scope"`. The verifier
   (problem-13 `VERIFIER-PROTOCOL.md`) admits any numerically
   equivalent form, so canonicalisation is for human readability.

See `docs/adr/0025-meijerg-symbolic-dispatch.md` for the full design.

## Invariants

- **deterministic**: same input bytes → same output bytes.
- **permutation invariance within sub-tuples**: same matched ruleId
  and byte-equal `expr` after canonical-sort.
- **no-known-reduction on unrecognised shapes**: structured tagged
  envelope, never a silent wrong answer.
- **every emitted rule cites primary literature**: the audit grep
  test (`packages/meijer-core/test/dispatch-audit.test.ts`) enforces
  no transliteration from open-source implementation source code.

## Run

```sh
echo '{"kind":"record","fields":{
  "an":{"kind":"list","items":[]},
  "ap":{"kind":"list","items":[]},
  "bm":{"kind":"list","items":[{"kind":"integer","value":"0"}]},
  "bq":{"kind":"list","items":[]},
  "z":{"kind":"symbol","name":"z"}
}}' | bun tools/meijer-g-symbolic-only/tool.ts
```

## Validation

`dispatch-mpmath.test.ts` re-validates the symbolic-dispatch output per
build: for every matched rule that maps to a special-function form, the
emitted expression is numerically evaluated at 30 dps via mpmath and
compared against the direct `MeijerG` computation. Any rule that
produces a wrong value (sign error, factor of 2, wrong exponent) is
caught immediately at the unit-test level, not just in the bench. This
keeps the rule table honest under refactoring.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`

## Coverage

v0.1 ships ≥30 reduction rules across two files:

| File | Source | Rule count (v0.1) |
|---|---|---|
| `dispatch-rules/bateman-5-6.ts` | Bateman §5.6 pp. 215–222 | 27 |
| `dispatch-rules/dlmf-16-18.ts` | DLMF §16.17–§16.18 | 6 |

The full Bateman §5.6 has ~50 entries; PBM Vol 3 §8.4 has ~600;
Wolfram Functions Site has 1363 across 14 categories. The remainder
land in follow-up beads:

- `dispatch-rules/pbm-vol3-8-4.ts` — Prudnikov–Brychkov–Marichev §8.4
- `dispatch-rules/mathai-3.ts` — Mathai 1993 ch. 3
- `dispatch-rules/wolfram-functions-bessel.ts` (etc) — Wolfram shards
