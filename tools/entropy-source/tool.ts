// =============================================================================
// entropy-source — the workbench's privileged nondeterministic primitive
// =============================================================================
//
// Intent
// ------
// Read `n_bytes` of OS-randomness from the Web Crypto `getRandomValues`
// pool, hex-encode them, and return the resulting byte string alongside a
// label naming the source. This is the *only* tool in v0.2 that legitimately
// fails the workbench's strict-determinism contract: invoke it twice with
// the same stdin and you will (modulo astronomically unlikely collisions)
// get two different outputs.
//
// Why a single privileged tool, and why this shape? The full rationale lives
// in `docs/adr/0005-externalised-entropy.md`. The short version: every
// other tool that needs randomness — quantum sampling, Monte-Carlo, future
// hardware bridges — takes its bytes as a typed `entropy: string` field on
// its input record, and stays strictly deterministic given those bytes.
// `entropy-source` is the bridge from "the world's randomness" to "a value
// in the canonical protocol," and concentrates the contract relaxation in
// one auditable place rather than scattering it through every consumer.
//
// The annotation `nondeterministic: true` is set on the manifest. It
// propagates into the provenance record so a consumer reading
// `--provenance-of <hash>` can tell that this particular output was a
// single observed sample and is not re-derivable from inputs.
//
// Input shape
// -----------
//   record { n_bytes: integer }
//
// Range: `n_bytes ∈ [1, 1_048_576]`. Lower bound is 1 because zero-byte
// entropy is malformed quantum-mechanics-grade randomness — a caller asking
// for zero bytes wants something else (perhaps a no-op record stub) and we
// would rather raise loudly than silently accept. Upper bound is 1 MiB,
// well beyond any plausible single-tool consumer (`sturm-sample` consumes
// 8 bytes per CDF draw, so 1 MiB ≈ 130k shots). Above the cap, callers
// should chunk via repeated invocation; a single tool call should not
// monopolise OS entropy beyond the cap.
//
// Output shape
// ------------
//   record { bytes: string, source_kind: "os-urandom" }
//
// `bytes` is lowercase hex without an `0x` prefix; its length is
// exactly `2 * n_bytes`. `source_kind` is the literal string
// `"os-urandom"` — a pinned label rather than free-form so registry
// consumers (and future audits of "where did this entropy come from?")
// can match on a fixed vocabulary. Future sources (a hardware QRNG,
// a deterministic PRF for testing) would extend the literal-union;
// v0.2 admits exactly the one source.
//
// Algorithm
// ---------
// `crypto.getRandomValues(new Uint8Array(n))` chunked in 65 536-byte
// blocks (the Web Crypto spec's per-call ceiling). Hex-encode each byte
// as a two-character lowercase nibble pair and concatenate. The whole
// thing is O(n), with a fast `toString(16).padStart(2, "0")` per byte.
//
// Goldens
// -------
// Goldens for this tool are intentionally empty — see `goldens.spec.ts`
// for the rationale. The `--test` hook is the load-bearing verification
// surface: it spawns the tool twice with a fixed input and asserts every
// shape invariant (byte count, hex format, source-kind label, the two
// outputs differing).

import {
  canonicalize,
  int,
  parse,
  record,
  S,
  str,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool, spawnBun } from "@workbench/contract";

const NAME = "entropy-source";
const VERSION = "0.1.0";

const MAX_N_BYTES = 1_048_576; // 1 MiB
const WEBCRYPTO_CHUNK = 65_536; // Web Crypto getRandomValues per-call ceiling

const inputSchema = S.record({
  n_bytes: S.kind("integer"),
});

const outputSchema = S.record({
  bytes: S.kind("string"),
  source_kind: S.literal(str("os-urandom")),
});

// Helper: build a representative input record. We let TS infer the narrow
// return type (`{kind:"record", fields:{n_bytes: IntegerValue}}`) — an
// explicit `RecordValue` annotation would widen and lose the field
// inference the schema needs at load time.
const inp = (n: bigint) => record({ n_bytes: int(n) });

