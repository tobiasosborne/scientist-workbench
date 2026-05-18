// =============================================================================
// runTool — the standard contract dispatcher
// =============================================================================
//
// Every tool in the workbench has the same shape: read a JSON value from
// stdin, write a JSON value to stdout, and accept a fixed set of standard
// flags (--schema, --examples, --invariants, --version, --help/-h,
// --provenance-of, --test). This module owns that shape.
//
// What this module does
// ---------------------
// 1. Merges the runner's standard flag table with the tool's declared
//    flags (ADR-0011). Any name collision fails at load time.
// 2. Parses argv against the merged FlagSchema with strict declared
//    arity — bool flags are switches, value flags consume the next
//    token. Unknown flags or unexpected positionals reject loudly.
// 3. Dispatches the standard flags. --schema, --examples, --invariants,
//    --version emit canonical JSON metadata. --provenance-of looks up a
//    derivation by output hash. --test runs the tool's optional in-process
//    property tests.
// 4. In the work case: parses stdin, *validates* the parsed Value against
//    `def.schema.input`, runs `def.fn` with a typed `flags` object,
//    validates the output against `def.schema.output`, writes canonical
//    bytes to stdout, and writes a provenance record.
//
// ADR-0004 — schema validation
// ----------------------------
// The schema validation hooks (added in ADR-0004) replace the hand-rolled
// `expectIntegerField` / `parseFooInput` shims that every tool used to
// carry. Tool authors declare a `Schema<I>` and the runner narrows the
// parsed Value to `I` before calling `fn`. The `fn` body sees an
// already-typed input. Output non-conformance is surfaced as a loud
// ToolError ("internal contract violation") rather than passed silently.
//
// ADR-0010 — defineTool / runTool split
// -------------------------------------
// `defineTool({...})` is a typed identity wrapper that returns the
// ToolDefinition unchanged but fixes its `I`, `O`, and `Fl` type
// parameters from the inline schema. `runTool(def, io?)` then performs
// the IO-bound dispatch above. Because every tool entry point gates
// `runTool` on `import.meta.main`, importing a tool module yields the
// live `def` without spawning a subprocess. The optional `RunIO`
// parameter is the IO half: tests inject argv / stdin / stdout /
// stderr / exit / env so the dispatcher itself is exercisable without
// a child process.
//
// ADR-0011 — typed flags
// ----------------------
// `ToolDefinition` gains a third generic `Fl extends FlagSchema = {}`.
// A tool's `flags` field declares CLI flags via `F.bool/.str/.int/.enum`;
// the typed object handed to `fn` is `FlagsOf<Fl>`. Defaults are
// non-undefined; absent declared flags without defaults are
// `T | undefined`; bool flags are always present (false when absent).

import {
  canonicalize,
  encodeSchema,
  list,
  parse,
  record,
  str,
  tagged,
  ToolError,
  validate,
  type Schema,
  type Value,
} from "@workbench/protocol";
import {
  F,
  FlagParseError,
  parseFlagsFromArgv,
  renderFlagsHelp,
  type FlagSchema,
  type FlagsOf,
} from "./flags.js";
import { exampleToValue, invariantToValue } from "./metadata.js";
import { provenanceToValue, readProvenance } from "./provenance.js";
import { defaultStore } from "./store.js";
import { decodeSchema } from "@workbench/protocol";
import { executeToolDef } from "./execute.js";
import { platformFingerprintBytes } from "./platform.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------
//
// `ToolDefinition<I, O, Fl>` is generic in the input Value type, the
// output Value type, and the flag schema. Tools that import
// `defineTool` and pass an inline schema get tight typing for free;
// the cost is invisible at the call site.

// `NoInfer<I>` makes the example's `input` checked against `I` without
// contributing to its inference. Otherwise TS picks `I` from the
// narrower of (schema-implied type) and (example-input type), and an
// example that omits an optional field would silently widen the
// inferred I to "record without that field" — which then breaks
// `fn`'s access to it. Schema is the source of truth; examples
// conform to it, not the other way around.
export interface ExampleEntry<I extends Value = Value, O extends Value = Value> {
  description: string;
  input: NoInfer<I>;
  output?: NoInfer<O>;
  error?: string;
  flags?: Record<string, string>;
}

