# sturm-execute

Pure-analytic quantum executor for Sturm channels. Takes a Sturm IR
(ADR-0006) and returns a distribution over the channel's classical-ref
resolutions. **No randomness** — that's `sturm-sample`'s job (Phase 2).
ADR-0007 frames the split as Born's rule made structural: this tool
computes the post-circuit distribution exactly; sampling is a separate,
entropy-consuming step.

## Input

A Sturm channel — `expression "channel"` with input-signature, output-
signature, and body. See `packages/sturm-ir/README.md` for the full
shape; concretely:

```jsonc
{
  "kind": "expression", "head": "channel",
  "args": [
    /* inputs:  */ { "kind": "list", "items": [/* wire records */] },
    /* outputs: */ { "kind": "list", "items": [] },
    /* body:    */ { "kind": "list", "items": [/* op exprs */] }
  ]
}
```

Quantum input wires are seeded as `|0⟩`. Channels that need a different
initial state should emit explicit `prepare` ops.

## Output

On success: `record { classical_refs, outcomes, precision }`.

```jsonc
{
  "classical_refs": ["r0", "r1"],          // declaration order
  "outcomes": [
    {
      "classical_resolutions": [
        { "ref": "r0", "value": 0 },
        { "ref": "r1", "value": 0 }
      ],
      "prob": <float64>
    },
    /* ... more outcomes, sorted by resolution tuple ascending ... */
  ],
  "precision": "float64"
}
```

`prob` is `float64` in v0.1; the schema also admits `rational` for the
deferred exact-symbolic path (issue scientist-workbench-jfj).

`classical_resolutions` is encoded as a list of `{ref, value}` pairs.
ADR-0007 sketched a record-keyed-by-ref shape (`extras: "allow"`); the
v0.1 schema language doesn't admit open records (ADR-0004), so we use
the list-of-pairs form and document the deviation here.

On out-of-scope inputs: `tagged "sturm-execute/out-of-scope" <string-reason>`
(ADR-0003 boundary-failure pattern). Reasons emitted:

- `"oracle op not supported in v0.1"`
- `"discard op not supported in v0.1"`
- `"qubit count exceeds cap of 12"`
- `"non-numeric angle in <op>(wire <id>)"`
- `"non-numeric probability in prepare(wire <id>)"`
- `"prepare probability out of [0,1]: <p> on wire <id>"`

## How

State-vector simulation in float64. For each op in the body:

- **prepare(p, w)**: tensor in a fresh qubit `√(1−p)|0⟩ + √p|1⟩`.
- **ry(w, θ, ctrls)** / **rz(w, θ, ctrls)**: apply the 2×2 RY/RZ matrix
  to qubit w, gated on every control bit being 1.
- **observe(w, ref)**: split the branch into two — one for each
  measurement outcome — by projecting the qubit onto `|0⟩` / `|1⟩`. We
  do NOT renormalise; a branch's probability is the sum of `|amp|²` over
  its remaining basis states. (Renormalising would introduce irrational
  square roots that the float path swallows numerically but the future
  exact path cannot represent cleanly.)
- **cases(ref, true_arm, false_arm)**: partition branches by the
  resolved classical-ref value, run each arm on its partition, merge.

After the body finishes, branches are aggregated by their classical-
resolution dict (sum of probabilities) and emitted sorted by
resolution-tuple ascending.

**Numerical-precision floor**: outcomes with probability below `1e-12`
are dropped as IEEE-754 noise. Without this, identities like
`cos(π/2) ≈ 6e-17` produce phantom outcomes with prob ~1e-32 cluttering
the distribution. The threshold is well above the IEEE noise floor and
well below any physically-meaningful probability.

**Out of scope for v0.1**:

- `oracle` ops — would need the embedded circuit's permutation lifted
  into the simulator. Use `sturm-equivalent` on circuits with oracles
  is also blocked on this. Filed as scientist-workbench-tkx (this
  issue) follow-up.
- `discard` ops — partial trace on an entangled state produces a mixed
  state; pure-state simulation can't represent this without going to
  density-matrix simulation. Honest scope.
- Exact-symbolic distributions over Q[√2, i] — filed as
  scientist-workbench-jfj. Briefly: amplitudes for the
  `{prepare(0|1|1/2), ry(kπ/2), rz(kπ/2)}` fragment stay in Q[√2, i],
  but the *individual* basis-state probabilities `|amp|²` generally
  land in Q[√2] (with √2-components that don't cancel until you sum
  over all basis states). The schema's `prob: rational | float64`
  cannot represent these without further design.
- 13+ qubit circuits — capped at 12 (4096 amplitudes). Past the cap is
  out-of-scope; future tensor-network or density-matrix simulators
  would be separate tools.

## Invariants

- **deterministic**: same input bytes → bit-identical output bytes
  (IEEE-754 determinism).
- **probabilities-sum-to-one**: emitted outcomes sum to 1 within
  float64 tolerance (≤ 1e-9).
- **honest-scope**: out-of-scope inputs emit a `tagged` boundary
  failure, never a wrong-shaped distribution.
- **no-randomness**: strictly deterministic per ADR-0005; the analytic
  distribution is a function of the input alone.
- **born-rule-matches-textbook-cases**: Bell, GHZ, NOT, H, parametrised
  RY all match the textbook closed-form expressions.
- **numerical-precision-floor**: outcomes below 1e-12 are dropped as
  IEEE-754 noise.

## Run

```sh
# Bell pair
cat <<'EOF' | bun tools/sturm-execute/tool.ts
{"kind":"expression","head":"channel","args":[
  {"kind":"list","items":[]},
  {"kind":"list","items":[]},
  {"kind":"list","items":[
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"0"}]},
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"1"}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"0"},{"kind":"expression","head":"/","args":[{"kind":"symbol","name":"π"},{"kind":"integer","value":"2"}]},{"kind":"list","items":[]}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"1"},{"kind":"symbol","name":"π"},{"kind":"list","items":[{"kind":"integer","value":"0"}]}]},
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"0"},{"kind":"string","value":"r0"}]},
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"1"},{"kind":"string","value":"r1"}]}
  ]}
]}
EOF
```

The output's two `outcomes` are `(r0=0, r1=0)` and `(r0=1, r1=1)`, each
with probability ≈ 0.5 — the Bell-pair correlation. The two anti-
correlated outcomes are filtered as below-threshold IEEE noise.

## Pipeline

```sh
# Build IR; canonicalise; execute; (later) sample.
bun tools/sturm-simplify/tool.ts < channel.json \
  | bun tools/sturm-execute/tool.ts
```

`sturm-execute` is the deterministic half of the analytic pipeline. The
sampling half (`sturm-sample`, Phase 2) takes this output plus an
entropy stream and produces shot-by-shot bit strings.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
