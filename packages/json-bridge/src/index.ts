// =============================================================================
// @workbench/json-bridge — translate between raw JSON and canonical Value
// =============================================================================
//
// Why this package exists
// -----------------------
// The workbench's value protocol is *strict-canonical* — sorted keys, no
// raw JSON numbers, integers as decimal-strings inside an `IntegerValue`,
// floats as 16 hex chars of IEEE-754 bits, etc. The whole point is
// content addressing and bit-identical determinism.
//
// External JSON-shaped data does not look like that. Benchmark goldens
// (the tstournament corpus that motivated this package), upstream APIs,
// configuration files — all of them encode integers as JSON numbers,
// arrays as JSON arrays, and so on. Every port from the outside world to
// the workbench needs to translate, and every export back needs to
// translate the other direction.
//
// We previously did this by hand (see the prior version of
// `scripts/validate-tournament-ntt.ts`, which was about 30 lines of rote
// `int(BigInt(t.n))`-shaped code). That doesn't scale: every benchmark
// (FFT, LLL, Stoer-Wagner, blossom, …) will need its own adapter, and
// each adapter is the same shape with different field names.
//
// Two operations
// --------------
//
//     jsonToCanonical(json: unknown, hint: Value): Value
//     canonicalToJson(value: Value, opts?: JsonBridgeOptions): unknown
//
// The forward direction is *hint-driven*: raw JSON has multiple plausible
// canonical kinds (a JSON string `"7"` could be an `integer` or a
// `string`; a JSON number `1.5` could be `float64` or `rational`). The
// hint tree resolves the ambiguity by declaring what each position
// should be. Hints are themselves `Value`s, using `kindOf("integer")`
// for leaf annotations and `record({...})` / `list([...])` for
// structure — the same vocabulary as tool schemas (ADR-0002).
//
// The reverse direction is unambiguous on the kind axis but ambiguous on
// the *encoding* axis: an integer can be emitted as a JSON number (safe
// for |v| < 2^53) or a JSON string (lossless for any size). The optional
// `JsonBridgeOptions` chooses the convention. For the tournament case
// every integer goes out as a string — that's `integerEncoding: "string"`.

import {
  asSchemaKind,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  rat,
  record,
  str,
  type Float64Value,
  type IntegerValue,
  type Kind,
  type ListValue,
  type ListValueOf,
  type RecordValue,
  type Value,
} from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Forward: raw JSON → canonical Value, guided by a hint tree
// -----------------------------------------------------------------------------
//
// Hint shapes:
//
//   kindOf("integer")     leaf — parse this JSON node as an integer.
//                         JSON number → BigInt(n); JSON string → BigInt(s).
//   kindOf("rational")    leaf — JSON object {num, den} of strings, or a
//                         JSON string "<num>/<den>", or a decimal-string
//                         "1.25" (interpreted exactly as a fraction).
//   kindOf("float64")     leaf — JSON number → IEEE-754 bits, OR a 16-hex
//                         string interpreted as raw bits.
//   kindOf("string")      leaf — JSON string passes through.
//   kindOf("boolean")     leaf — JSON boolean passes through.
//   kindOf("symbol")      leaf — JSON string becomes the symbol name.
//   list([elementHint])   structural — JSON array, recurse with elementHint
//                         on each item.
//   record({k: hk, ...})  structural — JSON object, recurse field-by-field;
//                         JSON keys not present in the hint are an error
//                         (strict mode); JSON missing a hinted key is also
//                         an error.
//
// We intentionally do *not* default-infer kinds from JSON shape. JSON `7`
// could be an integer or a float64; resolving that without a hint guesses,
// and guessing in a content-addressed system is how you get hash drift.

export class JsonBridgeError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

function pathJoin(parent: string, child: string | number): string {
  if (parent === "$") return `$.${child}`;
  return `${parent}.${child}`;
}

export function jsonToCanonical(json: unknown, hint: Value, path: string = "$"): Value {
  // Schema-kind leaf — resolve by named kind.
  const sk = asSchemaKind(hint);
  if (sk !== null) return jsonLeafToKind(json, sk, path);

  switch (hint.kind) {
    case "list":
      return jsonArrayToList(json, hint, path);
    case "record":
      return jsonObjectToRecord(json, hint, path);
    case "expression":
      // Expressions don't have a natural raw-JSON form. If you need to
      // round-trip them, parse the JSON to a record first, then use
      // expr-parse on the inner string. The bridge intentionally refuses.
      throw new JsonBridgeError(
        "expression hints are not supported by jsonToCanonical; parse the inner string with expr-parse",
        path
      );
    case "tagged":
      // Tagged hints (other than schema/kind, handled above) describe a
      // tagged-value layer at this position. The JSON shape is taken to
      // be the payload; we wrap on the way out.
      return {
        kind: "tagged",
        tag: hint.tag,
        payload: jsonToCanonical(json, hint.payload, path),
      };
    default:
      // Plain sample-value hint at a leaf — we don't try to honour it.
      // Hints should use kindOf for leaves; sample-values are a tool-schema
      // convention, not a bridge convention.
      throw new JsonBridgeError(
        `hint of kind ${hint.kind} at a leaf position; use kindOf("...") for leaf hints`,
        path
      );
  }
}