function fillRandom(buf: Uint8Array): void {
  // Web Crypto caps at 65 536 bytes per call. Chunk when the request is
  // larger; each fill is independent so the concatenation is itself
  // uniform. (Browser/Node/Bun all agree on the limit.)
  for (let off = 0; off < buf.length; off += WEBCRYPTO_CHUNK) {
    const end = Math.min(off + WEBCRYPTO_CHUNK, buf.length);
    crypto.getRandomValues(buf.subarray(off, end));
  }
}

function hexEncode(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

const HEX_RE = /^[0-9a-f]*$/;

export const def = defineTool({
  name: NAME,
  version: VERSION,
  nondeterministic: true,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    // Output is omitted on every example: the tool is genuinely
    // nondeterministic, so a "concrete output" would be a lie that
    // happens to typecheck. The description carries the shape commitment
    // (length, hex, source_kind) for an agent reading `--examples`.
    {
      description:
        "1 byte: shortest legitimate request → bytes is 2 hex chars, source_kind 'os-urandom'",
      input: inp(1n),
    },
    {
      description:
        "8 bytes: one uniform-[0,1) CDF draw worth (sturm-sample's per-shot budget)",
      input: inp(8n),
    },
    {
      description:
        "16 bytes: 128-bit seed; collision probability between calls is ~2^-64 per pair",
      input: inp(16n),
    },
    {
      description: "32 bytes: SHA-256-shaped seed",
      input: inp(32n),
    },
    {
      description: "64 bytes: enough for ~8 sturm-sample shots",
      input: inp(64n),
    },
    {
      description: "256 bytes: ~32 shots' worth of CDF draws",
      input: inp(256n),
    },
    {
      description: "n_bytes = 0: malformed (zero-byte entropy is not a thing)",
      input: inp(0n),
      error: `${NAME}: n_bytes must be ≥ 1 (got 0)`,
    },
    {
      description: "negative n_bytes: malformed",
      input: inp(-4n),
      error: `${NAME}: n_bytes must be ≥ 1 (got -4)`,
    },
    {
      description: `n_bytes above the ${MAX_N_BYTES.toLocaleString("en-US")}-byte cap: malformed; suggest chunking`,
      input: inp(BigInt(MAX_N_BYTES + 1)),
      error: `${NAME}: n_bytes must be ≤ ${MAX_N_BYTES} (got ${MAX_N_BYTES + 1})`,
    },
  ],
  invariants: [
    {
      name: "byte-count",
      statement: "output.bytes.length == 2 * input.n_bytes (lowercase hex, two chars per byte)",
      machine_checkable: true,
    },
    {
      name: "hex-format",
      statement: "output.bytes matches /^[0-9a-f]*$/ — lowercase hex, no '0x' prefix",
      machine_checkable: true,
    },
    {
      name: "source-kind-pinned",
      statement: "output.source_kind == 'os-urandom' for every v0.2 invocation",
      machine_checkable: true,
    },
    {
      name: "nondeterministic-by-design",
      statement:
        "two invocations with the same input produce different output bytes with probability 1 - 2^(-8 * n_bytes); the only tool in v0.2 with this property",
      machine_checkable: true,
    },
    {
      name: "rejects-zero",
      statement: "n_bytes ≤ 0 raises ToolError",
      machine_checkable: true,
    },
    {
      name: "rejects-over-cap",
      statement: `n_bytes > ${MAX_N_BYTES} raises ToolError suggesting chunked retrieval`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The schema runner has already narrowed `input` to a record carrying a
    // single integer field. We still range-check at the value level: the
    // schema language's `S.kind("integer")` does not admit predicate
    // refinements (ADR-0004 §"Three deliberate omissions"), so bounds
    // enforcement lives here.
    const n = BigInt(input.fields.n_bytes.value);
    if (n < 1n) {
      throw new ToolError(`${NAME}: n_bytes must be ≥ 1 (got ${n})`, {
        suggestion:
          "request at least 1 byte; if you wanted a no-op, build the consumer's input record without an entropy field",
      });
    }
    if (n > BigInt(MAX_N_BYTES)) {
      throw new ToolError(
        `${NAME}: n_bytes must be ≤ ${MAX_N_BYTES} (got ${n})`,
        {
          suggestion: `request at most ${MAX_N_BYTES} bytes per call; for larger budgets, invoke ${NAME} repeatedly and concatenate the resulting hex strings`,
        }
      );
    }
    const buf = new Uint8Array(Number(n));
    fillRandom(buf);
    return record({
      bytes: str(hexEncode(buf)),
      source_kind: str("os-urandom"),
    });
  },
  test: async () => {
    // Two-call comparison. Spawning the tool twice (rather than calling fn
    // directly) exercises the runner's schema-validation, output-encoding,
    // and provenance-write paths end-to-end — the property "two calls
    // differ" is the only one for which an in-process call would be a
    // weaker statement than a subprocess call.
    const here = new URL(".", import.meta.url).pathname;
    const toolPath = `${here}tool.ts`;

    async function callOnce(n: number): Promise<{ bytes: string; source_kind: string }> {
      const stdin = canonicalize(inp(BigInt(n)));
      const proc = await spawnBun([toolPath], stdin);
      if (proc.code !== 0) {
        throw new Error(`tool exit ${proc.code}: ${proc.stderr.trim()}`);
      }
      const v: Value = parse(proc.stdout);
      if (v.kind !== "record") throw new Error(`expected record, got ${v.kind}`);
      const b = v.fields["bytes"];
      const sk = v.fields["source_kind"];
      if (b === undefined || b.kind !== "string") {
        throw new Error("missing/non-string bytes field");
      }
      if (sk === undefined || sk.kind !== "string") {
        throw new Error("missing/non-string source_kind field");
      }
      return { bytes: b.value, source_kind: sk.value };
    }

    // Property 1: byte-count invariant for several sizes.
    for (const n of [1, 8, 32, 256]) {
      const r = await callOnce(n);
      if (r.bytes.length !== 2 * n) {
        throw new Error(`byte-count: n=${n} expected ${2 * n} hex chars, got ${r.bytes.length}`);
      }
      if (!HEX_RE.test(r.bytes)) {
        throw new Error(`hex-format: n=${n} output ${JSON.stringify(r.bytes.slice(0, 32))} not lowercase hex`);
      }
      if (r.source_kind !== "os-urandom") {
        throw new Error(`source-kind: expected 'os-urandom', got ${JSON.stringify(r.source_kind)}`);
      }
    }

    // Property 2: nondeterminism. Two 32-byte calls must differ. Collision
    // probability is ~2^-256 — astronomically below the IEEE noise floor.
    // If this ever fires, something is broken (a missing seed advance, a
    // confused entropy pool, or a subprocess that mistakenly memoises).
    const a = await callOnce(32);
    const b = await callOnce(32);
    if (a.bytes === b.bytes) {
      throw new Error(
        "nondeterministic-by-design: two consecutive 32-byte calls produced identical output — entropy source is broken"
      );
    }

    // Property 3: malformed inputs raise (subprocess exits non-zero).
    async function expectFail(n: bigint): Promise<void> {
      const stdin = canonicalize(inp(n));
      const proc = await spawnBun([toolPath], stdin);
      if (proc.code === 0) {
        throw new Error(`expected non-zero exit for n_bytes=${n}, got 0 with stdout ${proc.stdout.slice(0, 80)}`);
      }
    }
    await expectFail(0n);
    await expectFail(-1n);
    await expectFail(BigInt(MAX_N_BYTES + 1));
  },
});

void runTool(def);
