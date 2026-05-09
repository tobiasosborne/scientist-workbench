// =============================================================================
// meijer-g — top-level dispatcher for the Meijer G-function (Layer 7)
// =============================================================================
//
// Intent
// ------
// Single integrated evaluator for `G^{m,n}_{p,q}(an, ap, bm, bq | z)`.
// Composes the four algorithmic layers of `@workbench/meijer-core`
// (symbolic dispatch, Slater residue summation, Mellin–Barnes
// contour quadrature, Braaksma asymptotic) into a cost-ascending
// dispatch ladder with honest refusal. ADR-0027 is the design pin.
//
// This is the **climax of the seven-layer Meijer G stack** for the
// scientist-workbench: every input lands in one of three honest
// shapes — `record { kind: "symbolic", … }`, `record { kind:
// "numerical", … }`, or `tagged "meijer-g/<class>"`. No bespoke
// per-layer envelope handling at the call site; a TS expert reading
// the consumer code switches once on `kind` and gets the rest of
// the fields typed.
//
// When to use this vs the layer-only siblings
// -------------------------------------------
// * `tools/meijer-g` (this tool) — the user-facing entry point.
//   Cost-ascending dispatch; first applicable method wins. Use this
//   for production evaluation, agent-driven research, and the
//   `bench/meijer-g/` battery (`hv0.11`).
// * `tools/meijer-g-symbolic-only` — diagnostic / regression. Pins
//   the symbolic layer's coverage independently of the numerical
//   stack.
// * `tools/meijer-g-slater-only` — diagnostic / regression. Forces
//   the Slater residue path even on inputs the dispatcher would
//   route elsewhere.
// * `tools/meijer-g-asymptotic-only` — diagnostic / regression. Same
//   for the Braaksma asymptotic path.
// * (No `meijer-g-contour-only` wire tool ships at v0.1; the contour
//   layer is exercised through the dispatcher's `--force-method=contour`
//   flag and through `packages/meijer-core/test/contour.test.ts`.)
//
// Input shape
// -----------
// `record {
//    an: list<bigcomplex>,
//    ap: list<bigcomplex>,
//    bm: list<bigcomplex>,
//    bq: list<bigcomplex>,
//    z:  bigcomplex,
//    request_mode?: string  // "auto" | "symbolic-required" | "numerical-required"
//  }`
//
// All four parameter lists are BigComplex Values (encoded via
// `bigcomplexSchema` from `@workbench/bigfloat`); `z` is a single
// BigComplex. The four-tuple split mirrors `tools/meijer-g-slater-only`
// and `tools/meijer-g-asymptotic-only` for parity.
//
// For the symbolic layer to fire, the dispatcher needs a Value-AST
// view of the parameters as well. Integer-real BigComplex values
// (e.g. `cfromInts(0n, 0n, …)` for the parameter `0`) get an
// `int(n)` Value-AST view so Bateman §5.6 / DLMF §16.18 rules can
// pattern-match. Non-integer / complex parameters round-trip
// through the BigComplex codec; the symbolic layer's pattern matcher
// politely returns `no-known-reduction` for those, and the
// numerical lanes handle them.
//
// Output shape (ADR-0003 / ADR-0027 §4)
// -------------------------------------
// One of:
//
//   record {
//     kind: "symbolic",
//     expr: <AST in the special-function vocabulary>,
//     rule: string,                    // stable rule id
//     source: string,                  // human-readable citation
//     note: string,                    // free-form RHS in conventional notation
//     method: "symbolic-dispatch"
//   }
//
//   record {
//     kind: "numerical",
//     value: bigcomplex,
//     achieved_precision: integer,
//     method: string,                  // "slater-series-1|2|mellin-barnes|braaksma-algebraic"
//     working_precision: integer,
//     warnings: list<string>,
//     diagnostics: record { ... }      // method-specific (n_terms, n_evals, etc.)
//   }
//
//   tagged "meijer-g/<class>" record { reason: string, ruled_out_methods: list<record> }
//
// Refusal classes (the `<class>` suffix):
//   * "out-of-region"            — every applicable layer refused.
//   * "non-finite-input"         — z or a parameter contains NaN/Inf.
//   * "degenerate-shape"         — m + n = 0.
//   * "symbolic-required-no-match" — request_mode = symbolic-required and no rule matched.
//   * "forced-method-refused"    — --force-method=<lane> and that lane refused.
//   * "input-error"              — malformed precision / out-of-range flag.
//
// Determinism
// -----------
// `arbprec: true`. Inherits the standard `--precision=<int>` flag
// (default 50 dps; ADR-0020). Same `(input, precision, explicit-flags)`
// ⇒ same output bytes, on every platform, forever.
//
// CLI flags
// ---------
// In addition to the standard flags (`--schema --examples --invariants
// --version --help --provenance-of <hash> --test --precision=<int>`):
//
//   --force-method=<lane>    Force a specific lane (symbolic|slater|contour|
//                            asymptotic). Bypasses the cost-ascending dispatch.
//                            Useful for the method-agreement self-test.
//   --schwarz-check          Run the Schwarz-reflection self-test on numerical
//                            success: compute G(z̄), assert it equals
//                            conj(G(z)) within precision. Off by default.
//
// Pre-existing `lc1` runner gap
// -----------------------------
// The runner's standard `--precision=N` flag is parsed but not threaded
// into arbprec tools' `flags` parameter. CLI invocation always runs at
// `precision = 50`; in-process callers via `@workbench/compose` pass
// flags directly and are unaffected. This dispatcher inherits the
// gap until `lc1` lands. Tests run in-process where possible; goldens
// omit per-case `flags` to match the actual CLI behaviour.