export interface InvariantEntry {
  name: string;
  statement: string;
  machine_checkable?: boolean;
}

// Default flag schema: an empty record. Tools that declare no flags
// keep their `fn(input, _flags)` signature unchanged because
// `FlagsOf<EmptyFlags>` is `{}` — a true keyless object, not an
// index-signature type. The keyless form matters for `FlagsArgOf`'s
// intersection with the arbprec `{ precision?: bigint }` lift (bead
// `0y27`): a `Record<string, never>` keyless-by-value type carries an
// `[K in string]: never` index signature that poisons any intersection
// it participates in, forcing every key — `precision` included — to
// `never`. `Record<never, never>` has no index signature, so
// `Partial<{}> & { precision?: bigint } = { precision?: bigint }`
// resolves cleanly.
type EmptyFlags = Record<never, never>;

/**
 * Extract the input Value type from a `ToolDefinition`'s static type.
 * Used by the generated typed barrel (`@workbench/compose/wb`) to
 * derive each tool's TS-side input shape from the schema's inferred
 * generic. Equivalent type-extractors for the output and flags
 * follow.
 *
 *     type ModPowInput = InputOf<typeof modPowDef>;
 *     // → { kind: "record"; fields: { base: Integer; exponent: Integer; modulus: Integer } }
 *
 * Implementation note: we match on the *structural* shape rather than
 * positional generics on `ToolDefinition`. The positional form
 * (`D extends ToolDefinition<infer I, Value, FlagSchema>`) fails when
 * the def's actual `O`/`Fl` slots are narrower than `Value` /
 * `FlagSchema` — TS won't widen them to make the match. The schema
 * field of every `ToolDefinition` already carries `input: Schema<I>`,
 * so matching `{ schema: { input: Schema<infer I> } }` extracts I
 * directly without any widening dance.
 */
export type InputOf<D> = D extends { schema: { input: Schema<infer I> } } ? I : never;
export type OutputOf<D> = D extends { schema: { output: Schema<infer O> } } ? O : never;
/**
 * Caller-side flag shape: `Partial<FlagsOf<Fl>>` with the tier-additive
 * standard flags the runner contributes folded in. Defaults flow
 * through `resolveFlagsForCall`, so a caller is free to omit any flag
 * that has a declared default. Bool flags absent default to `false`. A
 * tool with no declared flags and no tier annotations resolves to
 * `Partial<{}>` ≅ `{}`, i.e. the parameter is functionally absent.
 *
 * Tier lift, today: `arbprec: true` tools (ADR-0020) get
 * `precision?: bigint` folded in on top of any declared flags, so
 *
 *     wb.hypergeometricPfq(input, { precision: 50n })
 *
 * typechecks through the typed barrel with no cast — the typed surface
 * mirrors the subprocess CLI's admissible-flag set per the ADR-0012
 * byte-identical contract. The lift is statically conditional on the
 * `arbprec: true` *literal* propagating into `ToolDefinition`'s
 * `Ar extends boolean` slot, which `defineTool`'s `const Ar` capture
 * preserves from the inline `arbprec: true` at the call site (bead
 * `0y27`, worklog 118).
 */
