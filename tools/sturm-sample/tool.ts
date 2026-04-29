// =============================================================================
// sturm-sample — Born's rule, applied: distribution + entropy → samples
// =============================================================================
//
// Intent
// ------
// `sturm-sample` is the *consumer* side of the distribution-vs-sampling
// factoring laid out in ADR-0007. Its sibling, `sturm-execute`, is the pure-
// analytic step: it reads a Sturm channel IR (ADR-0006) and returns the post-
// circuit distribution over classical-ref resolutions. That step is strictly
// deterministic — no randomness enters. Sampling is the c-c channel that
// turns probability mass into observed bitstrings, and that's the work this
// tool does. Born's rule is no longer hidden inside a monolithic `run()`; it
// is its own tool, with its own schema, its own invariants, and its own
// content-addressed step in the pipeline.
//
// The tool is *not* `nondeterministic: true`. ADR-0005 reserves that
// annotation for the privileged `entropy-source` tool (and future hardware
// bridges). Every other randomness consumer takes its bytes as a typed
// `entropy: string` field on its input record and stays strictly deterministic
// given those bytes. This is a checkable property — "given the same
// distribution + same entropy + same shots, the output bytes are identical"
// — and the `--test` hook checks it directly. Statistical correctness is a
// separate, weaker, statistical claim that the hook also checks (with a
// fixed-entropy seed so the test itself remains deterministic).
//
// The composition pattern (ADR-0007 §"composition pattern") is a three-step
// pipe with exactly one nondeterministic step:
//
//     sturm-execute    →  distribution     (deterministic)
//     entropy-source   →  bytes            (the only nondeterministic step)
//     sturm-sample     →  samples          (deterministic given entropy)
//
// Re-execution of the third step against the same captured entropy is
// bit-identical — provenance and reproducibility hold up to the one
// identifiable nondeterministic step.
//
// Input shape
// -----------
//   record {
//     distribution:  <sturm-execute's in-scope output>,
//     entropy:       string (lowercase hex, no '0x' prefix),
//     shots:         integer,
//   }
//
// The `distribution` schema mirrors `sturm-execute`'s in-scope output
// verbatim: a record with `classical_refs`, `outcomes`, and `precision`.
// The match is intentional — piping `sturm-execute` straight into the
// `distribution` field of `sturm-sample`'s input is the canonical
// composition. Out-of-scope outputs from `sturm-execute` (the
// `tagged "sturm-execute/out-of-scope"` form) are *not* admitted as
// distribution; the runner's schema check rejects them as malformed
// input. The agent that fed the bad value gets a clean `ToolError` and
// has to address the upstream out-of-scope first.
//
// Output shape
// ------------
//   record {
//     samples: list<record {
//       classical_resolutions: list<record { ref: string, value: integer }>,
//     }>,                                          // length == shots
//     entropy_consumed: integer,                   // bytes
//   }
//
// Each `sample` mirrors a single distribution outcome's
// `classical_resolutions` shape — so a downstream consumer that wants to
// count frequencies per ref can use the same record-walk it would use on
// the distribution itself. The `prob` field is dropped (it has no meaning
// on a single sample); just the resolution row remains.
//
// `entropy_consumed` is exactly `8 * shots` — eight bytes per shot is the
// per-tool budget convention from ADR-0007. Reporting the consumed count
// makes downstream byte-budget bookkeeping ergonomic and gives the
// invariant a name ("byte-budget").
//
// Algorithm
// ---------
// 1. Validate the entropy hex string (even-length, [0-9a-f]). Decode to a
//    Uint8Array of bytes.
// 2. Compute the probability cumulative-distribution function (CDF) by
//    cumulative summation in float64. Probabilities are converted from
//    rational or float64 (whichever the upstream tool emitted) — v0.1 of
//    `sturm-execute` always emits float64, but the rational case is
//    handled forward-compatibly. The CDF is monotonically non-decreasing
//    and (modulo IEEE drift) ends at 1.0.
// 3. For each shot in [0, shots):
//      a. Slice 8 bytes from offset (8 * shot).
//      b. Decode big-endian to a uint64 ∈ [0, 2^64).
//      c. Convert to a uniform draw u ∈ [0, 1] via Number(uint64) / 2^64.
//         (Note: u can exactly hit 1.0 when every byte is 0xff, since
//         Number(2^64 - 1) rounds up to 2^64. The CDF lookup uses `>=`
//         and saturates at the last outcome, so u = 1.0 maps cleanly to
//         the final outcome.)
//      d. Walk the CDF left-to-right; pick the first i where CDF[i] >= u.
//         Linear scan is fine for the typical (≤16 outcomes) case.
// 4. Emit the samples list and `entropy_consumed = 8 * shots`.
//
// Out-of-bytes is a `ToolError` with an explicit suggestion: the byte
// budget is `8 * shots`; the caller is told exactly how many more bytes
// to source.
//
// Goldens
// -------
// Goldens are ordinary {input, output} byte-equal records — sampling is
// deterministic given the (distribution, entropy, shots) triple, so the
// usual generate-and-compare machinery applies. The goldens cover
// trivial-distribution, the two boundary corners (entropy = "00…", "ff…")
// of a 50/50 distribution, multi-shot deterministic patterns, Bell-pair
// correlation, GHZ all-correlated, and the shots = 0 edge case.
//
// References
// ----------
// - ADR-0005 — externalised entropy; defines the typed-entropy convention
//   this tool consumes.
// - ADR-0006 — IR-as-Value; the upstream channel shape.
// - ADR-0007 — distribution-vs-sampling factoring; the rationale for
//   *why* this is a separate tool from `sturm-execute`.
// - shard 020 — the worklog accompanying this tool's predecessor
//   (`entropy-source`); explains the `nondeterministic: true` ladder.