import {
  bool,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type ListValue,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, F, runTool } from "@workbench/contract";
import {
  type BigComplex,
  bigcomplexSchema,
  bigcomplexToValue,
  cfromInts,
  toFloat64,
  valueToBigComplex,
} from "@workbench/bigfloat";
import {
  type ForceMethod,
  type MeijerGDispatchOptions,
  type RequestMode,
  meijergDispatch,
} from "@workbench/meijer-core";
import type { MeijerGSymbolicParams } from "@workbench/meijer-core";

const NAME = "meijer-g";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// Input: the four parameter lists + z + an optional request_mode.
// Output: declared as `S.any()` to keep TS-inference tractable —
// the union has three top-level shapes (symbolic record, numerical
// record, tagged) and several narrower tagged refusal shapes;
// goldens enforce the actual shape per case (precedent: `tools/solve`
// and `tools/poly-roots`; ADR-0017's tradeoff).

const inputSchema = S.record(
  {
    an: S.list(bigcomplexSchema),
    ap: S.list(bigcomplexSchema),
    bm: S.list(bigcomplexSchema),
    bq: S.list(bigcomplexSchema),
    z: bigcomplexSchema,
    request_mode: S.kind("string"),
  },
  { optional: ["request_mode"] as const },
);

const outputSchema = S.any();

// -----------------------------------------------------------------------------
// Body helpers
// -----------------------------------------------------------------------------

function decodeBigComplexList(rec: RecordValue, key: string): BigComplex[] {
  const v = rec.fields[key];
  if (v === undefined || v.kind !== "list") {
    throw new ToolError(`${NAME}: input.${key} must be a list of bigcomplex`);
  }
  return (v as ListValue).items.map((it) => valueToBigComplex(it));
}

/**
 * Produce a Value-AST view of a BigComplex parameter so the symbolic
 * dispatcher can pattern-match against it. The dispatch rule table
 * is written for `integer` / `rational` / `symbol` / `expression`
 * leaves (ADR-0025); a BigComplex carries a `.re` BigFloat and `.im`
 * BigFloat. We surface integer-real BigComplex values as `int(n)` so
 * Bateman §5.6's `b = 0` / `b = 1/2` rule patterns can match them.
 * Non-integer / complex BigComplexes round-trip through the
 * BigComplex codec; the symbolic dispatcher politely returns
 * `no-known-reduction` for those, and the numerical lanes handle
 * them.
 *
 * For `z`, the rule table's `z` slot is pass-through (it threads `z`
 * verbatim into the rewrite, ADR-0025 §3), so any Value shape is
 * fine; we use the same logic for symmetry.
 */