export type FlagsArgOf<D> =
  // Two-tier branching, no intersection. The naïve attempt to assemble
  // `<flags-branch> & <arbprec-lift>` ran into a tension: the flags-
  // branch's empty case wants to be strict (`Record<string, never>`,
  // "no flags allowed") so non-arbprec tools reject random keys, but
  // intersecting strict-empty with `{ precision?: bigint }` poisons the
  // `precision` slot to `never`. Loosening it to `{}` fixed the
  // intersection but then accepted any flag on any no-flag tool — the
  // `@ts-expect-error` negative test catches this. Wrapping both
  // contributions inside one conditional, with the arbprec branch
  // *replacing* the strict empty (rather than intersecting with it),
  // gets both properties.
  //
  // The arbprec check: wrap in `[.]` so a `true | undefined` from the
  // optional-field inference doesn't distribute into a union result;
  // `Exclude<Ar, undefined>` peels the optional-marker `undefined` off
  // so a tool declared with `arbprec: true` (typed as `arbprec?: true`
  // after `defineTool`'s `const Ar` capture) reads as `true` here.
  // `keyof Fl extends never` (also `[.]`-wrapped) detects "Fl truly
  // has no keys" — works because `EmptyFlags = Record<never, never>`
  // has `keyof = never`, whereas `{ op: EnumFlag<...> }` has
  // `keyof = "op"` ≠ `never`.
  D extends { arbprec?: infer Ar }
    ? [Exclude<Ar, undefined>] extends [true]
      // Arbprec tool: lift `precision?: bigint`, fold in any declared
      // flags.
      ? D extends { flags?: infer Fl }
        ? Fl extends FlagSchema
          ? [keyof Fl] extends [never]
            ? { precision?: bigint }
            : Partial<FlagsOf<Fl>> & { precision?: bigint }
          : { precision?: bigint }
        : { precision?: bigint }
      // Non-arbprec: strict declared flags or strict-empty.
      // The `[keyof Fl] extends [never]` discriminator is needed here
      // *too* — `EmptyFlags = Record<never, never>` runs through
      // `Partial<FlagsOf<...>>` to `{}`, which would accept random
      // keys; we want strict-empty for non-arbprec no-flag tools so
      // `{ precision: 50n }` on `modPow` is a compile-time error
      // (caught by this block's `@ts-expect-error` negative test).
      : D extends { flags?: infer Fl }
        ? Fl extends FlagSchema
          ? [keyof Fl] extends [never]
            ? Record<string, never>
            : Partial<FlagsOf<Fl>>
          : Record<string, never>
        : Record<string, never>
    : Record<string, never>;

export interface ToolDefinition<
  I extends Value = Value,
  O extends Value = Value,
  Fl extends FlagSchema = EmptyFlags,
  // The literal-preserving slot for `arbprec: true` (bead `0y27`).
  // The default is the wide `boolean`, not the narrow `false`, so a
  // function parameter typed as `ToolDefinition<...>` (no explicit
  // `Ar`) accepts both arbprec and non-arbprec defs and lets internal
  // call sites compare `def.arbprec === true` without TS rejecting the
  // narrow `false | undefined` shape. The `defineTool` `const Ar`
  // capture is what makes the typed barrel actually *see* `true`: at
  // an inline `arbprec: true` call site `Ar` narrows from the default
  // to the literal `true`, the returned definition is typed as
  // `ToolDefinition<..., true>`, and `FlagsArgOf` reads this slot to
  // lift `precision?: bigint` into the typed-barrel flag surface.
  Ar extends boolean = boolean,
