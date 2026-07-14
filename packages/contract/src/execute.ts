// =============================================================================
// executeToolDef — the work case of the contract dispatcher, factored out
// =============================================================================
//
// Substrate: ADR-0012 ("the work-case helper, factored").
//
// `runTool` (subprocess surface) and `Workbench.run` (in-process
// surface, in `@workbench/compose`) both need the same five steps in
// the same order:
//
//   1. validate `input` against `def.schema.input`
//   2. call `def.fn(input, flags)`
//   3. validate the output against `def.schema.output`
//   4. canonicalise the output and hash it
//   5. write a provenance record indexed by output hash
//
// Steps 1–4 are pure (no IO except `fn`'s own work). Step 5 is the
// only IO and is best-effort: a write failure must not destroy the
// caller's output. Both surfaces handle the failure differently —
// `runTool` writes a stderr warning and continues, `Workbench.run`
// can surface it on the returned tuple. So this helper writes
// provenance, swallows the error into a `provenanceError` field, and
// returns the data; the caller decides what to do with it.
//
// Single-implementation discipline (CLAUDE.md Rule 1, ADR-0012). If
// `runTool` and `Workbench.run` ever drift, the in-process and
// subprocess surfaces produce different bytes for the same inputs —
// the precise failure mode the workbench is built to prevent. We
// route both through this one function.

import {
  canonicalize,
  containsFloat64,
  hash,
  hashCanonicalBytes,
  ToolError,
  validate,
  type Hash,
  type Value,
} from "@workbench/protocol";
import type { FlagSchema, FlagsOf } from "./flags.js";
import { currentPlatform, currentPlatformHash } from "./platform.js";
import {
  writeProvenance,
  type ProvenanceRecord,
} from "./provenance.js";
import {
  defaultStore,
  writeByInputIndex,
  writeValue,
} from "./store.js";
import type { ToolDefinition } from "./runner.js";

export interface ExecuteResult<O extends Value> {
  /** The tool's output Value (already validated against `def.schema.output`). */
  output: O;
  /** Canonical bytes of `output` — the same bytes a subprocess would write to stdout. */
  outputBytes: string;
  /** sha256 of `outputBytes`. */
  outputHash: Hash;
  /** sha256 of the input Value's canonical bytes. */
  inputHash: Hash;
  /**
   * Provenance write failure (if any). Best-effort write: success
   * leaves this `null`, failure leaves the captured Error here. The
   * caller's output is *never* destroyed by a provenance error.
   */
  provenanceError: Error | null;
}

export interface ExecuteOptions {
  /**
   * Flags the caller explicitly set, in their argv-string form. The
   * provenance record's `flags` field records *only* these, so two
   * invocations differing only in default-overlap produce
   * byte-identical provenance bytes (ADR-0011).
   *
   * Subprocess callers pass the `explicit` map produced by
   * `parseFlagsFromArgv`. In-process callers derive it from their
   * partial flags argument via `explicitStringsFromPartial` (below).
   */
  explicitFlags?: Record<string, string>;

  /**
   * Override the provenance store path. Default: `process.env.CAS_STORE`,
   * else `defaultStore()`.
   */
  store?: string;