function bigcomplexToSymbolicValue(bc: BigComplex): Value {
  // Recognise integer-real: im = 0 and re is exactly representable
  // as a BigInt at workingBits precision.
  const reF = toFloat64(bc.re).value;
  const imF = toFloat64(bc.im).value;
  if (
    imF === 0 &&
    Number.isFinite(reF) &&
    Number.isInteger(reF) &&
    Math.abs(reF) < 1e15
  ) {
    // Defensive: re-build as exact BigComplex(int, 0) and compare;
    // if not byte-equal, fall back to the BigComplex round-trip.
    const reInt = BigInt(reF);
    const reCheck = cfromInts(reInt, 0n, bc.re.precision);
    if (
      reCheck.re.mantissa === bc.re.mantissa &&
      reCheck.re.exponent === bc.re.exponent &&
      reCheck.im.mantissa === bc.im.mantissa
    ) {
      return int(reInt);
    }
  }
  // Otherwise return the BigComplex Value via the canonical codec.
  return bigcomplexToValue(bc);
}

function buildSymbolicParams(numerical: {
  an: BigComplex[];
  ap: BigComplex[];
  bm: BigComplex[];
  bq: BigComplex[];
}): MeijerGSymbolicParams {
  return {
    an: numerical.an.map(bigcomplexToSymbolicValue),
    ap: numerical.ap.map(bigcomplexToSymbolicValue),
    bm: numerical.bm.map(bigcomplexToSymbolicValue),
    bq: numerical.bq.map(bigcomplexToSymbolicValue),
  };
}

function decodeRequestMode(rec: RecordValue): RequestMode {
  const v = rec.fields["request_mode"];
  if (v === undefined) return "auto";
  if (v.kind !== "string") {
    throw new ToolError(`${NAME}: input.request_mode must be a string`);
  }
  switch (v.value) {
    case "auto":
    case "symbolic-required":
    case "numerical-required":
      return v.value as RequestMode;
    default:
      throw new ToolError(
        `${NAME}: input.request_mode = '${v.value}' is not one of ` +
          `'auto' | 'symbolic-required' | 'numerical-required'`,
      );
  }
}

function decodeForceMethod(s: string | undefined): ForceMethod | undefined {
  if (s === undefined || s === "") return undefined;
  switch (s) {
    case "symbolic":
    case "slater":
    case "contour":
    case "asymptotic":
      return s;
    default:
      throw new ToolError(
        `${NAME}: --force-method='${s}' is not one of ` +
          `'symbolic' | 'slater' | 'contour' | 'asymptotic'`,
      );
  }
}

function encodeDiagnostics(
  d: Readonly<Record<string, number | string | boolean>>,
): Value {
  const fields: Record<string, Value> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "number") fields[k] = int(BigInt(v));
    else if (typeof v === "string") fields[k] = str(v);
    else fields[k] = bool(v);
  }
  return record(fields);
}

