// =============================================================================
// alg-num-arith — field arithmetic over named algebraic numbers (Root[poly, k])
// =============================================================================
//
// Intent
// ------
// Take one or two `Root[poly, k]` values (ADR-0018) and apply a chosen
// algebraic-number operation, returning a canonical `Root` value
// representing the result. Equality is an additional op returning a
// `boolean`.
//
// Why this tool exists
// --------------------
// `Root[poly, k]` is a *value-protocol primitive* (an `expression` head)
// for algebraic numbers — every TS-expert agent that wants `√2 + √3` to
// compose with `cas-diff`, `integrate-1d`, the Solve dispatcher, etc.
// reaches for the same canonical encoding. The substrate library
// `@workbench/alg-num` v0.1 ships the field operations on the in-memory
// `Root` type — `algNumAdd`, `algNumMul`, `algNumInv`, etc. (worklog
// 062). This tool is the *wire envelope*: a 7-artefact tool exposing
// those operations on the wire-encoded value-protocol form, so an agent
// composing tools can do `wb.algNumArith({a, b}, {op: "add"})` exactly
// the way it does `wb.modPow({base, exp, mod})`.
//
// The companion bench `bench/alg-num-arith/` (bead `iay`) cross-validates
// this tool against SymPy `qqbar` and exercises five tiers (elementary,
// nested, high-degree, conjugate-distinguishing, equality stress).
//
// Input shape
// -----------
// `record { a: <Root expression>, b?: <Root expression> }`. The `a`
// field is required for every op; `b` is required for binary ops
// (`add`, `sub`, `mul`, `div`, `eq`) and rejected for unary ops
// (`neg`, `inv`). Inputs are wire-encoded `Root[poly, k]` expressions
// per ADR-0018 — the parser (`valueToRoot` in `@workbench/alg-num`)
// silently canonicalises non-canonical input.
//
// Output shape
// ------------
// Three categories, mutually exclusive:
//
//   * **Arithmetic happy path** (op ∈ {add, sub, mul, div, neg, inv}) —
//     the result `Root[poly, k]` value (canonical-form bytes).
//   * **Equality happy path** (op == eq) — `boolean { value: bool }`.
//   * **Boundary refusal** — `tagged "alg-num-arith/<class>"` with
//     `record { detail: string }` payload. Two classes:
//       - `alg-num-arith/inv-of-zero`  — `op = inv` with `a` representing
//         zero (the multiplicative inverse is undefined).
//       - `alg-num-arith/div-by-zero`  — `op = div` with `b` representing
//         zero. Same condition; different surface.
//
// `ToolError` is reserved for malformed input: the input record missing
// `a`; `a` or `b` not a `Root[poly, k]` expression; `b` missing on a
// binary op; `b` present on a unary op; `op` flag missing or
// out-of-range.
//
// Algorithm
// ---------
// Wire-decode `a` (and `b` when present) via
// `@workbench/alg-num.valueToRoot`. Dispatch on `op` to the
// corresponding substrate function (`algNumAdd`, `algNumMul`, etc.).
// Wire-encode the result via `rootToValue`, or directly return a
// boolean for `eq`. Catch the documented "0 is not invertible"
// exception from `algNumInv` and translate to the boundary tag.
//
// Determinism: default symbolic tier (ADR-0015). The substrate
// canonicalises Root[] values to byte-identical bytes regardless of
// internal interval-refinement state. Same input bytes ⇒ same output
// bytes ⇒ bit-identical cross-platform forever.

import {
  bool,
  record,
  S,
  str,
  tagged,
  ToolError,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, F, runTool } from "@workbench/contract";
import {
  algNumAdd,
  algNumDiv,
  algNumInv,
  algNumMul,
  algNumNeg,
  algNumSub,
  rootCanonicalEq,
  rootToValue,
  valueToRoot,
} from "@workbench/alg-num";

const NAME = "alg-num-arith";
const VERSION = "0.1.0";

const TAG_INV_OF_ZERO = "alg-num-arith/inv-of-zero";
const TAG_DIV_BY_ZERO = "alg-num-arith/div-by-zero";

const OPS = ["add", "sub", "mul", "div", "neg", "inv", "eq"] as const;
type Op = (typeof OPS)[number];

const UNARY_OPS = new Set<Op>(["neg", "inv"]);

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

// Input is a record whose `a` and optional `b` fields are `Root[]`-
// headed expressions. Declaring just `S.any()` for the field types
// keeps TS-inference simple; the `valueToRoot` decode catches non-Root
// input with a precise error.
const inputSchema = S.record(
  {
    a: S.any(),
    b: S.any(),
  },
  { optional: ["b"] as const },
);

// Output is a value-protocol union (Root expression | boolean |
// tagged-refusal). `S.any()` matches the cas-diff / poly-roots
// pattern of declaring loose output schema and enforcing shape via
// goldens.
const outputSchema = S.any();

// -----------------------------------------------------------------------------
// Body
// -----------------------------------------------------------------------------