function jsonArrayToList(json: unknown, hint: ListValue, path: string): ListValue {
  if (!Array.isArray(json)) {
    throw new JsonBridgeError(`expected JSON array, got ${typeof json}`, path);
  }
  if (hint.items.length !== 1) {
    throw new JsonBridgeError(
      `list hint must have exactly one element-hint (got ${hint.items.length})`,
      path
    );
  }
  const elementHint = hint.items[0]!;
  const items = json.map((el, i) => jsonToCanonical(el, elementHint, pathJoin(path, i)));
  return list(items);
}

function jsonObjectToRecord(json: unknown, hint: RecordValue, path: string): RecordValue {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new JsonBridgeError(`expected JSON object, got ${json === null ? "null" : Array.isArray(json) ? "array" : typeof json}`, path);
  }
  const obj = json as Record<string, unknown>;
  const fields: Record<string, Value> = {};
  // Strict: every hinted key must appear in the JSON.
  for (const [k, fieldHint] of Object.entries(hint.fields)) {
    if (!(k in obj)) {
      throw new JsonBridgeError(`missing field '${k}' (hinted but absent)`, path);
    }
    fields[k] = jsonToCanonical(obj[k], fieldHint, pathJoin(path, k));
  }
  // Non-strict on extras: JSON keys not in the hint are silently dropped.
  // A future strict-mode flag could change this. For now we err on the side
  // of robust adapters.
  return record(fields);
}

function jsonLeafToKind(json: unknown, kind: Kind, path: string): Value {
  switch (kind) {
    case "integer":
      if (typeof json === "number") {
        if (!Number.isInteger(json)) throw new JsonBridgeError(`expected integer, got non-integer number ${json}`, path);
        return int(BigInt(json));
      }
      if (typeof json === "string") {
        // BigInt(s) throws on malformed strings; let it bubble.
        try {
          return int(BigInt(json));
        } catch (e) {
          throw new JsonBridgeError(`expected integer-decimal-string, got ${JSON.stringify(json)}: ${(e as Error).message}`, path);
        }
      }
      throw new JsonBridgeError(`expected integer (number or decimal-string), got ${typeof json}`, path);

    case "rational": {
      // Three input shapes accepted:
      //   {"num": "<int>", "den": "<int>"}     — fraction object
      //   "<int>/<int>"                         — fraction string
      //   "<int>"                               — integer-as-rational
      //   <number>                              — must be an integer
      // Decimal-string rationals are NOT accepted here — they're ambiguous
      // with float64 and require explicit "<num>/<den>" or fraction-object.
      if (typeof json === "object" && json !== null && !Array.isArray(json)) {
        const o = json as { num?: unknown; den?: unknown };
        if (typeof o.num === "string" && typeof o.den === "string") {
          return rat(BigInt(o.num), BigInt(o.den));
        }
      }
      if (typeof json === "string") {
        const slash = json.indexOf("/");
        if (slash >= 0) {
          return rat(BigInt(json.slice(0, slash)), BigInt(json.slice(slash + 1)));
        }
        return rat(BigInt(json), 1n);
      }
      if (typeof json === "number" && Number.isInteger(json)) {
        return rat(BigInt(json), 1n);
      }
      throw new JsonBridgeError(`expected rational ({num,den} | "a/b" | integer), got ${typeof json}`, path);
    }

    case "float64":
      if (typeof json === "number") {
        return float64FromNumber(json);
      }
      if (typeof json === "string" && /^[0-9a-f]{16}$/.test(json)) {
        return { kind: "float64", bits: json };
      }
      throw new JsonBridgeError(`expected float64 (JSON number or 16-hex-bits string), got ${typeof json}`, path);

    case "string":
      if (typeof json === "string") return str(json);
      throw new JsonBridgeError(`expected string, got ${typeof json}`, path);

    case "boolean":
      if (typeof json === "boolean") return { kind: "boolean", value: json };
      throw new JsonBridgeError(`expected boolean, got ${typeof json}`, path);

    case "symbol":
      if (typeof json === "string") return { kind: "symbol", name: json };
      throw new JsonBridgeError(`expected string-as-symbol, got ${typeof json}`, path);

    case "list":
    case "record":
    case "expression":
    case "tagged":
      throw new JsonBridgeError(`kindOf(${kind}) is structural, not a leaf — use list([...]) or record({...}) hints`, path);
  }
}