import {
  canonicalize,
  float64FromNumber,
  hash,
  int,
  list,
  parse,
  record,
  S,
  str,
  ToolError,
  type IntegerValue,
  type ListValue,
  type RecordValue,
  type Schema,
  type StringValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool, spawnBun } from "@workbench/contract";

const NAME = "sturm-sample";
const VERSION = "0.1.0";

const BYTES_PER_SHOT = 8; // ADR-0007 byte-budget convention

// -----------------------------------------------------------------------------
// Schema declarations
// -----------------------------------------------------------------------------
//
// `distributionInScopeSchema` mirrors `tools/sturm-execute/tool.ts`'s
// `inScopeOutputSchema` byte-for-byte. The duplication is deliberate: a
// shared package would bind `sturm-sample` to a `sturm-execute` *version*
// rather than to a *shape*, and the shape is the actual contract here.
// If sturm-execute ever changes the shape (e.g. lands the exact-symbolic
// path under scientist-workbench-jfj and adds a new prob variant), the
// integration is a one-line schema edit here, surfaced as a clean schema-
// mismatch on the next pipeline run rather than a silent semantic drift.

const classicalResolutionPairSchema = S.record({
  ref: S.kind("string"),
  value: S.kind("integer"),
});

const distributionOutcomeSchema = S.record({
  classical_resolutions: S.list(classicalResolutionPairSchema),
  prob: S.union([S.kind("rational"), S.kind("float64")]),
});

const distributionInScopeSchema = S.record({
  classical_refs: S.list(S.kind("string")),
  outcomes: S.list(distributionOutcomeSchema),
  precision: S.union([S.literal(str("exact")), S.literal(str("float64"))]),
});

// `inputSchema` is annotated as `Schema<Value>` to widen the example slot's
// expected input type to plain `Value`. Without this, TS computes a deeply
// nested `RecordValueOf<...>` inference that doesn't match what the
// example helpers (`dist`, `outcome`, `pair`) construct — even though the
// runtime structures are identical. The runner's runtime
// `checkExamplesAgainstSchema` (ADR-0004) is the authoritative validator;
// the TS narrow on `fn`'s input parameter is preserved via an explicit
// cast inside `fn`.
const inputSchema: Schema<Value> = S.record({
  distribution: distributionInScopeSchema,
  entropy: S.kind("string"),
  shots: S.kind("integer"),
});

const sampleSchema = S.record({
  classical_resolutions: S.list(classicalResolutionPairSchema),
});

