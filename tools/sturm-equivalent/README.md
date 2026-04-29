# sturm-equivalent

Decide whether two Sturm channels denote the same arrow in CPTP.
Composes `sturm-simplify` (canonical form) with `sturm-execute`
(distribution comparison) under the record-with-flag pattern from
ADR-0003 — same shape as `cas-verify`.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "lhs": <Sturm channel IR>,
    "rhs": <Sturm channel IR>
  }
}
```

Both channels must conform to `channelSchema` (ADR-0006).

## Output

`record { equal: boolean, reason?, witness?, detail? }`:

- **`equal: true`** — the two channels' IRs are byte-identical after
  `sturm-simplify` runs on each side. Sound: byte-equality of canonical
  IRs implies the same arrow.
- **`equal: false, reason: "not-equivalent", witness: <record>`** — the
  two `sturm-execute` distributions differ on at least one outcome. The
  witness shape:
  ```jsonc
  {
    "classical_resolutions": [{"ref":"r0","value":0}, ...],
    "lhs_prob": <float64>,
    "rhs_prob": <float64>
  }
  ```
  Sound: differing measurement distributions imply differing unitaries.
- **`equal: false, reason: "out-of-scope", detail: <string>`** — the
  equivalence cannot be decided. Three sub-cases:
    - `lhs out-of-scope: <reason>` / `rhs out-of-scope: <reason>` — one
      side hit a `sturm-execute` boundary (oracle, discard, free
      symbol, qubit cap).
    - `distribution-match-but-not-syntactic` — distributions match but
      the simplified IRs differ. Distribution equality is *necessary*
      but not *sufficient* for unitary equivalence. Resolved by the
      future matrix-equivalence path (issue scientist-workbench-jfj).

## How

1. Canonicalise both sides via `sturm-simplify` (subprocess).
2. Compare byte-equality of the simplified IRs.
3. On byte-mismatch: run `sturm-execute` (subprocess) on both. Compare
   distributions outcome-by-outcome, resolution-key-by-resolution-key.
4. Honest answers throughout:
   - byte-equal post-simplify ⇒ equal=true.
   - distribution-mismatch ⇒ equal=false with witness.
   - distribution-match (not byte-equal) ⇒ out-of-scope.
   - either side out-of-scope-for-execute ⇒ out-of-scope.
   - different classical_refs ⇒ out-of-scope.

The 1e-9 probability tolerance accommodates IEEE-754 cumulative
rounding across two independent simulator runs (`sturm-execute`'s own
floor is 1e-12; the cross-comparison floor here is two orders of
magnitude wider).

### Why subprocess composition

`sturm-equivalent` spawns `sturm-simplify` and `sturm-execute` as
subprocesses rather than importing their logic. Tool-on-tool
composition is unusual in the workbench — most tools depend on
`packages/`. The chosen tradeoff:

- **Pro:** the rewrite + simulation logic stays in lockstep with its
  source tools by construction. If `sturm-simplify` learns a new
  rewrite, `sturm-equivalent`'s syntactic check picks it up
  automatically.
- **Con:** ~200 ms latency per invocation (4 subprocess spawns in the
  worst case: simplify×2 + execute×2). Acceptable for v0.1; the
  shared-library refactor is filed for follow-up.

## What this tool does *not* do

- **Matrix equivalence over Q[√2, i]** — the natural strongest check
  for Clifford+T circuits is deferred along with the rest of the
  exact-symbolic path (issue scientist-workbench-jfj). When jfj lands,
  the "out-of-scope: distribution-match-but-not-syntactic" branch can
  be upgraded to a sound matrix verdict.
- **Distinguish global phase** — distribution comparison is insensitive
  to global phase (Born's rule quotients it out). Circuits differing
  only by global phase land in the out-of-scope branch.
- **Decide equivalence under arbitrary initial states** — only the
  `|0…0⟩` initial state is simulated. Two unitaries that agree on
  `|0…0⟩` but differ on `|+…+⟩` end up in the out-of-scope branch.

## Invariants

- **soundness-on-equal-true**: `equal=true` is byte-equality of the
  simplified IRs; this is a sufficient condition for equivalence.
- **soundness-on-not-equivalent**: `equal=false reason='not-equivalent'`
  means two probabilities provably differ, which is sufficient for
  inequivalence.
- **honest-scope**: undecidable cases return `equal=false reason='out-of-scope'`,
  never an unwarranted `equal=true`.
- **symmetry**: `equivalent(a, b).equal === equivalent(b, a).equal`.
- **deterministic**: same input → same output bytes.

## Run

```sh
# Bell pair vs Bell-pair-with-redundant-ry(0): equal post-simplify
cat <<'EOF' | bun tools/sturm-equivalent/tool.ts
{"kind":"record","fields":{
  "lhs": <bell-pair IR>,
  "rhs": <bell-pair-with-extra-ry(0) IR>
}}
EOF
# → {"kind":"record","fields":{"equal":{"kind":"boolean","value":true}}}
```

See `goldens.spec.ts` for fully-worked input shapes covering every
output category.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
