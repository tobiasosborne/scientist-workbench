// =============================================================================
// bench/hypergeometric-pfq/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Bridges the bench's language-neutral JSON wire format
//
//   in:  { "a": [{re: "<dec>", im: "<dec>"}, ...],
//          "b": [{re: "<dec>", im: "<dec>"}, ...],
//          "z":  {re: "<dec>", im: "<dec>"},
//          "precision": <int> }
//   out: success ⇒ { "value": {re: "<dec>", im: "<dec>"},
//                     "achieved_precision": <int>,
//                     "method": "<string>",
//                     "n_terms": <int>,
//                     "working_precision": <int>,
//                     "warnings": [<string>, ...] }
//        refusal ⇒ { "kind": "tagged",
//                     "tag": "hypergeometric-pfq/<class>",
//                     "payload": {...} }
//        tool-err ⇒ { "kind": "tool_error", "name": "...", "message": "..." }
//
// to the canonical Value protocol that `tools/hypergeometric-pfq/` speaks.
// Reads one JSON object on stdin, encodes the input via `BigComplex`
// helpers, calls the tool in-process via `@workbench/compose` (with the
// `--precision` flag set to the case's `precision` field), decodes the
// output Value back to the wire format above, writes one JSON object
// on stdout.
//
// In-process invocation matches the precedent set by `bench/linalg-qr`:
// the bench runs ~50 cases per invocation, the tool itself spawns no
// subprocess, and the contract holds byte-identically across both
// surfaces (ADR-0012).
//
// The candidate's *value* is preserved as a decimal-string {re, im}
// pair at the achieved precision via `bigfloat::toString`. The verifier
// re-parses that to mpmath at 80 dps for the relative-error check
// against the pinned truth.
//
// Boundary behaviour: thrown `ToolError`s become `{kind: "tool_error", ...}`
// markers so the verifier sees a uniform JSON output stream. Tagged
// boundaries (`hypergeometric-pfq/non-convergent`,
// `hypergeometric-pfq/parameter-pole`) round-trip as `{kind: "tagged", ...}`
// blobs.

import { readFileSync } from "node:fs";
import { executeToolDef } from "@workbench/contract";
import { def as hypergeometricPfqDef } from "../../tools/hypergeometric-pfq/tool.js";
import {
  bigcomplexToValue,
  cfromStrings,
  toString as bfToString,
  valueToBigComplex,
  decimalToBinaryPrecision,
  type BigComplex,
} from "@workbench/bigfloat";
import {
  list,
  record,
  type Value,
} from "@workbench/protocol";

interface RawComplex {
  re: string;
  im: string;
}

interface RawInput {
  a: readonly RawComplex[];
  b: readonly RawComplex[];
  z: RawComplex;
  precision: number;
}

// ─── raw JSON → canonical Value (input encoding) ─────────────────────────────

/**
 * Convert a "p/q" rational string (or a plain decimal / integer) into
 * the decimal form `bigfloat::fromString` accepts. The bench corpus
 * uses rationals where the parameters are exact (matching Wolfram's
 * exact-input convention `Hypergeometric2F1[1, 1, 2, 1/3]`); the
 * bigfloat substrate exposes `divFromString` for that, but doesn't
 * have one — we expand p/q at sufficient working precision and pass
 * the resulting decimal string. The expansion precision is set 16
 * bits beyond the request to absorb the dec→bin round-off.
 */
function _expandRational(s: string, workBits: number): string {
  const trimmed = s.trim();
  if (!trimmed.includes("/")) return trimmed;
  const [pStr, qStr] = trimmed.split("/");
  const p = BigInt(pStr!);
  const q = BigInt(qStr!);
  if (q === 0n) throw new Error(`rational ${s} has zero denominator`);
  // Decimal-digit count to safely round-trip workBits bits.
  // ceil(workBits * log10(2)) + safety margin.
  const dps = Math.ceil(workBits * 0.30103) + 16;
  // Long-division: produce `dps` digits past the decimal point.
  const sign = (p < 0n) !== (q < 0n) ? "-" : "";
  let pa = p < 0n ? -p : p;
  const qa = q < 0n ? -q : q;
  const intPart = pa / qa;
  let rem = pa - intPart * qa;
  let frac = "";
  for (let i = 0; i < dps; i++) {
    rem *= 10n;
    const digit = rem / qa;
    rem = rem - digit * qa;
    frac += digit.toString();
    if (rem === 0n) break;
  }
  return sign + intPart.toString() + (frac ? "." + frac : "");
}

function encodeComplex(c: RawComplex, workBits: number): Value {
  const re = _expandRational(c.re, workBits);
  const im = _expandRational(c.im, workBits);
  const bc: BigComplex = cfromStrings(re, im, workBits);
  return bigcomplexToValue(bc);
}

