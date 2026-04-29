# sturm-sample

Apply Born's rule: given an analytic distribution from `sturm-execute` plus
a stream of entropy bytes, draw `shots` samples. Strictly deterministic
given the typed entropy field — same `(distribution, entropy, shots)`
tuple yields bit-equal output bytes.

This is the consumer side of the distribution-vs-sampling factoring laid
out in [`docs/adr/0007-distribution-vs-sampling.md`](../../docs/adr/0007-distribution-vs-sampling.md).
The pipeline is:

```
sturm-execute    →  distribution     (deterministic)
entropy-source   →  bytes            (the only nondeterministic step)
sturm-sample     →  samples          (deterministic given entropy)
```

Re-execution against the same captured entropy is bit-identical;
provenance and reproducibility hold up to the one identifiable
nondeterministic step.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "distribution": <sturm-execute's in-scope output record>,
    "entropy":      {"kind":"string","value":"<lowercase hex>"},
    "shots":        {"kind":"integer","value":"1024"}
  }
}
```

`distribution` mirrors `sturm-execute`'s in-scope output verbatim — a
record with `classical_refs`, `outcomes`, and `precision`. Out-of-scope
outputs from `sturm-execute` (the `tagged "sturm-execute/out-of-scope"`
form) are not admitted; the runner's schema check rejects them as
malformed input. Address the upstream out-of-scope first.

`entropy` must be lowercase even-length hex (no `0x` prefix). The
canonical source is `entropy-source` (ADR-0005); manual hex strings work
for tests and goldens.

`shots` must be `≥ 0`. `shots = 0` is a legitimate trivial case
(empty samples, no entropy consumed).

## Output

```jsonc
{
  "kind": "record",
  "fields": {
    "entropy_consumed": {"kind":"integer","value":"<8 * shots>"},
    "samples": {
      "kind": "list",
      "items": [
        {
          "kind": "record",
          "fields": {
            "classical_resolutions": {
              "kind": "list",
              "items": [{"kind":"record","fields":{"ref":...,"value":...}}, ...]
            }
          }
        }
        // ... `shots` total
      ]
    }
  }
}
```

Each sample's `classical_resolutions` shape mirrors a single distribution
outcome's `classical_resolutions` field — the row-view of the
distribution table. A downstream consumer that wants to count frequencies
per classical-ref can use the same record-walk it would use on the
distribution itself.

`entropy_consumed = 8 * shots`. The 8-bytes-per-shot budget is the
ADR-0007 convention; the explicit reporting makes byte-budget bookkeeping
ergonomic for callers chaining multiple sample stages.

## How

1. Validate the entropy hex (even length, `[0-9a-f]`); decode to bytes.
2. Compute the CDF in float64 over the distribution's outcomes.
3. For each shot:
   - take 8 bytes; decode big-endian to a `uint64`;
   - convert to a uniform draw `u ∈ [0, 1]` via `Number(u64) / 2^64`;
   - linear-scan the CDF for the first `i` where `CDF[i] ≥ u`.
4. Emit `samples` (length `shots`) and `entropy_consumed = 8 * shots`.

The probability values can be `rational` or `float64` — v0.1 of
`sturm-execute` always emits float64, but the rational branch is wired
forward-compatibly so the deferred exact-symbolic path
(scientist-workbench-jfj) drops in here without further edits.

## Invariants

- **deterministic-given-entropy** — same `(distribution, entropy, shots)`
  ⟹ bit-equal output bytes.
- **byte-budget** — `entropy_consumed == 8 * shots`.
- **samples-length** — `samples.length == shots`.
- **sample-shape-matches-distribution** — every emitted sample's
  `classical_resolutions` is one of the distribution's outcomes' rows
  (no fabricated outcomes).
- **statistical-convergence** — large-shot frequencies converge to the
  input distribution's probabilities, tested with a fixed entropy seed
  (so the test itself is deterministic).
- **rejects-out-of-bytes / rejects-malformed-entropy / rejects-negative-shots**
  — every malformed input raises `ToolError` with a remediation
  `suggestion`.

## Run

End-to-end pipeline (Bell pair, 100 shots):

```sh
# 1. The channel IR.
echo "$BELL_PAIR_IR" \
  | bun tools/sturm-simplify/tool.ts \
  | bun tools/sturm-execute/tool.ts \
  > /tmp/dist.json

# 2. The entropy (the only nondeterministic step).
echo '{"kind":"record","fields":{"n_bytes":{"kind":"integer","value":"800"}}}' \
  | bun tools/entropy-source/tool.ts \
  > /tmp/entropy.json

# 3. Combine and sample. (A small jq invocation builds the combined record;
#    or a small wrapping shell function — left to the caller.)
```

Standalone (manual entropy):

```sh
echo '{"fields":{"distribution":<dist>,"entropy":{"kind":"string","value":"00…"},"shots":{"kind":"integer","value":"1"}},"kind":"record"}' \
  | bun tools/sturm-sample/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