// -----------------------------------------------------------------------------
// Reverse: canonical Value → raw JSON
// -----------------------------------------------------------------------------
//
// The kind axis is unambiguous (the value tells us). The encoding axis
// is up to the caller — integers can be JSON numbers (lossy past 2^53)
// or JSON strings; rationals can be objects or a-slash-b strings; floats
// can be JSON numbers (round-trip-correct via toString) or hex bits.

export interface JsonBridgeOptions {
  /**
   * "smart" — JSON number when |v| < 2^53, else string.
   * "string" — always JSON string.
   * "number" — always JSON number; throws on overflow. Defaults to "smart".
   */
  integerEncoding?: "smart" | "string" | "number";
  /**
   * "fraction" — {"num":"<n>","den":"<d>"}.
   * "slash"    — "<n>/<d>".
   * Default "fraction".
   */
  rationalEncoding?: "fraction" | "slash";
  /**
   * "number" — JSON number (uses Number(bits) toString round-trip).
   * "hex"    — 16-hex-char bits string.
   * Default "number".
   */
  float64Encoding?: "number" | "hex";
}

const SAFE_INT_MAX = 9007199254740991n; // 2^53 - 1
const SAFE_INT_MIN = -9007199254740991n;

export function canonicalToJson(value: Value, opts: JsonBridgeOptions = {}): unknown {
  const intEnc = opts.integerEncoding ?? "smart";
  const ratEnc = opts.rationalEncoding ?? "fraction";
  const f64Enc = opts.float64Encoding ?? "number";

  switch (value.kind) {
    case "integer":
      return integerToJson(value, intEnc);
    case "rational":
      return ratEnc === "slash" ? `${value.num}/${value.den}` : { num: value.num, den: value.den };
    case "float64":
      return f64Enc === "hex" ? value.bits : float64ToNumber(value);
    case "string":
      return value.value;
    case "boolean":
      return value.value;
    case "symbol":
      return value.name;
    case "list":
      return value.items.map((it) => canonicalToJson(it, opts));
    case "record": {
      const out: Record<string, unknown> = {};
      // Preserve field order alphabetically — matches canonical encoding.
      const keys = Object.keys(value.fields).sort();
      for (const k of keys) out[k] = canonicalToJson(value.fields[k]!, opts);
      return out;
    }
    case "expression":
      // No natural raw-JSON form; emit as a record { head, args } so the
      // structure survives the round-trip.
      return {
        kind: "expression",
        head: value.head,
        args: value.args.map((a) => canonicalToJson(a, opts)),
      };
    case "tagged":
      // Tagged values likewise have no natural raw form. Emit
      // { kind: "tagged", tag, payload } so a downstream consumer who
      // knows the protocol can reconstruct.
      return { kind: "tagged", tag: value.tag, payload: canonicalToJson(value.payload, opts) };
  }
}

function integerToJson(v: IntegerValue, encoding: "smart" | "string" | "number"): number | string {
  const big = BigInt(v.value);
  if (encoding === "string") return v.value;
  if (encoding === "number") {
    if (big > SAFE_INT_MAX || big < SAFE_INT_MIN) {
      throw new JsonBridgeError(
        `integer ${v.value} exceeds JS safe-integer range; use integerEncoding "string" or "smart"`,
        "$"
      );
    }
    return Number(big);
  }
  // smart
  if (big > SAFE_INT_MAX || big < SAFE_INT_MIN) return v.value;
  return Number(big);
}

// -----------------------------------------------------------------------------
// Numerical-tier ergonomic helpers (bead `qiv8`, worklog 120)
// -----------------------------------------------------------------------------
//
// Lift JS `number[]` / `number[][]` into canonical `list<float64>` /
// `list<list<float64>>` values and unpack them back, with return types
// narrow enough that the typed-barrel call site doesn't need an `as
// never` cast at the boundary. Every numerical-tier dogfood site
// (`scripts/demo-scope.ts`, the temp `qwasserstein.ts` from the D_W1
// dogfood) was re-deriving the same boilerplate:
//
//     // build: nested list( map(row => list(map(x => float64FromNumber(x)))) )
//     const M_value = list(M.map(row => list(row.map(x => float64FromNumber(x)))));
//
//     // extract: filter+narrow+map+as-never just to read float64 leaves
//     const eigs = lams.items
//       .filter((it): it is { kind: "float64" } & typeof it => it.kind === "float64")
//       .map((it) => float64ToNumber(it as never));
//
// Both replaced by one-liners — `matrixToValue(M)` / `valueToVector(lams)`.
// The function names follow `valueTo*` / `*ToValue` consistently (the
// bead's mixed `vectorFromValue` was itself a small piece of the same
// boilerplate-tax, normalised here).
//
// The return type of `*ToValue` is the *narrowest* `ListValueOf<...>` —
// no widening to `Value` or `ListValue`, so the typed-barrel call site
// reads the specific element kind from the type. The acceptance test
// for `valueTo*` is "does it work as a one-line replacement for the
// six-line filter/narrow/cast chain?"; the function throws
// `JsonBridgeError` on shape mismatch (a wrong-kind leaf, a
// non-rectangular matrix), so a caller who *knows* the shape gets a
// clean number / number[] / number[][] back.