function encodeInput(raw: RawInput): { input: Value; precision: number } {
  // The tool itself stores BigComplex parameters at whatever precision
  // their mantissas already carry; we feed them at `decimalToBinaryPrecision
  // (precision) + 64` working bits so the tool's own working-precision
  // bumps for cancellation aren't capped by the input's bit budget.
  const workBits = decimalToBinaryPrecision(raw.precision) + 64;
  const aValues = raw.a.map((c) => encodeComplex(c, workBits));
  const bValues = raw.b.map((c) => encodeComplex(c, workBits));
  const zValue = encodeComplex(raw.z, workBits);
  return {
    input: record({
      a: list(aValues),
      b: list(bValues),
      z: zValue,
    }),
    precision: raw.precision,
  };
}

// ─── canonical Value → raw JSON (output decoding) ────────────────────────────

function decodeStringList(v: Value): string[] {
  if (v.kind !== "list") throw new Error(`expected list, got kind=${v.kind}`);
  return v.items.map((it) => {
    if (it.kind !== "string") {
      throw new Error(`expected string, got kind=${it.kind}`);
    }
    return it.value;
  });
}

function decodeInteger(v: Value): number {
  if (v.kind !== "integer") {
    throw new Error(`expected integer, got kind=${v.kind}`);
  }
  return Number(v.value);
}

function decodeString(v: Value): string {
  if (v.kind !== "string") {
    throw new Error(`expected string, got kind=${v.kind}`);
  }
  return v.value;
}

function decodeBigComplexAsStrings(v: Value, dps: number): RawComplex {
  // Decode the tagged BigComplex back to a {re, im} decimal-string pair
  // formatted at `dps` decimal places. We pad the formatting precision
  // by 5 so the verifier sees a value with ≥dps significant digits to
  // compare against the pinned truth.
  const bc = valueToBigComplex(v);
  return {
    re: bfToString(bc.re, dps + 5),
    im: bfToString(bc.im, dps + 5),
  };
}

function decodePayloadAny(v: Value): unknown {
  switch (v.kind) {
    case "string":
      return v.value;
    case "integer":
      return Number(v.value);
    case "boolean":
      return v.value;
    case "list":
      return v.items.map(decodePayloadAny);
    case "record": {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) {
        out[k] = decodePayloadAny(val as Value);
      }
      return out;
    }
    case "tagged":
      return { kind: "tagged", tag: v.tag, payload: decodePayloadAny(v.payload) };
    default:
      return null;
  }
}

function decodeOutput(v: Value, requestedPrecision: number): Record<string, unknown> {
  if (v.kind === "tagged") {
    return {
      kind: "tagged",
      tag: v.tag,
      payload: decodePayloadAny(v.payload),
    };
  }
  if (v.kind !== "record") {
    throw new Error(`expected record or tagged, got kind=${v.kind}`);
  }
  const f = v.fields;
  return {
    value: decodeBigComplexAsStrings(f["value"]!, requestedPrecision),
    achieved_precision: decodeInteger(f["achieved_precision"]!),
    method: decodeString(f["method"]!),
    n_terms: decodeInteger(f["n_terms"]!),
    working_precision: decodeInteger(f["working_precision"]!),
    warnings: decodeStringList(f["warnings"]!),
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(0, "utf8")) as RawInput;

  let prepared: { input: Value; precision: number };
  try {
    prepared = encodeInput(raw);
  } catch (err) {
    const e = err as Error;
    process.stdout.write(
      JSON.stringify({
        kind: "tool_error",
        name: "InputEncodeFailed",
        message: e.message,
      }) + "\n",
    );
    return;
  }

  let out: Value;
  try {
    // We invoke the tool via `executeToolDef` directly rather than
    // going through `loadWorkbench()` + `wb.run(...)`. Reason: ADR-0020's
    // `--precision` flag is merged into the tool's flag schema *only*
    // by the subprocess runner (`runTool` in `@workbench/contract`).
    // The in-process surface (`@workbench/compose`'s `runWorkbench`)
    // validates partial flags against `def.flags` directly — for an
    // arbprec tool that declares no flags of its own, passing
    // `{ precision: 50n }` is rejected as an unknown flag. This is a
    // genuine gap in compose; filed as a follow-up bead. Until that
    // lands, the bench bypasses the wrapper and calls `executeToolDef`,
    // whose work-case helper (ADR-0012) is what both surfaces fan out
    // to anyway. The contract — schema validation in/out, provenance
    // write — is byte-identical.
    const result = await executeToolDef(
      hypergeometricPfqDef,
      prepared.input,
      { precision: BigInt(prepared.precision) } as never,
    );
    out = result.output;
  } catch (err) {
    const e = err as Error & { name?: string };
    process.stdout.write(
      JSON.stringify({
        kind: "tool_error",
        name: e.name ?? "Error",
        message: e.message ?? String(e),
      }) + "\n",
    );
    return;
  }

  const decoded = decodeOutput(out, prepared.precision);
  process.stdout.write(JSON.stringify(decoded) + "\n");
}

await main();