function encodeRuledOutMethods(
  ruled: readonly { method: string; status: string; reason: string }[],
): Value {
  return list(
    ruled.map((r) =>
      record({
        method: str(r.method),
        status: str(r.status),
        reason: str(r.reason),
      }),
    ),
  );
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  flags: {
    "force-method": F.str(
      "force a specific dispatch lane (symbolic|slater|contour|asymptotic); bypasses cost-ascending dispatch",
    ),
    "schwarz-check": F.bool(
      "run the Schwarz-reflection self-test on numerical success",
    ),
  },
  examples: [
    {
      description:
        "G^{1,0}_{0,1}(_; 0 | 2) ⇒ symbolic e^{-z} via Bateman §5.6 / DLMF §16.18",
      input: record({
        an: list([] as Value[]),
        ap: list([] as Value[]),
        bm: list([bigcomplexToValue(cfromInts(0n, 0n, 256))]),
        bq: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(2n, 0n, 256)),
      }),
    },
    {
      description:
        "G^{0,1}_{1,0}(1; _ | 100) — Slater path success at default precision",
      input: record({
        an: list([bigcomplexToValue(cfromInts(1n, 0n, 256))]),
        ap: list([] as Value[]),
        bm: list([] as Value[]),
        bq: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(100n, 0n, 256)),
      }),
    },
    {
      description:
        "Forced asymptotic on |z|=0 ⇒ tagged forced-method-refused",
      input: record({
        an: list([bigcomplexToValue(cfromInts(1n, 0n, 256))]),
        ap: list([] as Value[]),
        bm: list([bigcomplexToValue(cfromInts(0n, 0n, 256))]),
        bq: list([bigcomplexToValue(cfromInts(1n, 0n, 256))]),
        z: bigcomplexToValue(cfromInts(0n, 0n, 256)),
      }),
      flags: { "force-method": "asymptotic" },
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement:
        "same input bytes + same precision ⇒ same output bytes (arbprec; bit-identical cross-platform)",
      machine_checkable: true,
    },
    {
      name: "cost-ascending dispatch order",
      statement:
        "When a symbolic rule matches, the dispatcher returns kind='symbolic' rather than running the numerical lanes; symbolic match has priority on every input where it applies (ADR-0027 §1).",
      machine_checkable: true,
    },
    {
      name: "honest refusal envelope",
      statement:
        "Inputs that fall through every applicable lane return tagged 'meijer-g/out-of-region' with a `ruled_out_methods` list naming each refused lane (ADR-0027 §9).",
      machine_checkable: true,
    },
    {
      name: "principal-branch convention pinned",
      statement:
        "Every numerical lane uses `arg z ∈ (−π, π]` (DLMF §16.17.1). Schwarz-reflection self-test (`--schwarz-check`) verifies G(z̄) = conj(G(z)) for non-cut z with real parameters (ADR-0027 §6).",
      machine_checkable: true,
    },
    {
      name: "method-agreement (force-method invariant)",
      statement:
        "On inputs where multiple lanes apply, forcing each via `--force-method=<lane>` produces values that agree to user precision (less a 5-digit margin); covered in `tool.test.ts`.",
      machine_checkable: true,
    },
    {
      name: "two-shape success discrimination",
      statement:
        "Successful outputs are exactly one of `record { kind: 'symbolic', expr, rule, source, note, method }` or `record { kind: 'numerical', value, achieved_precision, method, working_precision, warnings, diagnostics }` (ADR-0027 §4).",
      machine_checkable: true,
    },
  ],
  fn: (input, flags): Value => {
    const inputRec = input as RecordValue;
    const an = decodeBigComplexList(inputRec, "an");
    const ap = decodeBigComplexList(inputRec, "ap");
    const bm = decodeBigComplexList(inputRec, "bm");
    const bq = decodeBigComplexList(inputRec, "bq");
    const z = valueToBigComplex(inputRec.fields.z!);
    const requestMode = decodeRequestMode(inputRec);

    const symbolicParams = buildSymbolicParams({ an, ap, bm, bq });
    const zSymbolic = bigcomplexToSymbolicValue(z);

    // Decode flags. The `precision` flag is injected by the runner
    // for arbprec tools but not surfaced via FlagsOf<...> (lc1
    // pre-existing gap); cast through `unknown`.
    const f = flags as unknown as {
      precision?: bigint;
      "force-method"?: string;
      "schwarz-check"?: boolean;
    };
    const precision = Number(f.precision ?? 50n);
    if (!Number.isInteger(precision) || precision < 1) {
      throw new ToolError(
        `${NAME}: precision must be a positive integer; got ${precision}`,
      );
    }
    const forceMethod = decodeForceMethod(f["force-method"]);
    const schwarzCheck = f["schwarz-check"] === true;

    const opts: MeijerGDispatchOptions =
      forceMethod !== undefined
        ? { requestMode, schwarzCheck, forceMethod }
        : { requestMode, schwarzCheck };

    const result = meijergDispatch(
      symbolicParams,
      { an, ap, bm, bq },
      zSymbolic,
      z,
      precision,
      opts,
    );

    if (result.kind === "symbolic") {
      return record({
        kind: str("symbolic"),
        expr: result.expr,
        rule: str(result.ruleId),
        source: str(result.ruleSource),
        note: str(result.note),
        method: str(result.method),
      });
    }
    if (result.kind === "numerical") {
      const wp = result.diagnostics["workingPrecision"];
      return record({
        kind: str("numerical"),
        value: bigcomplexToValue(result.value),
        achieved_precision: int(BigInt(result.achievedPrecision)),
        method: str(result.method),
        working_precision: int(BigInt(typeof wp === "number" ? wp : 0)),
        warnings: list(result.warnings.map((w) => str(w))),
        diagnostics: encodeDiagnostics(result.diagnostics),
      });
    }
    // Refusal.
    return tagged(
      `${NAME}/${result.class}`,
      record({
        reason: str(result.reason),
        ruled_out_methods: encodeRuledOutMethods(result.ruledOutMethods),
      }),
    );
  },
  test: () => {
    // Probe 1: symbolic match wins.
    // G^{1,0}_{0,1}(_; 0 | 2) = e^{-2}.
    const symInput = record({
      an: list([] as Value[]),
      ap: list([] as Value[]),
      bm: list([bigcomplexToValue(cfromInts(0n, 0n, 256))]),
      bq: list([] as Value[]),
      z: bigcomplexToValue(cfromInts(2n, 0n, 256)),
    });
    const symOut = def.fn(symInput as never, {} as never) as Value;
    if (symOut.kind !== "record" || symOut.fields.kind?.kind !== "string") {
      throw new Error(`${NAME} --test: expected record output for symbolic case`);
    }
    if (symOut.fields.kind.value !== "symbolic") {
      throw new Error(
        `${NAME} --test: expected kind='symbolic' for G^{1,0}_{0,1}(_; 0 | 2), got '${symOut.fields.kind.value}'`,
      );
    }

    // Probe 2: numerical success (force-numerical short-circuit).
    // We use request_mode = "numerical-required" so the symbolic
    // layer is bypassed; the same input that passed Probe 1
    // (G^{1,0}_{0,1}(_;0|2)) is run through the numerical lane.
    const numInput = record({
      an: list([] as Value[]),
      ap: list([] as Value[]),
      bm: list([bigcomplexToValue(cfromInts(0n, 0n, 256))]),
      bq: list([] as Value[]),
      z: bigcomplexToValue(cfromInts(2n, 0n, 256)),
      request_mode: str("numerical-required"),
    });
    const numOut = def.fn(numInput as never, {} as never) as Value;
    if (numOut.kind !== "record" || numOut.fields.kind?.kind !== "string") {
      throw new Error(`${NAME} --test: expected record output for numerical case`);
    }
    if (numOut.fields.kind.value !== "numerical") {
      throw new Error(
        `${NAME} --test: expected kind='numerical' for G^{0,1}_{1,0}(1; _ | 100), got '${numOut.fields.kind.value}'`,
      );
    }

    // Probe 3: refusal envelope. Force a forced-method refusal.
    const refInput = record({
      an: list([bigcomplexToValue(cfromInts(1n, 0n, 256))]),
      ap: list([] as Value[]),
      bm: list([bigcomplexToValue(cfromInts(0n, 0n, 256))]),
      bq: list([bigcomplexToValue(cfromInts(1n, 0n, 256))]),
      z: bigcomplexToValue(cfromInts(0n, 0n, 256)), // |z|=0 ⇒ asymptotic refuses
    });
    const refFlags = { "force-method": "asymptotic", precision: 30n };
    const refOut = def.fn(refInput as never, refFlags as never) as Value;
    if (refOut.kind !== "tagged" || !refOut.tag.startsWith(`${NAME}/`)) {
      throw new Error(
        `${NAME} --test: expected tagged refusal for force-method=asymptotic on |z|=0; got kind=${refOut.kind}`,
      );
    }

    console.log(
      `${NAME} --test: 3 dispatch lanes covered (symbolic, numerical, refused); full coverage in tool.test.ts.`,
    );
  },
});

if (import.meta.main) void runTool(def);