> {
  name: string;
  version: string;
  schema: { input: Schema<I>; output: Schema<O> };
  flags?: Fl;
  examples: ExampleEntry<I, O>[];
  invariants: InvariantEntry[];
  fn: (input: I, flags: FlagsOf<Fl>) => O | Promise<O>;
  test?: () => void | Promise<void>;
  /**
   * Manifest annotation introduced by ADR-0005. When set to `true`, this
   * tool may emit different output bytes across runs given the same stdin —
   * it is consuming OS-randomness or another genuinely nondeterministic
   * source. The flag propagates into the provenance record so a consumer
   * reading `--provenance-of <hash>` knows the output is not re-derivable
   * from inputs alone. Default (absent / false): the tool is strictly
   * deterministic; the existing contract holds. The privileged consumer
   * is `entropy-source`; every other tool that needs randomness should
   * declare an `entropy: string` field in its input schema and remain
   * deterministic given those bytes.
   */
  nondeterministic?: boolean;
  /**
   * Manifest annotation introduced by ADR-0015. When set to `true`, this
   * tool may use IEEE-754 float ops in a way that depends on the running
   * platform's float runtime — bit-identical *given the platform
   * fingerprint* `{arch, os, runtime}`, not necessarily across platforms.
   *
   * The flag is the *tool author's declaration* that the tier may apply.
   * The runtime decision (whether the platform fingerprint is recorded)
   * happens per-execution in `executeToolDef`: a numerical-tier output
   * that contains at least one float64 leaf gets a `platform` field on
   * its provenance record; an output of pure-exact leaves does not. Same
   * tool, different inputs can produce different-tier outputs (precedent:
   * ADR-0007's `precision: "exact" | "float64"` field).
   *
   * Mutually exclusive with `nondeterministic: true` and `arbprec: true`
   * in practice. Asserting more than one is a load-time contract violation.
   *
   * Default (absent / false): the tool is symbolic — bit-identical
   * cross-platform forever, the unconditional rule.
   */
  numerical?: boolean;
  /**
   * Manifest annotation introduced by ADR-0020. When set to `true`, this
   * tool ships in arbitrary precision and accepts a `--precision=<int>`
   * standard flag (decimal digits, default 50). The output is bit-
   * identical *cross-platform forever* given the precision flag — `BigInt`
   * arithmetic is bit-identical across runtimes by JS language spec, so
   * the substrate carries no platform-conditional behaviour.
   *
   * Internally, `arbprec: true` tools use `@workbench/bigfloat` (or another
   * bit-deterministic substrate). No float64 in any code path that
   * contributes to the canonical output — auxiliary float64 for heuristics
   * is permitted iff it does not affect output bytes.
   *
   * Mutually exclusive with `nondeterministic: true` and `numerical: true`
   * in practice. Asserting more than one is a load-time contract violation.
   *
   * Default (absent / false): the tool is symbolic and does not take a
   * precision parameter.
   *
   * Generic-parameterised on `Ar` (bead `0y27`) so the `true` literal
   * propagates through `defineTool`'s `const Ar` capture into the
   * caller-visible type of the returned definition. `FlagsArgOf` reads
   * `arbprec` off that type to lift `precision?: bigint` into the
   * typed-barrel flag surface — without the literal preservation, the
   * field reads as `boolean | undefined` and the lift cannot fire.
   */
  arbprec?: Ar;
}

/**
 * Identity wrapper around a `ToolDefinition` that exists purely so that
 * TypeScript can infer the `I`, `O`, and `Fl` type parameters from the
 * inline `schema` and `flags` arguments at the call site. Authors write
 *
 *     export const def = defineTool({
 *       name: "mod-pow", version: "0.2.0",
 *       schema: { input: S.record({...}), output: S.kind("integer") },
 *       flags: { verbose: F.bool("emit per-step trace") },
 *       fn: (input, flags) => /* flags.verbose: boolean *\/ ...
 *     });
 *
 * Pure data: this function performs no IO. The companion `runTool` is
 * the IO-bound dispatcher; the split (ADR-0010) is what lets the
 * registry import `def` directly to read metadata in-process and lets
 * tests call `def.fn(input, flags)` without spawning a subprocess.
 */
export function defineTool<
  I extends Value,
  O extends Value,
  const Fl extends FlagSchema = EmptyFlags,
  // `Ar` carries the `arbprec` literal through the returned
  // definition's type so `FlagsArgOf` (bead `0y27`) can lift
  // `precision?: bigint` into the typed-barrel flag surface for
  // arbprec tools. A tool author writing `arbprec: true` inline gets
  // `Ar = true` baked into the def's type.
  //
  // The `const` modifier here is *defensive*, not strictly load-
  // bearing: with `Ar extends boolean`, regular inference already
  // narrows the value `true` to the literal `true` in inference
  // context, because TS picks the narrowest type satisfying the
  // constraint. `const` is kept for consistency with the `const Fl`
  // sibling above and as belt-and-suspenders for any future unusual
  // call patterns. The default tracks the interface default
  // (`boolean`, not the narrow `false`) so an omitted `arbprec`
  // resolves to a returned type compatible with non-Ar-parameterised
  // call sites.
  const Ar extends boolean = boolean,
>(def: ToolDefinition<I, O, Fl, Ar>): ToolDefinition<I, O, Fl, Ar> {
  return def;
}

