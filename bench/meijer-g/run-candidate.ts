// =============================================================================
// bench/meijer-g/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Bridges the bench's language-neutral JSON wire format
//
//   in:  { "an": [{re, im}, ...], "ap": [...], "bm": [...], "bq": [...],
//          "z": {re, im}, "precision": <int> }
//
//   out: success ⇒ value-shape (one of the dispatcher's three honest
//                  output kinds: symbolic / numerical / tagged refusal)
//
// to the canonical Value protocol that `tools/meijer-g/` speaks.
// Reads one JSON object on stdin, encodes the input via `BigComplex`
// helpers, calls the tool in-process via `executeToolDef` with the
// `--precision` flag set to the case's `precision` field, decodes the
// output Value back to a wire-format JSON.
//
// Invocation surface choice: in-process via `executeToolDef` directly
// (NOT `@workbench/compose`'s `runWorkbench`).  Reason: `lc1`/`rn2`
// pre-existing gap — `runWorkbench` validates partial flags against
// `def.flags` directly; for an arbprec tool the `--precision` flag is
// merged in by the *subprocess* runner only, and passing
// `{ precision: 50n }` to `runWorkbench` fails as an unknown flag.
// `executeToolDef` is the contract surface both fan out to (ADR-0012)
// — schema validation in/out, provenance write — so the bench's
// results are admissible byte-identically.  Same workaround as
// `bench/hypergeometric-pfq/run-candidate.ts`.
//
// Output shape per dispatcher (`tools/meijer-g/tool.ts` ⇒
// `meijergDispatch` from `@workbench/meijer-core`):
//
//   record { kind: "symbolic", expr, rule, source, note, method }
//     ⇒ wire form: { "kind": "symbolic", "rule", "source", "note",
//                    "method", "expr": <opaque expr blob> }
//
//   record { kind: "numerical", value, achieved_precision, method,
//            working_precision, warnings, diagnostics }
//     ⇒ wire form: { "kind": "numerical",
//                    "value": {re, im},
//                    "achieved_precision", "method",
//                    "working_precision", "warnings", "diagnostics" }
//
//   tagged "meijer-g/<class>" record { reason, ruled_out_methods }
//     ⇒ wire form: { "kind": "tagged",
//                    "tag": "meijer-g/<class>",
//                    "payload": { reason, ruled_out_methods } }
//
// Boundary behaviour: thrown `ToolError`s become `{kind:"tool_error", ...}`.

import { readFileSync } from "node:fs";
import { executeToolDef } from "@workbench/contract";
import { def as meijerGDef } from "../../tools/meijer-g/tool.js";
import {
  bigcomplexToValue,
  cfromStrings,
  toString as bfToString,
  valueToBigComplex,
  decimalToBinaryPrecision,
  type BigComplex,
} from "@workbench/bigfloat";
import { list, record, str, type Value } from "@workbench/protocol";

interface RawComplex {
  re: string;
  im: string;
}

interface RawInput {
  an: readonly RawComplex[];
  ap: readonly RawComplex[];
  bm: readonly RawComplex[];
  bq: readonly RawComplex[];
  z: RawComplex;
  precision: number;
  request_mode?: string;
  force_method?: string;
}

// ─── raw JSON → canonical Value (input encoding) ─────────────────────────────

/**
 * Expand a "p/q" rational string into a decimal string that
 * `bigfloat::fromString` accepts at sufficient working precision.  The
 * bigfloat substrate has no `divFromString`; we long-divide here at
 * `workBits + safety` decimal digits so the round-trip is faithful.
 */
function _expandRational(s: string, workBits: number): string {
  const trimmed = s.trim();
  if (!trimmed.includes("/")) return trimmed;
  const [pStr, qStr] = trimmed.split("/");
  const p = BigInt(pStr!);
  const q = BigInt(qStr!);
  if (q === 0n) throw new Error(`rational ${s} has zero denominator`);
  const dps = Math.ceil(workBits * 0.30103) + 16;
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
  // The dispatcher's lanes need ~ +64 bits of headroom over the
  // requested precision so internal Slater / contour / asymptotic
  // bumps aren't capped by the input's bit budget.
  const workBits = decimalToBinaryPrecision(raw.precision) + 64;
  const anValues = raw.an.map((c) => encodeComplex(c, workBits));
  const apValues = raw.ap.map((c) => encodeComplex(c, workBits));
  const bmValues = raw.bm.map((c) => encodeComplex(c, workBits));
  const bqValues = raw.bq.map((c) => encodeComplex(c, workBits));
  const zValue = encodeComplex(raw.z, workBits);

  const fields: Record<string, Value> = {
    an: list(anValues),
    ap: list(apValues),
    bm: list(bmValues),
    bq: list(bqValues),
    z: zValue,
  };
  if (raw.request_mode !== undefined) {
    fields["request_mode"] = str(raw.request_mode);
  }
  return {
    input: record(fields),
    precision: raw.precision,
  };
}

// ─── canonical Value → raw JSON (output decoding) ────────────────────────────

/** Decode any Value back to a JSON-y blob.  Used for the symbolic
 *  `expr` field (we don't need to pretty-print the AST; the verifier
 *  checks structural shape and the `rule` ID). */
function decodePayloadAny(v: Value): unknown {
  switch (v.kind) {
    case "string":
      return v.value;
    case "integer":
      return v.value.toString();
    case "rational":
      return { num: v.num.toString(), den: v.den.toString() };
    case "boolean":
      return v.value;
    case "float64":
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
    case "expression":
      return { kind: "expression", head: v.head, args: v.args.map(decodePayloadAny) };
    case "symbol":
      return { kind: "symbol", name: v.name };
    default:
      return null;
  }
}

function decodeBigComplexAsStrings(v: Value, dps: number): RawComplex {
  const bc = valueToBigComplex(v);
  return {
    re: bfToString(bc.re, dps + 5),
    im: bfToString(bc.im, dps + 5),
  };
}

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
  const kindField = f["kind"];
  if (!kindField || kindField.kind !== "string") {
    throw new Error("output record missing 'kind' string field");
  }

  if (kindField.value === "symbolic") {
    return {
      kind: "symbolic",
      rule: decodeString(f["rule"]!),
      source: decodeString(f["source"]!),
      note: decodeString(f["note"]!),
      method: decodeString(f["method"]!),
      expr: decodePayloadAny(f["expr"]!),
    };
  }

  if (kindField.value === "numerical") {
    return {
      kind: "numerical",
      value: decodeBigComplexAsStrings(f["value"]!, requestedPrecision),
      achieved_precision: decodeInteger(f["achieved_precision"]!),
      method: decodeString(f["method"]!),
      working_precision: decodeInteger(f["working_precision"]!),
      warnings: decodeStringList(f["warnings"]!),
      diagnostics: decodePayloadAny(f["diagnostics"]!),
    };
  }

  throw new Error(
    `unexpected record output kind='${kindField.value}'; ` +
      `expected 'symbolic' | 'numerical'`,
  );
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

  const flags: Record<string, unknown> = {
    precision: BigInt(prepared.precision),
  };
  if (raw.force_method !== undefined) {
    flags["force-method"] = raw.force_method;
  }

  const t0 = performance.now();
  let out: Value;
  try {
    const result = await executeToolDef(
      meijerGDef,
      prepared.input,
      flags as never,
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
  const elapsedMs = performance.now() - t0;

  const decoded = decodeOutput(out, prepared.precision);
  decoded["elapsed_ms"] = elapsedMs;
  process.stdout.write(JSON.stringify(decoded) + "\n");
}

await main();
