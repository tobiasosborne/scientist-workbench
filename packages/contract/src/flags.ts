// =============================================================================
// flags — typed CLI flag declarations
// =============================================================================
//
// ADR-0011. A `FlagSchema` is a record of `FlagSpec`s declared on a
// `ToolDefinition`. The runner merges the tool's declared flags with a
// fixed standard-flag table, parses argv against the merged schema,
// type-coerces each value, and hands the tool's `fn` a typed `flags`
// object whose property types are inferred from the spec.
//
// Why this lives outside the protocol package
// -------------------------------------------
// Schemas (`@workbench/protocol/S.*`) describe Values inside the
// canonical JSON value protocol. Flags describe argv strings. Both
// are typed declarations, but they touch different parts of the
// system: schemas govern stdin/stdout, flags govern argv. Conflating
// them entangles two type systems with no shared vocabulary. The
// `F.*` constructors live next to `runTool` because that is the only
// consumer; a tool author imports both `S` and `F` from
// `@workbench/protocol` and `@workbench/contract` respectively, and
// the file reads cleanly.
//
// Why short names (F.bool / F.str / F.int / F.enum)
// -------------------------------------------------
// They compose at the call site. Compare:
//
//     flags: {
//       shots: F.int("number of samples", { default: 100n }),
//       mode:  F.enum(["exact", "structural"], "comparison strictness", { default: "exact" }),
//     }
//
// against the longer alternative; the short forms also match the
// protocol's `int(0n) / str("x") / bool(true)` value constructors,
// which is the existing house style.

// -----------------------------------------------------------------------------
// FlagSpec — the four kinds
// -----------------------------------------------------------------------------
//
// `default` is the type-narrowing parameter: a flag declared with a
// default has a non-undefined typed value at the call site; a flag
// declared without one is `T | undefined`. Bool flags are special —
// absent always means `false`, never `undefined`, because a switch
// has only two states.

export interface BoolFlag {
  readonly kind: "bool";
  readonly doc: string;
}

export interface StrFlag<D extends string | undefined = string | undefined> {
  readonly kind: "str";
  readonly doc: string;
  readonly default?: D;
}

export interface IntFlag<D extends bigint | undefined = bigint | undefined> {
  readonly kind: "int";
  readonly doc: string;
  readonly default?: D;
  readonly min?: bigint;
  readonly max?: bigint;
}

export interface EnumFlag<
  V extends readonly string[] = readonly string[],
  D extends V[number] | undefined = V[number] | undefined,
> {
  readonly kind: "enum";
  readonly doc: string;
  readonly values: V;
  readonly default?: D;
}

export type FlagSpec = BoolFlag | StrFlag | IntFlag | EnumFlag;

export type FlagSchema = Record<string, FlagSpec>;

// -----------------------------------------------------------------------------
// Constructors — the F.* namespace
// -----------------------------------------------------------------------------

export const F = {
  bool: (doc: string): BoolFlag => ({ kind: "bool", doc }),

  str: <const D extends string | undefined = undefined>(
    doc: string,
    opts?: { default?: D },
  ): StrFlag<D> => {
    const out: StrFlag<D> = { kind: "str", doc };
    if (opts?.default !== undefined) (out as { default?: D }).default = opts.default;
    return out;
  },

  int: <const D extends bigint | undefined = undefined>(
    doc: string,
    opts?: { default?: D; min?: bigint; max?: bigint },
  ): IntFlag<D> => {
    const out: IntFlag<D> = { kind: "int", doc };
    if (opts?.default !== undefined) (out as { default?: D }).default = opts.default;
    if (opts?.min !== undefined) (out as { min?: bigint }).min = opts.min;
    if (opts?.max !== undefined) (out as { max?: bigint }).max = opts.max;
    return out;
  },

  enum: <const V extends readonly string[], const D extends V[number] | undefined = undefined>(
    values: V,
    doc: string,
    opts?: { default?: D },
  ): EnumFlag<V, D> => {
    const out: EnumFlag<V, D> = { kind: "enum", doc, values };
    if (opts?.default !== undefined) (out as { default?: D }).default = opts.default;
    return out;
  },
} as const;