// -----------------------------------------------------------------------------
// Standard flags — owned by the runner, merged with the tool's at parse time
// -----------------------------------------------------------------------------
//
// ADR-0011: the runner declares the seven standard flags as a
// `FlagSchema` once. Tools never redeclare them; a name collision
// between a tool's flags and the standard set is caught at runTool
// entry. This is the *only* place where flag-name uniqueness across
// the workbench is checked.
//
// `provenance-of` is the only value-flag in the standard set; the
// rest are switches.

const STANDARD_FLAGS = {
  help:           F.bool("show this help"),
  version:        F.bool("emit {name, version}"),
  schema:         F.bool("emit input/output schema (encodeSchema'd Values)"),
  examples:       F.bool("emit list of examples"),
  invariants:     F.bool("emit list of invariants"),
  test:           F.bool("run this tool's property tests in-process (if any)"),
  "provenance-of":         F.str("emit derivation tree for value-hash"),
  "platform-fingerprint":  F.bool("emit running {arch, os, runtime} fingerprint + hash (ADR-0015)"),
} as const satisfies FlagSchema;

type StdFlags = FlagsOf<typeof STANDARD_FLAGS>;

// -----------------------------------------------------------------------------
// Injectable IO
// -----------------------------------------------------------------------------
//
// `runTool` defaults to the real process bindings (argv, stdin, stdout,
// stderr, exit, env). Passing a `RunIO` overrides any subset of those —
// useful for tests, in-process composition, and any future surface that
// wants to run the dispatcher without owning the parent process.
//
// `exit` returns `never` because the production binding terminates the
// process. The test binding throws a typed `ExitSignal` that callers
// catch; either way, no code after `io.exit(...)` runs.

export interface RunIO {
  argv?: string[];
  stdin?: () => Promise<string>;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  exit?: (code: number) => never;
  env?: Record<string, string | undefined>;
}

interface ResolvedIO {
  argv: string[];
  stdin: () => Promise<string>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number) => never;
  env: Record<string, string | undefined>;
}

/**
 * Thrown by the test-side `exit` binding so that `runTool` halts cleanly
 * when invoked in-process. The production binding (process.exit) does
 * not throw; this class is only observed when callers supply their own
 * `io.exit`.
 */
export class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`runTool exit ${code}`);
    this.name = "ExitSignal";
  }
}

function resolveIO(io: RunIO | undefined): ResolvedIO {
  return {
    argv: io?.argv ?? process.argv.slice(2),
    stdin: io?.stdin ?? readStdin,
    stdout: io?.stdout ?? ((c: string) => { process.stdout.write(c); }),
    stderr: io?.stderr ?? ((c: string) => { process.stderr.write(c); }),
    exit: io?.exit ?? ((code: number) => process.exit(code)),
    env: io?.env ?? (process.env as Record<string, string | undefined>),
  };
}

// -----------------------------------------------------------------------------
// Stdin (default binding)
// -----------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  // Bun exposes `Bun.stdin.text()` which is faster than the iterator path.
  // Fall back to the Node iterator under plain `node`.
  const g = globalThis as unknown as { Bun?: { stdin: { text(): Promise<string> } } };
  if (typeof g.Bun !== "undefined") return g.Bun.stdin.text();
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

// -----------------------------------------------------------------------------
// Help text
// -----------------------------------------------------------------------------