function decodeInput(input: Value): {
  aValue: Value;
  bValue: Value | undefined;
} {
  if (input.kind !== "record") {
    throw new ToolError("input must be a record", {
      detail: `got kind=${input.kind}`,
    });
  }
  const aValue = input.fields["a"] as Value | undefined;
  if (!aValue) {
    throw new ToolError("input.a is required", {
      detail: "every alg-num-arith op needs an `a` field; got none",
    });
  }
  const bValue = input.fields["b"] as Value | undefined;
  return { aValue, bValue };
}

function refuse(tag: string, detail: string): Value {
  return tagged(tag, record({ detail: str(detail) }));
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  flags: {
    op: F.enum(OPS, "arithmetic operation to apply"),
  },
  examples: [
    {
      description: "√2 + √3 ⟹ Root[x⁴ − 10x² + 1, k=3]",
      input: record({
        a: rootExample([-2n, 0n, 1n], 1n),  // Root[x²−2, k=1] = +√2
        b: rootExample([-3n, 0n, 1n], 1n),  // Root[x²−3, k=1] = +√3
      }),
      flags: { op: "add" },
      output: rootExample([1n, 0n, -10n, 0n, 1n], 3n),  // Root[x⁴−10x²+1, k=3]
    },
    {
      description: "√2 · √3 ⟹ Root[x² − 6, k=1] = +√6",
      input: record({
        a: rootExample([-2n, 0n, 1n], 1n),
        b: rootExample([-3n, 0n, 1n], 1n),
      }),
      flags: { op: "mul" },
      output: rootExample([-6n, 0n, 1n], 1n),
    },
    {
      description: "−(+√2) ⟹ Root[x² − 2, k=0] = −√2",
      input: record({
        a: rootExample([-2n, 0n, 1n], 1n),
      }),
      flags: { op: "neg" },
      output: rootExample([-2n, 0n, 1n], 0n),
    },
    {
      description: "1 / √2 ⟹ Root[2x² − 1, k=1] (non-monic minpoly is canonical)",
      input: record({
        a: rootExample([-2n, 0n, 1n], 1n),
      }),
      flags: { op: "inv" },
      output: rootExample([-1n, 0n, 2n], 1n),
    },
    {
      description: "+√2 == +√2 ⟹ true",
      input: record({
        a: rootExample([-2n, 0n, 1n], 1n),
        b: rootExample([-2n, 0n, 1n], 1n),
      }),
      flags: { op: "eq" },
      output: bool(true),
    },
    {
      description: "+√2 == −√2 ⟹ false (same minpoly, different k)",
      input: record({
        a: rootExample([-2n, 0n, 1n], 1n),
        b: rootExample([-2n, 0n, 1n], 0n),
      }),
      flags: { op: "eq" },
      output: bool(false),
    },
    {
      description: "inv(0) ⟹ tagged inv-of-zero",
      input: record({
        a: rootExample([0n, 1n], 0n),  // Root[x, k=0] = 0
      }),
      flags: { op: "inv" },
      output: refuse(TAG_INV_OF_ZERO, "alg-num-arith: inv(0) is undefined"),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement:
        "same input bytes + same op flag → same output bytes (symbolic tier; bit-identical cross-platform)",
      machine_checkable: true,
    },
    {
      name: "field-closure",
      statement:
        "for op ∈ {add, sub, mul, div, neg, inv}, output is a canonical Root[poly, k] value (or a tagged refusal for div/inv by zero); never `tagged out-of-scope`",
      machine_checkable: true,
    },
    {
      name: "additive-inverse",
      statement: "add(a, neg(a)) is canonically equal to Root[x, 0] (i.e. the rational 0)",
      machine_checkable: true,
    },
    {
      name: "multiplicative-inverse",
      statement: "mul(a, inv(a)) is canonically equal to Root[x − 1, 0] (i.e. the rational 1) for a ≠ 0",
      machine_checkable: true,
    },
    {
      name: "eq-reflexive",
      statement: "eq(a, a) returns boolean true for every Root[] value a",
      machine_checkable: true,
    },
  ],
  fn: (input, flags): Value => {
    const op = flags.op as Op;
    const { aValue, bValue } = decodeInput(input as Value);

    // Arity check.
    const isUnary = UNARY_OPS.has(op);
    if (isUnary && bValue !== undefined) {
      throw new ToolError(
        `unary op '${op}' must not be supplied a 'b' input`,
        { detail: "remove the 'b' field, or pick a binary op" },
      );
    }
    if (!isUnary && bValue === undefined) {
      throw new ToolError(
        `binary op '${op}' requires a 'b' input`,
        { detail: "add a Root[poly, k] expression in field 'b'" },
      );
    }

    // Wire-decode `a` (and `b` when binary).  `valueToRoot` throws on
    // non-Root or malformed Root inputs; we surface those as ToolError
    // (the malformed-input category per ADR-0003) rather than a
    // boundary tag — they're producer bugs, not honest scope limits.
    let aRoot, bRoot;
    try {
      aRoot = valueToRoot(aValue);
    } catch (e) {
      throw new ToolError(
        `failed to parse input 'a' as Root[poly, k]`,
        { detail: e instanceof Error ? e.message : String(e) },
      );
    }
    if (!isUnary) {
      try {
        bRoot = valueToRoot(bValue!);
      } catch (e) {
        throw new ToolError(
          `failed to parse input 'b' as Root[poly, k]`,
          { detail: e instanceof Error ? e.message : String(e) },
        );
      }
    }

    // Dispatch on op.
    switch (op) {
      case "neg":
        return rootToValue(algNumNeg(aRoot));
      case "inv":
        try {
          return rootToValue(algNumInv(aRoot));
        } catch (e) {
          if (isZeroError(e)) {
            return refuse(TAG_INV_OF_ZERO, "alg-num-arith: inv(0) is undefined");
          }
          throw e;
        }
      case "add":
        return rootToValue(algNumAdd(aRoot, bRoot!));
      case "sub":
        return rootToValue(algNumSub(aRoot, bRoot!));
      case "mul":
        return rootToValue(algNumMul(aRoot, bRoot!));
      case "div":
        try {
          return rootToValue(algNumDiv(aRoot, bRoot!));
        } catch (e) {
          if (isZeroError(e)) {
            return refuse(TAG_DIV_BY_ZERO, "alg-num-arith: division by zero");
          }
          throw e;
        }
      case "eq":
        return bool(rootCanonicalEq(aRoot, bRoot!));
    }
  },
  test: () => {
    // Probe 1 — √2 + √3 = Root[x⁴ − 10x² + 1, 3].
    const sqrt2 = rootExample([-2n, 0n, 1n], 1n);
    const sqrt3 = rootExample([-3n, 0n, 1n], 1n);
    const addOut = def.fn(
      record({ a: sqrt2, b: sqrt3 }) as never,
      { op: "add" } as never,
    ) as Value;
    if (addOut.kind !== "expression" || addOut.head !== "Root") {
      throw new Error("alg-num-arith --test: expected Root[] for √2 + √3");
    }
    const sumK = (addOut.args[1] as { kind: "integer"; value: string }).value;
    if (sumK !== "3") {
      throw new Error(`alg-num-arith --test: expected k=3 for √2 + √3, got k=${sumK}`);
    }

    // Probe 2 — neg(+√2) = −√2 (k flips 1 → 0 within same minpoly).
    const negOut = def.fn(record({ a: sqrt2 }) as never, { op: "neg" } as never) as Value;
    if (negOut.kind !== "expression" || negOut.head !== "Root") {
      throw new Error("alg-num-arith --test: expected Root[] for neg(√2)");
    }

    // Probe 3 — eq(+√2, +√2) = true; eq(+√2, −√2) = false.
    const eqTrue = def.fn(record({ a: sqrt2, b: sqrt2 }) as never, { op: "eq" } as never) as Value;
    if (eqTrue.kind !== "boolean" || !eqTrue.value) {
      throw new Error("alg-num-arith --test: expected eq(√2,√2) = true");
    }
    const sqrt2neg = rootExample([-2n, 0n, 1n], 0n);
    const eqFalse = def.fn(record({ a: sqrt2, b: sqrt2neg }) as never, { op: "eq" } as never) as Value;
    if (eqFalse.kind !== "boolean" || eqFalse.value) {
      throw new Error("alg-num-arith --test: expected eq(+√2,−√2) = false");
    }

    // Probe 4 — inv(0) refuses with inv-of-zero.
    const zero = rootExample([0n, 1n], 0n);
    const invZero = def.fn(record({ a: zero }) as never, { op: "inv" } as never) as Value;
    if (invZero.kind !== "tagged" || invZero.tag !== TAG_INV_OF_ZERO) {
      throw new Error(`alg-num-arith --test: expected ${TAG_INV_OF_ZERO} for inv(0)`);
    }

    console.log(
      `alg-num-arith --test: add (√2+√3=Root[x⁴−10x²+1, k=3]), neg, eq (true+false), inv(0)-refusal probes green; full coverage in goldens.`,
    );
  },
});

// -----------------------------------------------------------------------------
// Helpers — used in examples and the `--test` hook to construct Root[]
// expression Values without going through valueToRoot's full
// canonicalisation overhead. Builds the wire shape directly per
// ADR-0018 §"Examples": expression { head: "Root", args: [Polynomial,
// integer] }.
// -----------------------------------------------------------------------------

function rootExample(coefs: bigint[], k: bigint): Value {
  return {
    kind: "expression",
    head: "Root",
    args: [
      {
        kind: "expression",
        head: "Polynomial",
        args: coefs.map((c) => ({ kind: "integer", value: c.toString() }) as Value),
      },
      { kind: "integer", value: k.toString() },
    ],
  };
}

// -----------------------------------------------------------------------------
// Internal — exception-shape detection for the alg-num substrate's
// "zero is not invertible" path. The substrate throws `Error` with a
// message that begins with "algNumInv:" (see
// `packages/alg-num/src/arithmetic.ts`). Pattern-matching on the error
// message rather than introducing a typed exception class keeps the
// substrate's public surface narrow.
// -----------------------------------------------------------------------------

function isZeroError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /algNum(Inv|Div):.*zero/i.test(e.message);
}

if (import.meta.main) void runTool(def);