/**
 * Lift a JS `number[]` into a canonical `list<float64>` value.
 *
 * Each element is encoded via `float64FromNumber` (16 hex chars of
 * IEEE-754 bits). The return type narrows to `ListValueOf<Float64Value>`
 * so the result drops straight into a tool slot typed
 * `list<float64>` with no `as never` cast.
 */
export function vectorToValue(
  v: readonly number[],
): ListValueOf<Float64Value> {
  return {
    kind: "list",
    items: v.map((x) => float64FromNumber(x)),
  };
}

/**
 * Lift a JS `number[][]` into a canonical `list<list<float64>>` value.
 *
 * Rectangularity is checked — every row must have the same length as
 * row 0; an empty matrix (`[]`) is valid (returns the empty list).
 * Throws `JsonBridgeError` on non-rectangular input rather than
 * silently encoding a ragged shape — the workbench's linalg tools all
 * assume rectangular matrices and a ragged input would crash deeper
 * with a much less useful error.
 */
export function matrixToValue(
  M: readonly (readonly number[])[],
): ListValueOf<ListValueOf<Float64Value>> {
  if (M.length === 0) {
    return { kind: "list", items: [] };
  }
  const nCols = M[0]!.length;
  for (let i = 1; i < M.length; i++) {
    if (M[i]!.length !== nCols) {
      throw new JsonBridgeError(
        `matrixToValue: row ${i} has length ${M[i]!.length}, expected ${nCols} (matrix must be rectangular)`,
        `$[${i}]`,
      );
    }
  }
  return {
    kind: "list",
    items: M.map((row) => vectorToValue(row)),
  };
}

/**
 * Extract a JS `number[]` from a canonical `list<float64>` value.
 *
 * Accepts a loose `Value` so the caller doesn't have to prove the
 * shape before calling — exactly the boilerplate this helper exists
 * to delete. Throws `JsonBridgeError` if the value is not a list, or
 * if any element is not `float64`. The error message names the
 * offending position (`$[i]`) for ergonomic debugging at deep call
 * sites.
 */
export function valueToVector(v: Value): number[] {
  if (v.kind !== "list") {
    throw new JsonBridgeError(
      `valueToVector: expected list, got ${v.kind}`,
      "$",
    );
  }
  const out = new Array<number>(v.items.length);
  for (let i = 0; i < v.items.length; i++) {
    const it = v.items[i]!;
    if (it.kind !== "float64") {
      throw new JsonBridgeError(
        `valueToVector: element ${i} is ${it.kind}, expected float64`,
        `$[${i}]`,
      );
    }
    out[i] = float64ToNumber(it);
  }
  return out;
}

/**
 * Extract a JS `number[][]` from a canonical `list<list<float64>>`
 * value.
 *
 * Rectangularity is enforced (every row must have the same length as
 * row 0); a value that came from a workbench linalg tool will always
 * be rectangular, but defensive checking turns a corrupted input into
 * a clean `JsonBridgeError` instead of a confusing downstream crash.
 */
export function valueToMatrix(v: Value): number[][] {
  if (v.kind !== "list") {
    throw new JsonBridgeError(
      `valueToMatrix: expected list, got ${v.kind}`,
      "$",
    );
  }
  if (v.items.length === 0) return [];
  const out: number[][] = [];
  let nCols = -1;
  for (let i = 0; i < v.items.length; i++) {
    const row = v.items[i]!;
    if (row.kind !== "list") {
      throw new JsonBridgeError(
        `valueToMatrix: row ${i} is ${row.kind}, expected list`,
        `$[${i}]`,
      );
    }
    if (nCols === -1) {
      nCols = row.items.length;
    } else if (row.items.length !== nCols) {
      throw new JsonBridgeError(
        `valueToMatrix: row ${i} has length ${row.items.length}, expected ${nCols} (matrix must be rectangular)`,
        `$[${i}]`,
      );
    }
    const rowOut = new Array<number>(row.items.length);
    for (let j = 0; j < row.items.length; j++) {
      const cell = row.items[j]!;
      if (cell.kind !== "float64") {
        throw new JsonBridgeError(
          `valueToMatrix: element [${i}][${j}] is ${cell.kind}, expected float64`,
          `$[${i}][${j}]`,
        );
      }
      rowOut[j] = float64ToNumber(cell);
    }
    out.push(rowOut);
  }
  return out;
}