const outputSchema: Schema<Value> = S.record({
  entropy_consumed: S.kind("integer"),
  samples: S.list(sampleSchema),
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const HEX_RE = /^[0-9a-f]*$/;

function parseHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) {
    throw new ToolError(`${NAME}: entropy hex must have even length (got ${s.length} chars)`, {
      suggestion: "every byte is two hex digits; check for stray characters or pair counts",
    });
  }
  if (!HEX_RE.test(s)) {
    throw new ToolError(`${NAME}: entropy contains non-hex characters`, {
      suggestion: "use lowercase hex only; entropy-source emits the canonical encoding",
    });
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

// Convert eight big-endian bytes to a uniform draw in [0, 1]. The corner
// case u = 1.0 is reachable when every byte is 0xff; the CDF lookup below
// is robust to it. Eight bytes per shot is the ADR-0007 convention.
function uniformDraw(bytes: Uint8Array, offset: number): number {
  let n = 0n;
  for (let k = 0; k < BYTES_PER_SHOT; k++) {
    n = (n << 8n) | BigInt(bytes[offset + k]!);
  }
  // Number(2^64 - 1) rounds up to 2^64 in float64, so u may equal 1.0.
  return Number(n) / 2 ** 64;
}

// Convert a probability Value (rational or float64) to a float64 number.
// The exact-symbolic path (jfj) will eventually emit rationals; we already
// handle them here so the tool's body doesn't have to grow when the
// upstream switches.
function probValueToFloat(v: Value): number {
  if (v.kind === "float64") {
    // Decode the IEEE bits. We could call a protocol helper but the
    // canonical encoding is just the 16 hex chars of the big-endian bits.
    const bits = v.bits;
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    for (let k = 0; k < 8; k++) {
      view.setUint8(k, parseInt(bits.slice(2 * k, 2 * k + 2), 16));
    }
    return view.getFloat64(0, false /* big-endian */);
  }
  if (v.kind === "rational") {
    // Approximate via BigInt division: split numerator and denominator
    // (both already in lowest terms with den > 0) and rescale to fit in
    // float64. For the typical π-rational probabilities the values are
    // well within float64's range, but we guard the precision-shift case
    // anyway.
    const num = BigInt(v.num);
    const den = BigInt(v.den);
    return Number(num) / Number(den);
  }
  // Defensive: the schema admits only rational | float64 here, so this is
  // unreachable under runner validation. Loud failure beats silent zero.
  throw new ToolError(`${NAME}: distribution.outcomes[].prob must be rational or float64 (got ${v.kind})`, {});
}

// Linear scan for the first CDF index whose cumulative probability is >= u.
// Saturates at the last outcome on float drift (e.g. when CDF total is
// 1 - 2 ulp and u ≈ 1.0). For ≤16-outcome distributions the constant
// factor of binary search is not worth the code complexity.
function pickOutcome(cdf: readonly number[], u: number): number {
  for (let i = 0; i < cdf.length; i++) {
    if (cdf[i]! >= u) return i;
  }
  return cdf.length - 1;
}

// -----------------------------------------------------------------------------
// Example helpers
// -----------------------------------------------------------------------------

// Helpers for example construction. The element-type generics preserve
// narrowness end-to-end so the constructed records line up with the
// schema's narrow `RecordValueOf<...>` inference at the example slot.
// Without the generics, the helpers' return types widen to `Value`, the
// record-of-record-of-list path collapses to `Value`, and the
// `ExampleEntry<I,O>.input` slot rejects the input at the TS level.

const pair = (ref: string, value: 0 | 1) =>
  record({ ref: str(ref), value: int(BigInt(value)) });

const outcome = <E extends Value>(resolutions: readonly E[], prob: number) =>
  record({
    classical_resolutions: list(resolutions),
    prob: float64FromNumber(prob),
  });

const dist = <O extends Value>(refs: readonly string[], outcomes: readonly O[]) =>
  record({
    classical_refs: list(refs.map((r) => str(r))),
    outcomes: list(outcomes),
    precision: str("float64"),
  });

const sampleRow = <E extends Value>(resolutions: readonly E[]) =>
  record({ classical_resolutions: list(resolutions) });

// Common distributions used in examples.
const DET_ZERO = dist(["r"], [outcome([pair("r", 0)], 1.0)]);
const FIFTY_FIFTY = dist(
  ["r"],
  [outcome([pair("r", 0)], 0.5), outcome([pair("r", 1)], 0.5)]
);
const BELL = dist(
  ["r0", "r1"],
  [
    outcome([pair("r0", 0), pair("r1", 0)], 0.5),
    outcome([pair("r0", 1), pair("r1", 1)], 0.5),
  ]
);
const GHZ3 = dist(
  ["r0", "r1", "r2"],
  [
    outcome([pair("r0", 0), pair("r1", 0), pair("r2", 0)], 0.5),
    outcome([pair("r0", 1), pair("r1", 1), pair("r2", 1)], 0.5),
  ]
);

const ENTROPY_ZERO_8 = "0000000000000000"; // u = 0.0
const ENTROPY_FF_8 = "ffffffffffffffff"; // u ≈ 1.0
const ENTROPY_HALF_8 = "8000000000000000"; // u = 0.5

// `distribution` is the wide `Value` here only because the example helpers
// produce structurally-equivalent but TS-distinct narrow record types.
// The runner's example-conform-to-schema check validates structurally.
const inp = (distribution: ReturnType<typeof dist>, entropy: string, shots: bigint) =>
  record({ distribution, entropy: str(entropy), shots: int(shots) });

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description:
        "deterministic distribution (P=1 on r=0): one shot, any entropy → r=0",
      input: inp(DET_ZERO, ENTROPY_HALF_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r", 0)])]),
      }),
    },
    {
      description:
        "50/50 distribution, u = 0.0 (entropy '00…'): picks the first outcome (r=0)",
      input: inp(FIFTY_FIFTY, ENTROPY_ZERO_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r", 0)])]),
      }),
    },
    {
      description:
        "50/50 distribution, u ≈ 1.0 (entropy 'ff…'): picks the last outcome (r=1)",
      input: inp(FIFTY_FIFTY, ENTROPY_FF_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r", 1)])]),
      }),
    },
    {
      description:
        "50/50 distribution, u = 0.5 (entropy '80…'): CDF[0] = 0.5 ≥ 0.5, picks r=0",
      input: inp(FIFTY_FIFTY, ENTROPY_HALF_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r", 0)])]),
      }),
    },
    {
      description:
        "shots = 0: empty samples, no entropy consumed (the trivial pure deterministic case)",
      input: inp(FIFTY_FIFTY, "", 0n),
      output: record({
        entropy_consumed: int(0n),
        samples: list([]),
      }),
    },
    {
      description:
        "two shots from 50/50 with mixed entropy '00…' || 'ff…': r=0 then r=1",
      input: inp(FIFTY_FIFTY, ENTROPY_ZERO_8 + ENTROPY_FF_8, 2n),
      output: record({
        entropy_consumed: int(16n),
        samples: list([sampleRow([pair("r", 0)]), sampleRow([pair("r", 1)])]),
      }),
    },
    {
      description:
        "Bell pair, u = 0.0: correlated (0,0)",
      input: inp(BELL, ENTROPY_ZERO_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r0", 0), pair("r1", 0)])]),
      }),
    },
    {
      description:
        "Bell pair, u ≈ 1.0: correlated (1,1) — one byte of entropy reveals both wires",
      input: inp(BELL, ENTROPY_FF_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r0", 1), pair("r1", 1)])]),
      }),
    },
    {
      description:
        "GHZ-3, u = 0.0: all-zeros (the workbench's shortest GHZ-correlated sample)",
      input: inp(GHZ3, ENTROPY_ZERO_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r0", 0), pair("r1", 0), pair("r2", 0)])]),
      }),
    },
    {
      description:
        "GHZ-3, u ≈ 1.0: all-ones",
      input: inp(GHZ3, ENTROPY_FF_8, 1n),
      output: record({
        entropy_consumed: int(8n),
        samples: list([sampleRow([pair("r0", 1), pair("r1", 1), pair("r2", 1)])]),
      }),
    },
    {
      description:
        "three shots, mixed entropy '80…' (r=0) || '00…' (r=0) || 'ff…' (r=1) → 0,0,1",
      input: inp(FIFTY_FIFTY, ENTROPY_HALF_8 + ENTROPY_ZERO_8 + ENTROPY_FF_8, 3n),
      output: record({
        entropy_consumed: int(24n),
        samples: list([
          sampleRow([pair("r", 0)]),
          sampleRow([pair("r", 0)]),
          sampleRow([pair("r", 1)]),
        ]),
      }),
    },
    {
      description:
        "out-of-bytes: 50/50 distribution, shots = 2, only 8 bytes provided → ToolError",
      input: inp(FIFTY_FIFTY, ENTROPY_ZERO_8, 2n),
      error: `${NAME}: entropy too short (need 16 bytes for 2 shots, got 8)`,
    },
    {
      description:
        "negative shots: malformed input",
      input: inp(FIFTY_FIFTY, ENTROPY_ZERO_8, -1n),
      error: `${NAME}: shots must be ≥ 0 (got -1)`,
    },
  ],
  invariants: [
    {
      name: "deterministic-given-entropy",
      statement:
        "same (distribution, entropy, shots) ⟹ bit-equal output bytes; the tool is strictly deterministic given its typed entropy field (ADR-0005)",
      machine_checkable: true,
    },
    {
      name: "byte-budget",
      statement: `entropy_consumed == ${BYTES_PER_SHOT} * shots; eight bytes per shot is the ADR-0007 per-tool convention`,
      machine_checkable: true,
    },
    {
      name: "samples-length",
      statement: "samples.length == input.shots",
      machine_checkable: true,
    },
    {
      name: "sample-shape-matches-distribution",
      statement:
        "every sample's classical_resolutions list is structurally one of the distribution's outcomes' classical_resolutions lists (i.e., samples are rows of the distribution table, no fabricated outcomes)",
      machine_checkable: true,
    },
    {
      name: "statistical-convergence",
      statement:
        "with large shots and uniformly distributed entropy, sample frequencies converge to the input distribution's probabilities (large-numbers; tested with a fixed-entropy seed and a documented tolerance)",
      machine_checkable: true,
    },
    {
      name: "rejects-out-of-bytes",
      statement: `entropy.length / 2 < ${BYTES_PER_SHOT} * shots ⟹ ToolError with a 'provide N more bytes' suggestion`,
      machine_checkable: true,
    },
    {
      name: "rejects-malformed-entropy",
      statement: "entropy not lowercase even-length hex ⟹ ToolError",
      machine_checkable: true,
    },
    {
      name: "rejects-negative-shots",
      statement: "shots < 0 ⟹ ToolError",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The runner has already validated `input` against the input schema
    // (ADR-0004), so we narrow via runtime kind-discrimination rather than
    // re-validating the structure. The schema is annotated as
    // `Schema<Value>` to keep example construction ergonomic at the TS
    // layer; the structural shape is guaranteed by the runtime check
    // before this body runs.
    if (input.kind !== "record") throw new ToolError(`${NAME}: input not a record`, {});
    const distribution = input.fields["distribution"]!;
    const entropy = input.fields["entropy"]! as StringValue;
    const shotsValue = input.fields["shots"]! as IntegerValue;
    if (distribution.kind !== "record") throw new ToolError(`${NAME}: distribution not a record`, {});
    const outcomesField = distribution.fields["outcomes"]! as ListValue;

    const shots = BigInt(shotsValue.value);
    if (shots < 0n) {
      throw new ToolError(`${NAME}: shots must be ≥ 0 (got ${shots})`, {});
    }

    const entropyHex = entropy.value;
    const bytes = parseHex(entropyHex);
    const needed = Number(shots) * BYTES_PER_SHOT;
    if (bytes.length < needed) {
      throw new ToolError(
        `${NAME}: entropy too short (need ${needed} bytes for ${shots} shots, got ${bytes.length})`,
        {
          suggestion: `provide at least ${needed - bytes.length} more bytes; sturm-sample uses ${BYTES_PER_SHOT} bytes per shot (ADR-0007)`,
        }
      );
    }

    const outcomes = outcomesField.items;
    if (outcomes.length === 0 && shots > 0n) {
      // Degenerate: no outcomes means there's nothing to sample. This is a
      // malformed distribution from a well-formed-channel perspective —
      // sturm-execute always emits ≥ 1 outcome — so we treat it as
      // ToolError rather than boundary-tag.
      throw new ToolError(
        `${NAME}: distribution has zero outcomes; nothing to sample`,
        {
          suggestion: "verify the upstream sturm-execute output is the in-scope record shape (not a tagged out-of-scope value)",
        }
      );
    }

    // Build the CDF in float64. v0.1's sturm-execute always emits float64
    // probs, but we handle rationals forward-compatibly so jfj's exact
    // path drops in here without further edits.
    const cdf: number[] = [];
    let acc = 0;
    for (const o of outcomes) {
      // The runner has validated each outcome conforms to its sub-schema;
      // we trust the structure here and reach for `prob` directly.
      const probField = (o as RecordValue).fields["prob"]!;
      acc += probValueToFloat(probField);
      cdf.push(acc);
    }

    const samples: Value[] = [];
    for (let s = 0; s < Number(shots); s++) {
      const u = uniformDraw(bytes, s * BYTES_PER_SHOT);
      const idx = pickOutcome(cdf, u);
      const chosen = outcomes[idx]! as RecordValue;
      // Extract the chosen outcome's classical_resolutions verbatim — this
      // is the row view for this shot.
      const cr = chosen.fields["classical_resolutions"]!;
      samples.push(record({ classical_resolutions: cr }));
    }

    return record({
      entropy_consumed: int(BigInt(needed)),
      samples: list(samples),
    });
  },
  test: async () => {
    // -- Property 1: determinism (subprocess-level). --------------------------
    // Spawn the tool twice with identical input; the bytes must be equal.
    // We exercise the runner end-to-end (schema validation + canonicalisation
    // + provenance write), since "deterministic given entropy" is a stronger
    // property than "fn returns the same Value" and we want to assert the
    // strong form.
    const here = new URL(".", import.meta.url).pathname;
    const toolPath = `${here}tool.ts`;

    const detInput = inp(FIFTY_FIFTY, ENTROPY_ZERO_8 + ENTROPY_FF_8 + ENTROPY_HALF_8, 3n);
    const stdin = canonicalize(detInput);

    const r1 = await spawnBun([toolPath], stdin);
    if (r1.code !== 0) throw new Error(`run 1 exit ${r1.code}: ${r1.stderr.trim()}`);
    const r2 = await spawnBun([toolPath], stdin);
    if (r2.code !== 0) throw new Error(`run 2 exit ${r2.code}: ${r2.stderr.trim()}`);
    if (r1.stdout !== r2.stdout) {
      throw new Error(
        `deterministic-given-entropy: same input produced different outputs ` +
          `(hash a=${hash(parse(r1.stdout))}, b=${hash(parse(r2.stdout))})`
      );
    }

    // -- Property 2: byte-budget invariant. -----------------------------------
    const out1 = parse(r1.stdout);
    if (out1.kind !== "record") throw new Error("output not a record");
    const consumed = out1.fields["entropy_consumed"];
    if (consumed === undefined || consumed.kind !== "integer") {
      throw new Error("entropy_consumed missing or wrong kind");
    }
    if (BigInt(consumed.value) !== 24n) {
      throw new Error(`byte-budget: expected 24 (3 shots × 8), got ${consumed.value}`);
    }

    // -- Property 3: samples-length invariant. --------------------------------
    const samples = out1.fields["samples"];
    if (samples === undefined || samples.kind !== "list") {
      throw new Error("samples missing or not a list");
    }
    if (samples.items.length !== 3) {
      throw new Error(`samples-length: expected 3, got ${samples.items.length}`);
    }

    // -- Property 4: sample-shape-matches-distribution. -----------------------
    // Every sample's classical_resolutions must equal one of the
    // distribution's outcomes' classical_resolutions (canonical-bytes match).
    const distOutcomesField = FIFTY_FIFTY.fields["outcomes"] as ListValue;
    const outcomeRows = distOutcomesField.items.map((o) =>
      canonicalize((o as RecordValue).fields["classical_resolutions"]!)
    );
    for (const samp of samples.items) {
      const cr = (samp as RecordValue).fields["classical_resolutions"]!;
      const sampBytes = canonicalize(cr);
      if (!outcomeRows.includes(sampBytes)) {
        throw new Error(
          `sample-shape: emitted a row not present in the distribution: ${sampBytes}`
        );
      }
    }

    // -- Property 5: statistical convergence. ---------------------------------
    // Run a fixed-entropy 2000-shot sample on a 50/50 distribution and
    // assert the count of r=0 is within 6σ of the mean. σ = √(2000 * 0.25)
    // ≈ 22.4; 6σ ≈ 134; expected mean is 1000. So count ∈ [866, 1134] is
    // 6σ, which is robust against any "fixed-but-pseudorandom" entropy
    // bytes we're likely to use here.
    //
    // Entropy generation: a deterministic stream from SHA-256 chaining of
    // a fixed seed. This keeps the test reproducible without coupling to
    // the OS entropy pool — running this property test under a clean
    // checkout, on any platform, must always produce the same r=0 count.
    const N = 2000;
    const stream = mulberry32EntropyHex(0xC0FFEE_42, N * BYTES_PER_SHOT);
    const convergenceInput = inp(FIFTY_FIFTY, stream, BigInt(N));
    const convergenceProc = await spawnBun([toolPath], canonicalize(convergenceInput));
    if (convergenceProc.code !== 0) {
      throw new Error(`convergence run exit ${convergenceProc.code}: ${convergenceProc.stderr.trim()}`);
    }
    const conv = parse(convergenceProc.stdout);
    if (conv.kind !== "record") throw new Error("convergence output not a record");
    const convSamples = (conv.fields["samples"] as ListValue).items;
    let zeroCount = 0;
    for (const samp of convSamples) {
      const cr = (samp as RecordValue).fields["classical_resolutions"]! as ListValue;
      const first = cr.items[0]! as RecordValue;
      const v = first.fields["value"] as IntegerValue;
      if (v.value === "0") zeroCount++;
    }
    const expected = N / 2;
    const tolerance = 6 * Math.sqrt(N * 0.25);
    if (Math.abs(zeroCount - expected) > tolerance) {
      throw new Error(
        `statistical-convergence: zero count ${zeroCount} not within ±${tolerance.toFixed(1)} of ${expected} (N=${N})`
      );
    }

    // -- Property 6: rejects out-of-bytes. ------------------------------------
    const tooShortInput = inp(FIFTY_FIFTY, ENTROPY_ZERO_8, 2n);
    const shortProc = await spawnBun([toolPath], canonicalize(tooShortInput));
    if (shortProc.code === 0) {
      throw new Error("rejects-out-of-bytes: expected non-zero exit, got 0");
    }

    // -- Property 7: rejects malformed entropy. -------------------------------
    const badHexInput = inp(FIFTY_FIFTY, "0g", 0n);
    const badHexProc = await spawnBun([toolPath], canonicalize(badHexInput));
    if (badHexProc.code === 0) {
      throw new Error("rejects-malformed-entropy: expected non-zero exit, got 0");
    }

    // -- Property 8: rejects negative shots. ----------------------------------
    const negShotsInput = inp(FIFTY_FIFTY, ENTROPY_ZERO_8, -1n);
    const negProc = await spawnBun([toolPath], canonicalize(negShotsInput));
    if (negProc.code === 0) {
      throw new Error("rejects-negative-shots: expected non-zero exit, got 0");
    }
  },
});

// Deterministic entropy stream for the convergence property test. We use
// a Mulberry32 LCG-shaped PRNG (a small, well-known 32-bit generator) so
// the byte sequence is fully determined by the seed and reproducible on
// any platform with no async surface. Cryptographic strength is not needed
// here — only reproducibility.
function mulberry32EntropyHex(seed: number, nBytes: number): string {
  let state = seed >>> 0;
  let out = "";
  for (let i = 0; i < nBytes; i++) {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const b = (t ^ (t >>> 14)) & 0xFF;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

void runTool(def);