// -----------------------------------------------------------------------------
// Type-level inference: FlagsOf<F>
// -----------------------------------------------------------------------------
//
// A flag with a default has a concrete typed value at the call site.
// A flag without a default is `T | undefined`. Bool is always a
// boolean (never undefined) — absent switches resolve to `false`.

type FlagValueOf<S extends FlagSpec> =
  S extends BoolFlag ? boolean :
  S extends IntFlag<infer D>
    ? (D extends bigint ? bigint : bigint | undefined) :
  S extends StrFlag<infer D>
    ? (D extends string ? string : string | undefined) :
  S extends EnumFlag<infer V, infer D>
    ? (D extends V[number] ? V[number] : V[number] | undefined) :
  never;

export type FlagsOf<F extends FlagSchema> = { [K in keyof F]: FlagValueOf<F[K]> };

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------
//
// Strict declared arity (ADR-0011). The argv parser knows up front
// which flags take values (str/int/enum) and which are switches
// (bool), so there is no greedy `next-arg-doesn't-start-with-dash`
// heuristic. A bare `--mode` requires a value; a `--equal` switch
// followed by `1` leaves `1` as a positional. Unknown flags reject
// loudly with a suggestion listing the valid set. Unexpected
// positionals reject the same way.
//
// The result of parsing is two paired views:
//   - `flags`: the typed object handed to fn.
//   - `explicit`: a `Record<string, string>` of *only* the flags that
//      were explicitly present on argv (in their string form). The
//      runner uses this for the provenance record so a tool's
//      defaults do not bloat the recorded bytes — only what the
//      caller actually said is recorded. (See ADR-0011 "Provenance"
//      note for the rationale.)
//
// `parseFlagsFromArgv` is the single public entry point. The runner
// passes the merged (standard + tool) FlagSchema; the result's
// `flags` is then split: standard-flag fields drive the runner's
// dispatch (--help, --version, …), and tool-flag fields are handed to
// `fn`.

export interface ParsedFlags<F extends FlagSchema> {
  flags: FlagsOf<F>;
  explicit: Record<string, string>;
  positional: string[];
}

export class FlagParseError extends Error {
  constructor(
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "FlagParseError";
  }
}

const FLAG_NAME_RE = /^[a-z][a-z0-9-]*$/;

function isFlagToken(s: string): boolean {
  return s.startsWith("--") || s === "-h";
}

function suggestionForUnknown(name: string, declared: FlagSchema): string {
  const valid = Object.keys(declared).sort();
  if (valid.length === 0) return "this tool declares no flags";
  return `valid flags: ${valid.map((v) => `--${v}`).join(", ")}`;
}

function parseIntValue(name: string, raw: string, spec: IntFlag): bigint {
  // ADR-0011 — strip `_` so callers can write `--shots=10_000`. JS's
  // `BigInt(...)` does not natively accept underscore separators.
  const cleaned = raw.replace(/_/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    throw new FlagParseError(
      `flag --${name}: expected an integer, got '${raw}'`,
      "use a base-10 integer; underscores are allowed for readability (e.g. 10_000)",
    );
  }
  let n: bigint;
  try {
    n = BigInt(cleaned);
  } catch {
    throw new FlagParseError(
      `flag --${name}: could not parse '${raw}' as integer`,
    );
  }
  if (spec.min !== undefined && n < spec.min) {
    throw new FlagParseError(
      `flag --${name}: ${n} is below declared minimum ${spec.min}`,
    );
  }
  if (spec.max !== undefined && n > spec.max) {
    throw new FlagParseError(
      `flag --${name}: ${n} is above declared maximum ${spec.max}`,
    );
  }
  return n;
}