function helpText<I extends Value, O extends Value, Fl extends FlagSchema>(
  def: ToolDefinition<I, O, Fl>,
  toolFlags: FlagSchema,
): string {
  const lines: string[] = [];
  lines.push(`${def.name} ${def.version}`);
  lines.push("");
  lines.push("Reads a JSON value from stdin and writes a JSON value to stdout.");
  lines.push("");
  lines.push("Standard flags:");
  for (const l of renderFlagsHelp(STANDARD_FLAGS)) lines.push(l);
  lines.push("  -h                                 alias for --help");
  if (Object.keys(toolFlags).length > 0) {
    lines.push("");
    lines.push("Tool flags:");
    for (const l of renderFlagsHelp(toolFlags)) lines.push(l);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Examples-conform-to-schema check (load-time)
// -----------------------------------------------------------------------------
//
// ADR-0004: `examples[i].input` and `examples[i].output` must conform to
// the declared schema. Catching this at tool-load time turns drift into
// an immediate, named failure rather than a goldens-mismatch hours
// later.
//
// Cost: linear in the example payload, capped by the example count
// (typically 10–30). Well under the 100ms cold-start budget.

function checkExamplesAgainstSchema<I extends Value, O extends Value, Fl extends FlagSchema>(
  def: ToolDefinition<I, O, Fl>,
): void {
  for (let i = 0; i < def.examples.length; i++) {
    const e = def.examples[i]!;
    const inputCheck = validate(e.input, def.schema.input);
    if (!inputCheck.ok) {
      throw new Error(
        `${def.name}: example #${i + 1} ('${e.description}') input does not conform to schema.input ` +
        `(at $.${inputCheck.failure.path.join(".") || "<root>"}): ${inputCheck.failure.message}`
      );
    }
    if (e.output !== undefined) {
      const outputCheck = validate(e.output, def.schema.output);
      if (!outputCheck.ok) {
        throw new Error(
          `${def.name}: example #${i + 1} ('${e.description}') output does not conform to schema.output ` +
          `(at $.${outputCheck.failure.path.join(".") || "<root>"}): ${outputCheck.failure.message}`
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Standard / tool flag merge + collision check
// -----------------------------------------------------------------------------

// ADR-0020: arbprec-tier tools inherit a standard --precision flag.
// Decimal digits, default 50, soft cap 100_000 (a tool may tighten the
// cap by declaring its own `precision` slot — but the cannot rename or
// retype it).
export const ARBPREC_PRECISION_FLAG = F.int(
  "decimal digits of precision for the output (ADR-0020)",
  { min: 1n, max: 100_000n, default: 50n },
);

/**
 * Merge a tool's declared `flags` with the runner's standard-flag table,
 * additively folding in any tier-conditional standard flags (today:
 * `precision` for `arbprec: true` tools, ADR-0020). The result is the
 * single source of truth for "which flags are admissible on this tool's
 * CLI surface" and is exported so the in-process surface
 * (`@workbench/compose`) validates against the same shape — keeping the
 * byte-identical contract from ADR-0012 honest at both call sites.
 *
 * Tools may *override* the `precision` slot when `arbprec: true` (to
 * tighten the cap) but cannot rename or retype it. Other standard-flag
 * names are reserved — a tool that declares `version` / `help` / etc.
 * fails fast at load time.
 */
export function mergedFlags(
  toolFlags: FlagSchema,
  arbprec: boolean,
): FlagSchema {
  const out: FlagSchema = { ...STANDARD_FLAGS };
  if (arbprec) {
    out["precision"] = ARBPREC_PRECISION_FLAG;
  }
  for (const [k, spec] of Object.entries(toolFlags)) {
    if (k in out) {
      // Permit a tool to override only the `precision` slot for arbprec
      // tools (so a tool can tighten the cap), but only with another
      // F.int spec. Other standard flags are reserved.
      if (k === "precision" && arbprec) {
        out[k] = spec;
        continue;
      }
      throw new Error(
        `tool declares flag --${k} which collides with a standard flag; ` +
        `standard flags reserved: ${Object.keys(out).join(", ")}`,
      );
    }
    out[k] = spec;
  }
  return out;
}

/**
 * The names of every flag the runner contributes to the merged schema
 * for a tool with the given tier annotation. Used by both the runner
 * (to derive `toolFlagsTyped` after argv parsing) and `@workbench/compose`
 * (to derive the explicit-flag map from a partial flags object).
 *
 * For `arbprec: true` tools, `precision` is included — even though it
 * is added by the runner rather than declared by the tool, the tool's
 * `fn` reads it from `flags.precision` exactly as it would a declared
 * flag, and the provenance record's `flags` field captures it.
 */
export function toolFacingFlagNames(
  toolFlags: FlagSchema,
  arbprec: boolean,
): string[] {
  const names = new Set<string>(Object.keys(toolFlags));
  if (arbprec) names.add("precision");
  return [...names];
}

/**
 * The flag schema as the tool's `fn` sees it: declared flags plus any
 * tier-additive standard flags the runner contributes (today:
 * `precision` for `arbprec: true` tools, ADR-0020). Standard flags
 * like `--help` / `--version` / `--schema` are *not* included — those
 * are CLI-control flags the runner intercepts before the tool's `fn`
 * runs and have no in-process equivalent.
 *
 * `@workbench/compose::runWorkbench` validates a caller's
 * `partialFlags` against this schema (rather than `def.flags` directly)
 * so that `wb.hypergeometricPfq(input, { precision: 50n })` succeeds —
 * the typed barrel's call site sees the same merged surface that the
 * subprocess CLI does. This is the load-bearing single-source-of-
 * -truth that closes the lc1 / rn2 wiring gap.
 */
export function toolFacingFlags(
  toolFlags: FlagSchema,
  arbprec: boolean,
): FlagSchema {
  if (!arbprec) return toolFlags;
  const out: FlagSchema = { ...toolFlags };
  // A tool may have already declared a tightened precision slot; in
  // that case the explicit declaration wins (matching `mergedFlags`'s
  // override semantics).
  if (!("precision" in out)) {
    out["precision"] = ARBPREC_PRECISION_FLAG;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Public API: runTool
// -----------------------------------------------------------------------------

export async function runTool<I extends Value, O extends Value, Fl extends FlagSchema>(
  def: ToolDefinition<I, O, Fl>,
  io?: RunIO,
): Promise<void> {
  const r = resolveIO(io);
  const writeOut = (v: Value): void => { r.stdout(canonicalize(v)); };
  const toolFlags = (def.flags ?? ({} as FlagSchema)) as FlagSchema;

  try {
    // Collision check runs inside the try block so a tool that
    // declares a colliding flag name surfaces as a normal-shaped
    // ToolError on stderr + exit 1, not as an unhandled exception.
    const merged = mergedFlags(toolFlags, def.arbprec === true);
    // Examples-conform-to-schema is a load-time invariant. Run it once on
    // every entry into runTool — most invocations are cheap (validation
    // on small examples), and we want the failure surfaced early on the
    // metadata paths too (--examples, --schema), not just in the work
    // case. Skipping is opt-in for genuinely-pathological surfaces.
    if (r.env["WB_SKIP_SCHEMA_CHECK"] !== "1") {
      checkExamplesAgainstSchema(def);
    }

    // ADR-0011: parse argv against the merged FlagSchema. Strict
    // declared arity, no heuristics. Unknown flags and unexpected
    // positionals reject here.
    let parsed;
    try {
      parsed = parseFlagsFromArgv(r.argv, merged);
    } catch (e) {
      if (e instanceof FlagParseError) {
        const opts: { suggestion?: string; detail?: unknown } = { detail: { reason: "flag-parse" } };
        if (e.suggestion !== undefined) opts.suggestion = e.suggestion;
        throw new ToolError(`${def.name}: ${e.message}`, opts);
      }
      throw e;
    }
    if (parsed.positional.length > 0) {
      throw new ToolError(
        `${def.name}: unexpected positional argument(s): ${parsed.positional.map((p) => JSON.stringify(p)).join(", ")}`,
        {
          suggestion:
            "this tool reads its input from stdin and configures itself via flags; " +
            "no positional arguments are accepted",
        },
      );
    }
    const stdFlags = parsed.flags as unknown as StdFlags;
    // Tool flags are derived by lifting every tool-facing slot out of
    // the parsed merged-flag object. For tier-additive flags
    // contributed by the runner (today: `precision` for `arbprec: true`
    // tools, ADR-0020), the runner injects them into the typed `flags`
    // the tool's `fn` reads even though the tool itself does not
    // declare them — the merged-schema convention is the single source
    // of truth. The runtime cost is one shallow object copy per
    // invocation.
    const toolFlagsTyped: Record<string, unknown> = {};
    for (const k of toolFacingFlagNames(toolFlags, def.arbprec === true)) {
      toolFlagsTyped[k] = (parsed.flags as Record<string, unknown>)[k];
    }

    if (stdFlags.help) {
      r.stdout(helpText(def, toolFlags));
      r.stdout("\n");
      return;
    }
    if (stdFlags.version) {
      writeOut(record({ name: str(def.name), version: str(def.version) }));
      return;
    }
    if (stdFlags.schema) {
      writeOut(
        record({
          input: encodeSchema(def.schema.input),
          output: encodeSchema(def.schema.output),
        })
      );
      return;
    }
    if (stdFlags.examples) {
      writeOut(list(def.examples.map(exampleToValue)));
      return;
    }
    if (stdFlags.invariants) {
      writeOut(list(def.invariants.map(invariantToValue)));
      return;
    }
    if (stdFlags["provenance-of"] !== undefined) {
      const h = stdFlags["provenance-of"];
      const store = r.env["CAS_STORE"] ?? defaultStore();
      const rec = await readProvenance(store, h);
      if (rec === null) {
        writeOut(tagged("provenance/not-found", str(h)));
        return;
      }
      writeOut(provenanceToValue(rec));
      return;
    }
    if (stdFlags["platform-fingerprint"]) {
      // ADR-0015 discoverability surface: emit the running platform's
      // fingerprint *without* doing any work. An agent's planner can read
      // a stored provenance record's `platform` field and compare to this
      // before deciding whether the cached output is admissible.
      r.stdout(platformFingerprintBytes());
      return;
    }
    if (stdFlags.test) {
      const t = def.test;
      if (t === undefined) {
        r.stderr(`${def.name}: no --test suite registered\n`);
        r.exit(2);
        return;  // unreachable in production (process.exit), reachable when io.exit throws or no-ops
      }
      await t();
      r.stdout(`${def.name} ${def.version}: tests passed\n`);
      return;
    }

    // ── Work case ────────────────────────────────────────────────────────
    //
    // The five-step contract (validate input → fn → validate output →
    // canonicalise → write provenance) lives in `executeToolDef`
    // (ADR-0012). The runner's job here is the IO half: read stdin,
    // parse to a Value, hand off, write the canonical bytes to stdout,
    // and surface a provenance-write failure as a stderr warning. The
    // contract semantics are owned by `executeToolDef` so the
    // subprocess and in-process surfaces produce byte-identical results
    // for the same `(tool, version, input, explicit-flags)`.
    //
    // The recorded `flags` are only those tool flags explicitly set on
    // argv — `parsed.explicit` carries them in their raw string form,
    // which is exactly what `executeToolDef` writes into the
    // provenance record.

    const stdinText = await r.stdin();
    if (stdinText.trim().length === 0) {
      throw new ToolError(`${def.name}: no input on stdin`, {
        suggestion: "pipe a canonical JSON value to stdin or use --help",
      });
    }
    const input = parse(stdinText);
    const explicitToolFlags: Record<string, string> = {};
    for (const k of toolFacingFlagNames(toolFlags, def.arbprec === true)) {
      if (parsed.explicit[k] !== undefined) explicitToolFlags[k] = parsed.explicit[k]!;
    }
    const result = await executeToolDef(
      def,
      input as I,
      toolFlagsTyped as FlagsOf<Fl>,
      { explicitFlags: explicitToolFlags, env: r.env },
    );
    r.stdout(result.outputBytes);
    if (result.provenanceError !== null) {
      r.stderr(`${def.name}: warning — provenance write failed: ${result.provenanceError.message}\n`);
    }
  } catch (e) {
    if (e instanceof ExitSignal) throw e;  // already an explicit exit; propagate
    const msg = e instanceof Error ? e.message : String(e);
    r.stderr(`${def.name}: ${msg}\n`);
    r.exit(1);
  }
}

// -----------------------------------------------------------------------------
// Helper for callers that want to decode a `--schema` result
// -----------------------------------------------------------------------------
//
// Re-exported here for ergonomic discovery: tools that read another
// tool's schema (registry-list, registry-search) want `decodeSchema`
// in scope without reaching into the protocol package directly.

export { decodeSchema };