  /**
   * Override the env source for store resolution. Useful for tests
   * that want to scope `CAS_STORE` to a single call.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Run a tool's `fn` against a typed input + flag set, validating
 * input/output against the declared schema and writing a provenance
 * record on success. The input must already be a Value (no JSON
 * parsing) and must already satisfy `def.schema.input`'s declared
 * structural shape — validation runs here regardless because the
 * declared TS type is structural (a record-of-records can't be
 * trusted at runtime).
 *
 * Schema-validation failures (input or output) throw `ToolError`. The
 * input failure is user-facing (the agent gave a wrong-shaped value);
 * the output failure is internal (the tool's `fn` violated its own
 * contract). Callers of this helper translate both as appropriate
 * for their surface — `runTool` lets them propagate to its
 * top-level `try` and exit 1; `Workbench.run` re-wraps them as
 * `CompositionError` carrying the tool name.
 */
export async function executeToolDef<
  I extends Value,
  O extends Value,
  Fl extends FlagSchema,
>(
  def: ToolDefinition<I, O, Fl>,
  input: I,
  flags: FlagsOf<Fl>,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult<O>> {
  // 0. Mutual-exclusion check on tier annotations (ADR-0015). A tool
  //    that asserts more than one tier annotation (e.g. both
  //    `nondeterministic: true` — no determinism contract — and
  //    `numerical: true` — platform-conditional contract) is a
  //    contract violation: the tiers describe different relaxations
  //    of the determinism rule and a tool cannot be in more than one
  //    at once. Caught here (rather than
  //    in `defineTool`) so the failure surfaces consistently across
  //    every entry point — including in-process callers that bypass
  //    the runner.
  // ADR-0015 + ADR-0020: the four tier annotations are mutually exclusive.
  // Default = symbolic; `nondeterministic` opts out; `numerical` is float64
  // platform-conditional; `arbprec` is BigInt-substrate cross-platform-
  // deterministic with an explicit precision flag.
  const tierCount =
    (def.nondeterministic === true ? 1 : 0) +
    (def.numerical === true ? 1 : 0) +
    (def.arbprec === true ? 1 : 0);
  if (tierCount > 1) {
    throw new ToolError(
      `${def.name}: at most one of nondeterministic / numerical / arbprec may be declared (ADR-0015 + ADR-0020)`,
      {
        suggestion:
          "stochastic tools have no determinism contract; numerical tools are platform-conditional; arbprec tools are bit-deterministic given an explicit precision flag. Pick exactly one — or none for the default symbolic tier.",
      },
    );
  }

  // 1. Input validation. ADR-0004 names this as the contract; the
  //    in-process surface honours it identically to the subprocess
  //    surface. Cost: O(value size); dwarfed by anything else.
  const inputCheck = validate(input, def.schema.input);
  if (!inputCheck.ok) {
    throw new ToolError(
      `${def.name}: input does not conform to schema (at $.${
        inputCheck.failure.path.join(".") || "<root>"
      }): ${inputCheck.failure.message}`,
      {
        suggestion:
          "run `--schema` to see the declared shape; check field names, kinds, and required fields",
        detail: { path: inputCheck.failure.path },
      },
    );
  }

  // 2. Run the tool.
  const output = await def.fn(input as I, flags);

  // 3. Output validation. Failure here is an internal contract
  //    violation (the tool author shipped a wrong-shaped output).
  const outputCheck = validate(output, def.schema.output);
  if (!outputCheck.ok) {
    throw new ToolError(
      `${def.name}: tool output violates declared schema (internal bug, at $.${
        outputCheck.failure.path.join(".") || "<root>"
      }): ${outputCheck.failure.message}`,
      {
        suggestion:
          "the tool's `fn` returned a Value that does not conform to schema.output; this is a bug in the tool, not the input",
        detail: { path: outputCheck.failure.path },
      },
    );
  }

  // 4. Canonicalise + hash. We canonicalise the output once and reuse
  //    the bytes for both stdout (subprocess case) and the hash —
  //    `hashCanonicalBytes` skips the redundant canonicalise inside
  //    `hash`. The input hash is needed for the provenance record's
  //    `inputs[].hash` field.
  const outputBytes = canonicalize(output);
  const outputHash = hashCanonicalBytes(outputBytes);
  const inputHash = hash(input);

  // 5. Persistence — best-effort, three writes:
  //    (a) the output Value at $CAS_STORE/values/<hh>/<output>.json,
  //    (b) the provenance record at $CAS_STORE/provenance/...,
  //    (c) the reverse index $CAS_STORE/by-input/<hh>/<input>--<tool>--<version>.json
  //        pointing to the output hash, so `Workbench.lookup` is O(1).
  //
  //    We serialise the writes to keep the order deterministic — if
  //    the value write succeeds but provenance fails, the next
  //    invocation can still find the value but won't have the
  //    derivation. The reverse index goes last, after both: a hit on
  //    the index implies the value exists and has provenance.
  //
  //    For `nondeterministic: true` tools (entropy-source), we *skip*
  //    the reverse-index write — looking up a previous invocation
  //    would silently invent determinism the contract does not
  //    promise. The forward provenance is still written (the
  //    derivation is recorded; the record's `nondeterministic` flag
  //    tells consumers what the record means).
  //
  //    Failure on any step is captured into `persistenceError` and
  //    returned; the caller's output is never destroyed.
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const store = opts.store ?? env["CAS_STORE"] ?? defaultStore();

  const rec: ProvenanceRecord = {
    tool: { name: def.name, version: def.version },
    inputs: [{ name: "stdin", hash: inputHash }],
    flags: opts.explicitFlags ?? {},
    output_hash: outputHash,
  };
  if (def.nondeterministic === true) rec.nondeterministic = true;

  // ADR-0015: per-execution determinism-tier conditioning. A tool
  // annotated `numerical: true` is platform-conditional *iff* the
  // actual output contains float64 leaves. Same tool, different inputs
  // can produce different-tier outputs (precedent: ADR-0007's
  // `precision: "exact" | "float64"` field). We capture the running
  // platform fingerprint only for the genuinely-platform-conditional
  // executions; symbolic outputs of a numerical tool (Clifford+T
  // exact-symbolic when sturm-execute's exact path lands, bead `jfj`)
  // get no platform field.
  let platformHashForIndex: Hash | null = null;
  if (def.numerical === true && containsFloat64(output)) {
    rec.platform = currentPlatform();
    platformHashForIndex = currentPlatformHash();
  }

  let persistenceError: Error | null = null;
  try {
    await writeValue(store, output);
    await writeProvenance(store, rec);
    if (def.nondeterministic !== true) {
      // The reverse index encodes the platform hash when the record
      // carries a `platform` field — different-platform records coexist
      // under distinct index filenames, so a future `lookup` from a
      // different platform sees a miss instead of stale bytes.
      await writeByInputIndex(
        store, inputHash, def.name, def.version, outputHash, platformHashForIndex,
      );
    }
  } catch (e) {
    persistenceError = e instanceof Error ? e : new Error(String(e));
  }

  return {
    output: output as O,
    outputBytes,
    outputHash,
    inputHash,
    provenanceError: persistenceError,
  };
}

// -----------------------------------------------------------------------------
// In-process flag handling — defaults, validation, explicit-string derivation
// -----------------------------------------------------------------------------
//
// `runTool` derives `FlagsOf<Fl>` from argv via
// `parseFlagsFromArgv`. The in-process surface accepts a partial
// record from a TS call site and applies the same default-application
// + type-coercion machinery, then derives the argv-equivalent string
// form for provenance.
//
// Why these helpers live here rather than in flags.ts: they operate
// on a `ToolDefinition` (specifically `def.flags`) and are only
// useful to consumers that already have a `def` in hand.

/**
 * Apply defaults to a partial flags object, type-validate the values
 * the caller did pass, and return a fully-resolved `FlagsOf<Fl>`.
 *
 * Throws a `ToolError` on type mismatch with the same shape the runner
 * surfaces from argv parsing — wrong-typed flags fail loudly.
 */
export function resolveFlagsForCall<Fl extends FlagSchema>(
  schema: Fl,
  partial: Record<string, unknown> = {},
): FlagsOf<Fl> {
  // Reject unknown keys. The TS-expert call site catches this at
  // compile time when calling through the typed barrel; the loose
  // surface (`wb.run`) catches it here at runtime.
  for (const k of Object.keys(partial)) {
    if (!(k in schema)) {
      throw new ToolError(
        `unknown flag '${k}' for this tool`,
        {
          suggestion:
            Object.keys(schema).length === 0
              ? "this tool declares no flags"
              : `valid flags: ${Object.keys(schema).map((v) => `--${v}`).join(", ")}`,
          detail: { unknown: k },
        },
      );
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const passed = (name in partial) ? partial[name] : undefined;

    if (spec.kind === "bool") {
      if (passed === undefined) {
        out[name] = false;
      } else if (typeof passed === "boolean") {
        out[name] = passed;
      } else {
        throw new ToolError(
          `flag '${name}': expected boolean, got ${typeof passed}`,
          { detail: { name, kind: "bool", got: typeof passed } },
        );
      }
      continue;
    }

    if (passed === undefined) {
      out[name] = spec.default ?? undefined;
      continue;
    }

    switch (spec.kind) {
      case "str":
        if (typeof passed !== "string") {
          throw new ToolError(
            `flag '${name}': expected string, got ${typeof passed}`,
            { detail: { name, kind: "str", got: typeof passed } },
          );
        }
        out[name] = passed;
        break;
      case "int":
        if (typeof passed !== "bigint") {
          throw new ToolError(
            `flag '${name}': expected bigint, got ${typeof passed}`,
            {
              suggestion:
                "in-process int flags use bigint, not number — write `10n` not `10`",
              detail: { name, kind: "int", got: typeof passed },
            },
          );
        }
        if (spec.min !== undefined && passed < spec.min) {
          throw new ToolError(
            `flag '${name}': ${passed} is below declared minimum ${spec.min}`,
            { detail: { name, kind: "int", got: String(passed) } },
          );
        }
        if (spec.max !== undefined && passed > spec.max) {
          throw new ToolError(
            `flag '${name}': ${passed} is above declared maximum ${spec.max}`,
            { detail: { name, kind: "int", got: String(passed) } },
          );
        }
        out[name] = passed;
        break;
      case "enum":
        if (typeof passed !== "string" || !spec.values.includes(passed)) {
          throw new ToolError(
            `flag '${name}': ${JSON.stringify(passed)} is not one of the declared values`,
            {
              suggestion: `valid values: ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`,
              detail: { name, kind: "enum", got: passed },
            },
          );
        }
        out[name] = passed;
        break;
    }
  }

  return out as FlagsOf<Fl>;
}

/**
 * Render the `Record<string, string>` argv-equivalent of a partial
 * flags object, for the provenance record. Mirrors the rule
 * `parseFlagsFromArgv` produces from argv:
 *
 *   * bool flags: present iff true (absence = false; we don't record
 *     redundant false entries because they are structurally the
 *     default).
 *   * int / str / enum: present iff the caller passed a value (we
 *     record what they said, even if it matches the declared default
 *     — this matches argv where `--mode=exact` is recorded as
 *     "exact" even when `exact` is the default).
 */
export function explicitStringsFromPartial<Fl extends FlagSchema>(
  schema: Fl,
  partial: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(partial)) {
    const spec = schema[k];
    if (spec === undefined) continue;  // unknown keys filtered by resolveFlagsForCall
    if (v === undefined) continue;
    switch (spec.kind) {
      case "bool":
        if (v === true) out[k] = "true";
        break;
      case "str":
        if (typeof v === "string") out[k] = v;
        break;
      case "int":
        if (typeof v === "bigint") out[k] = v.toString();
        break;
      case "enum":
        if (typeof v === "string") out[k] = v;
        break;
    }
  }
  return out;
}