function parseEnumValue(name: string, raw: string, spec: EnumFlag): string {
  if (!spec.values.includes(raw)) {
    throw new FlagParseError(
      `flag --${name}: ${JSON.stringify(raw)} is not one of the declared values`,
      `valid values: ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }
  return raw;
}

export function parseFlagsFromArgv<F extends FlagSchema>(
  argv: string[],
  declared: F,
): ParsedFlags<F> {
  // Validate all declared names are well-formed up front.
  for (const k of Object.keys(declared)) {
    if (!FLAG_NAME_RE.test(k)) {
      throw new FlagParseError(
        `internal: declared flag name '${k}' violates [a-z][a-z0-9-]*; ` +
        `flag names must be lowercase, dash-separated`,
      );
    }
  }

  const explicit: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "-h") {
      explicit["help"] = "true";
      continue;
    }
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const stripped = tok.slice(2);
    const eq = stripped.indexOf("=");
    const name = eq >= 0 ? stripped.slice(0, eq) : stripped;
    const inlineValue: string | null = eq >= 0 ? stripped.slice(eq + 1) : null;

    const spec = declared[name];
    if (spec === undefined) {
      throw new FlagParseError(
        `unknown flag --${name}`,
        suggestionForUnknown(name, declared),
      );
    }

    if (spec.kind === "bool") {
      if (inlineValue !== null) {
        throw new FlagParseError(
          `flag --${name} is a boolean switch and does not take a value`,
          `write \`--${name}\` (no =, no following value)`,
        );
      }
      explicit[name] = "true";
      continue;
    }

    // Value-flag: get its value either inline (--flag=v) or as the
    // next argv token (--flag v). Strict arity: the next token is
    // always consumed regardless of whether it looks flag-shaped,
    // because the alternative (peeking and conditionally-consuming)
    // is the very heuristic this ADR retired.
    let raw: string;
    if (inlineValue !== null) {
      raw = inlineValue;
    } else {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new FlagParseError(
          `flag --${name} requires a value`,
          spec.kind === "enum"
            ? `valid values: ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`
            : undefined,
        );
      }
      raw = next;
      i++;
    }
    explicit[name] = raw;
  }

  // Now resolve into the typed object. Walk declared so the output
  // shape matches the schema's keyset, and so missing values get
  // their declared defaults (or undefined, or `false` for bools).
  const flags: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const raw = explicit[name];
    if (raw === undefined) {
      if (spec.kind === "bool") {
        flags[name] = false;
      } else if (spec.default !== undefined) {
        flags[name] = spec.default;
      } else {
        flags[name] = undefined;
      }
      continue;
    }
    switch (spec.kind) {
      case "bool":
        flags[name] = raw === "true";
        break;
      case "str":
        flags[name] = raw;
        break;
      case "int":
        flags[name] = parseIntValue(name, raw, spec);
        break;
      case "enum":
        flags[name] = parseEnumValue(name, raw, spec);
        break;
    }
  }

  return {
    flags: flags as FlagsOf<F>,
    explicit,
    positional,
  };
}

// -----------------------------------------------------------------------------
// Help-text rendering
// -----------------------------------------------------------------------------
//
// One line per flag. Format derived from the spec, doc strings on
// the right. The runner concatenates this with the tool's
// name/version banner.

export function renderFlagsHelp(declared: FlagSchema): string[] {
  const out: string[] = [];
  const names = Object.keys(declared).sort();
  if (names.length === 0) return out;
  // Compute the left column width once so the doc strings align.
  const left: { name: string; tag: string }[] = names.map((n) => {
    const spec = declared[n]!;
    let tag = "";
    if (spec.kind === "int") {
      tag = spec.default !== undefined ? ` <int> (default: ${spec.default})` : ` <int>`;
    } else if (spec.kind === "str") {
      tag = spec.default !== undefined ? ` <str> (default: ${JSON.stringify(spec.default)})` : ` <str>`;
    } else if (spec.kind === "enum") {
      const choices = spec.values.map((v) => JSON.stringify(v)).join("|");
      tag = spec.default !== undefined
        ? ` <${choices}> (default: ${JSON.stringify(spec.default)})`
        : ` <${choices}>`;
    }
    return { name: n, tag };
  });
  const widest = Math.max(...left.map((l) => `--${l.name}${l.tag}`.length));
  for (let i = 0; i < names.length; i++) {
    const n = names[i]!;
    const l = left[i]!;
    const pad = " ".repeat(Math.max(2, widest - `--${n}${l.tag}`.length + 2));
    out.push(`  --${n}${l.tag}${pad}${declared[n]!.doc}`);
  }
  return out;
}
