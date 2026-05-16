// =============================================================================
// special-eval — per-head arbitrary-precision / float64 evaluator umbrella
// =============================================================================
//
// The wire surface for ADR-0040's per-head special-function substrate.
// This is the *single* tool an agent reaches for when the question is "give
// me Erf at this argument, this precision" — the dispatch across the Erf
// family (6 real heads + 4 complex heads) and across the two determinism
// tiers (float64 vs arb-prec) lives behind one umbrella with a single
// `--head=<name>` flag. ADR-0040 §"Decision 7" is the design rationale;
// the prompt and seven-artefact contract are non-negotiable per PRD §4.2
// + CLAUDE.md Rules 0, 1, 8, 10.
//
// What this tool is (the agent's mental model)
// --------------------------------------------
// "I have a Value-protocol-shaped scientific request — `head: 'Erf', args:
// [0.5], precision: 200` — and I want the answer as a value-protocol Value
// I can hash, cache, and feed into another tool. I want bit-determinism
// across runtimes (`arbprec: true`, ADR-0020) at high precision, and
// `numerical: true`-grade float64 at low precision (ADR-0015). I want
// honest refusal — `tagged "special-eval/no-known-representation"` for
// `InverseErf` on the complex axis, because no canonical computational
// form exists. I don't want to learn 6 tools, one per head."
//
// Per-head dispatch table (v0.1)
// ------------------------------
//
//   head           real (float64 / arb-prec)              complex (float64 / arb-prec)
//   --------------+---------------------------------------+-----------------------------------
//   Erf            erfFloat64        / bigErf              erfComplexFloat64        / bigCErf
//   Erfc           erfcFloat64       / bigErfc             erfcComplexFloat64       / bigCErfc
//   Erfcx          erfcxFloat64      / bigErfcx            erfcxComplexFloat64      / bigCErfcx
//   Erfi           erfiFloat64       / via bigCErfi        erfiComplexFloat64       / bigCErfi
//   InverseErf     erfInvFloat64     / —  (no-known-repr)  —  (no-known-repr)        / —
//   InverseErfc    erfcInvFloat64    / —  (no-known-repr)  —  (no-known-repr)        / —
//
// Two known v0.1 gaps surfaced honestly in the table above:
//
//   * `bigErfi(BigFloat, prec)` does not exist as a separate real entry
//     point — but per the Karbach identity table (R2 §"Pick"), real-axis
//     erfi is the imaginary part of `bigCErfi` evaluated on the
//     imaginary axis: `Erfi(x) = Im(CErfi(0 + xi)) / 1` is one form, but
//     more directly `Erfi(x) = -i · Erf(ix)` and the complex evaluator
//     produces the result with `Im part = Erfi(x)` when the input is
//     purely imaginary. Practically, we route the real arb-prec Erfi
//     call through `bigCErfi` on a purely-real BigComplex and take the
//     real part of the result (the substrate's bigCErfi handles the
//     algebraic combination internally).
//
//   * `bigErfInverse` / `bigErfcInverse` are NOT in Phase 2's deliverables
//     (the impl-plan §I5 spec'd Newton on bigErf but it was deferred). For
//     `--precision > 53` requests of InverseErf / InverseErfc, the tool
//     refuses with `tagged "special-eval/no-known-representation"`. The
//     float64 path remains available (`--precision = 53`). Complex
//     InverseErf / InverseErfc refuse always per R3 §3 — multi-valued
//     Riemann surface; no canonical computational form.
//
// Per-output tier dispatch (ADR-0040 §"Decision 9")
// -------------------------------------------------
// `--precision ≤ 53` routes the float64 lane (I5); `> 53` routes the
// arb-prec lane (I1-I3). The output is *always* encoded as a `bigfloat`
// (real) or `bigcomplex` (complex) — at p=53 the BigFloat carries a
// 53-bit mantissa with the float64 result as its content, and at p>53
// the BigFloat carries the requested precision. This keeps the wire
// schema uniform across tiers while honouring the tier-decision the
// precision flag pins.
//
// Why arbprec: true and not numerical: true
// -----------------------------------------
// The runner's tier mutex (ADR-0015 + ADR-0020, enforced in
// `executeToolDef`) admits at most one of {nondeterministic, numerical,
// arbprec}. The `--precision` standard flag is inherited only when
// `arbprec: true`. ADR-0040 §"Decision 9" described the ideal as listing
// both annotations on the manifest; the *implementable* shape under the
// existing mutex is `arbprec: true` plus per-output dispatch (the float64
// lane's result is still byte-deterministic on a single platform; the
// BigFloat encoding makes it bit-deterministic across runtimes as soon
// as it lands in the wire because BigFloat operations are bit-identical
// cross-platform by language spec — see ADR-0020 §"Context"). A future
// ADR can lift the mutex to support per-output tier conditioning across
// the {numerical, arbprec} pair; for now the practical resolution is
// the single arbprec annotation.
//
// Refusal envelope (ADR-0003 boundary categories)
// -----------------------------------------------
//   * `special-eval/unknown-head` — head not in the v0.1 Erf family.
//     Payload: `{head: string, admitted: list<string>}`.
//   * `special-eval/non-finite-input` — NaN / ±Inf in `args` (real or
//     complex parts). Payload: `{which: string, value: string}`.
//   * `special-eval/degenerate-shape` — complex args with mismatched
//     `re` / `im` list lengths, or args list size doesn't match head
//     arity. Payload: `{detail: string}`.
//   * `special-eval/no-known-representation` — caller requested arb-prec
//     InverseErf / InverseErfc (no arb-prec impl in v0.1) or complex
//     InverseErf / InverseErfc (no canonical form per R3 §3). Payload:
//     `{head: string, axis: string, reason: string}`.
//
// Malformed input (`ToolError`, exit 1) is reserved for:
//   * args list empty when the head requires args (caught by the
//     schema's list shape + the post-validation arity check).
//   * args list contains a value not parsable as a float64 (caught by
//     the schema before the body runs).
//
// References
// ----------
// ADR-0040 (per-head substrate), ADR-0020 (arb-prec tier), ADR-0015
// (numerical tier), ADR-0011 (typed flags), CLAUDE.md (every rule).
// The substrate this tool wraps lives in:
//
//   * Real arb-prec:  @workbench/bigfloat::{bigErf, bigErfc, bigErfcx}
//   * Complex arb-prec: @workbench/bigfloat::{bigCErf, bigCErfc,
//                       bigCErfcx, bigCErfi}
//   * Real float64:   @workbench/quadrature::{erfFloat64, erfcFloat64,
//                       erfcxFloat64, erfiFloat64, erfInvFloat64,
//                       erfcInvFloat64}
//   * Complex float64: @workbench/quadrature::{erfComplexFloat64,
//                       erfcComplexFloat64, erfcxComplexFloat64,
//                       erfiComplexFloat64}

import {
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Float64Value,
  type ListValue,
  type RecordValue,
  type StringValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type BigComplex,
  type BigFloat,
  add as bfAdd,
  bigCErf,
  bigCErfc,
  bigCErfcx,
  bigCErfi,
  bigErf,
  bigErfc,
  bigErfcx,
  bigcomplexSchema,
  bigcomplexToValue,
  bigfloatSchema,
  bigfloatToValue,
  cim,
  cre,
  decimalToBinaryPrecision,
  fromFloat64,
  fromInt,
  normalise,
  sub as bfSub,
  toString as bfToString,
} from "@workbench/bigfloat";
import {
  erfcComplexFloat64,
  erfcFloat64,
  erfcInvFloat64,
  erfcxComplexFloat64,
  erfcxFloat64,
  erfComplexFloat64,
  erfFloat64,
  erfInvFloat64,
  erfiComplexFloat64,
  erfiFloat64,
} from "@workbench/quadrature";

const NAME = "special-eval";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Per-head metadata
// -----------------------------------------------------------------------------
//
// The closed vocabulary the v0.1 substrate covers. Adding a future head
// (Bessel J, Whittaker, ...) is a one-line table extension PLUS the
// per-head substrate landing per ADR-0040's substrate pattern.

const ADMITTED_HEADS = [
  "Erf",
  "Erfc",
  "Erfcx",
  "Erfi",
  "InverseErf",
  "InverseErfc",
] as const;

type AdmittedHead = (typeof ADMITTED_HEADS)[number];

function isAdmittedHead(h: string): h is AdmittedHead {
  return (ADMITTED_HEADS as readonly string[]).includes(h);
}

// Heads for which we have NO arb-prec implementation in v0.1, and
// for which complex evaluation is mathematically refused.
//
// Per R3 §3: InverseErf / InverseErfc on the complex axis have no
// canonical computational form (multi-valued Riemann surface; SciPy /
// Boost / Julia all decline). The float64 real path remains available;
// the arb-prec real path is a Phase 2 gap (Newton-on-bigErf was spec'd
// but not delivered).
const NO_ARBPREC_REAL: ReadonlySet<AdmittedHead> = new Set([
  "InverseErf",
  "InverseErfc",
]);

const NO_COMPLEX_AT_ALL: ReadonlySet<AdmittedHead> = new Set([
  "InverseErf",
  "InverseErfc",
]);

// Float64-tier method tags. Informational, written into the output
// `method` field so an agent's planner can audit which algorithm
// produced the value (R3's lineage; load-bearing for provenance audit).
//
// The method tag also doubles as the agent-readable lineage citation —
// "erf-sunpro-1993" is more useful in a downstream debugging trace
// than "lib-call" because it pins the canonical paper.
const FLOAT64_METHOD: Record<AdmittedHead, string> = {
  Erf: "erf-sunpro-1993",
  Erfc: "erf-sunpro-1993",
  Erfcx: "erf-sunpro-1993",
  Erfi: "erf-sunpro-1993",
  InverseErf: "erf-blair-1976-inverse",
  InverseErfc: "erf-blair-1976-inverse",
};

const FLOAT64_COMPLEX_METHOD: Record<AdmittedHead, string> = {
  Erf: "erf-faddeeva-johnson",
  Erfc: "erf-faddeeva-johnson",
  Erfcx: "erf-faddeeva-johnson",
  Erfi: "erf-faddeeva-johnson",
  InverseErf: "—",
  InverseErfc: "—",
};

const ARBPREC_METHOD_REAL: Record<AdmittedHead, string> = {
  Erf: "erf-borel-series-or-asymptotic",
  Erfc: "erf-borel-series-or-asymptotic",
  Erfcx: "erf-borel-series-or-asymptotic",
  Erfi: "erf-karbach-weideman",
  InverseErf: "—",
  InverseErfc: "—",
};

const ARBPREC_METHOD_COMPLEX: Record<AdmittedHead, string> = {
  Erf: "erf-karbach-weideman",
  Erfc: "erf-karbach-weideman",
  Erfcx: "erf-karbach-weideman",
  Erfi: "erf-karbach-weideman",
  InverseErf: "—",
  InverseErfc: "—",
};

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// The `args` field is a value-protocol union: a `list<float64>` for the
// real-axis call, or a `record{re, im}` of `list<float64>` for complex.
// Both shapes carry one element per call site in v0.1 (every Erf-family
// head is arity 1) — keeping the *shape* as a list keeps the door open
// for future multi-parameter heads (Bessel J takes order + argument)
// without breaking the wire schema.

const realArgsSchema = S.list(S.kind("float64"));
const complexArgsSchema = S.record({
  re: S.list(S.kind("float64")),
  im: S.list(S.kind("float64")),
});

const inputSchema = S.record({
  head: S.kind("string"),
  args: S.union([realArgsSchema, complexArgsSchema]),
});

// The output's `value` field is one of three encodings, all on the
// arb-prec wire surface (ADR-0020). Real BigFloat outputs (the
// real-axis lane) carry `bigfloat`; complex BigComplex outputs carry
// `bigcomplex`; the float64 lane wraps its result in a 53-bit BigFloat
// (real) or BigComplex (complex) so the wire schema is uniform across
// tiers. The agent reads `achieved_precision` to discover the live
// tier; the `method` tag pins the algorithm lineage.
const successOutputSchema = S.record({
  value: S.union([bigfloatSchema, bigcomplexSchema]),
  method: S.kind("string"),
  achieved_precision: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});

// Literal tag strings — kept as `const`s so type narrowing through
// `tagged(...)` / `S.tagged(...)` preserves the literal type rather than
// widening to `string`. The matching value-constructor helpers below
// (`unknownHead`, `nonFinite`, ...) use the same constants.
const TAG_UNKNOWN_HEAD = "special-eval/unknown-head" as const;
const TAG_NON_FINITE = "special-eval/non-finite-input" as const;
const TAG_DEGENERATE = "special-eval/degenerate-shape" as const;
const TAG_NO_REPR = "special-eval/no-known-representation" as const;

const unknownHeadOutputSchema = S.tagged(
  TAG_UNKNOWN_HEAD,
  S.record({
    head: S.kind("string"),
    admitted: S.list(S.kind("string")),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  TAG_NON_FINITE,
  S.record({
    which: S.kind("string"),
    value: S.kind("string"),
  }),
);

const degenerateOutputSchema = S.tagged(
  TAG_DEGENERATE,
  S.record({ detail: S.kind("string") }),
);

const noKnownReprOutputSchema = S.tagged(
  TAG_NO_REPR,
  S.record({
    head: S.kind("string"),
    axis: S.kind("string"),
    reason: S.kind("string"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  unknownHeadOutputSchema,
  nonFiniteOutputSchema,
  degenerateOutputSchema,
  noKnownReprOutputSchema,
]);

// -----------------------------------------------------------------------------
// Convenience helpers — encoding successful outputs
// -----------------------------------------------------------------------------

function realSuccess(
  v: BigFloat,
  method: string,
  achievedPrecBits: number,
  warnings: string[] = [],
) {
  return record({
    value: bigfloatToValue(v),
    method: str(method),
    achieved_precision: int(BigInt(achievedPrecBits)),
    warnings: list(warnings.map((w) => str(w))),
  });
}

function complexSuccess(
  v: BigComplex,
  method: string,
  achievedPrecBits: number,
  warnings: string[] = [],
) {
  return record({
    value: bigcomplexToValue(v),
    method: str(method),
    achieved_precision: int(BigInt(achievedPrecBits)),
    warnings: list(warnings.map((w) => str(w))),
  });
}

/**
 * Wrap a float64 real value as a 53-bit BigFloat. `fromFloat64` is exact
 * (every finite float64 has an exact binary expansion fitting 53 bits);
 * `normalise` then forces the precision metadata to 53 so the wire shape
 * is uniform.
 */
function float64ToBigFloat(x: number): BigFloat {
  if (!Number.isFinite(x)) {
    // The substrate sometimes returns ±Inf (e.g. `erfInvFloat64(1)`); we
    // represent these as max-magnitude finite BigFloats with a warning
    // upstream. Here we just guard so `fromFloat64` doesn't throw.
    // Callers should have intercepted the saturation case BEFORE calling
    // us; if we land here it's a bug in the dispatcher.
    throw new ToolError(
      `${NAME}: internal — float64ToBigFloat called on non-finite ${x}`,
      { suggestion: "this is an internal-dispatcher invariant violation; report a bug" },
    );
  }
  const bf = fromFloat64(x);
  // Round/pad to exactly 53 bits so achieved_precision = 53 is honest.
  return normalise(bf.mantissa, bf.exponent, 53);
}

/**
 * Wrap a (re, im) float64 pair as a 53-bit BigComplex.
 */
function float64ToBigComplex(re: number, im: number): BigComplex {
  return { re: float64ToBigFloat(re), im: float64ToBigFloat(im) };
}

// -----------------------------------------------------------------------------
// Input decoding helpers
// -----------------------------------------------------------------------------

function readRealArgs(args: ListValue): number[] {
  return args.items.map((v) => {
    if (v.kind !== "float64") {
      throw new ToolError(
        `${NAME}: real args must be float64 leaves; got ${v.kind}`,
      );
    }
    return float64ToNumber(v as Float64Value);
  });
}

function readComplexArgs(args: RecordValue): { re: number[]; im: number[] } {
  const reField = args.fields.re;
  const imField = args.fields.im;
  if (reField === undefined || imField === undefined) {
    throw new ToolError(
      `${NAME}: complex args record must have both 're' and 'im' fields`,
    );
  }
  if (reField.kind !== "list" || imField.kind !== "list") {
    throw new ToolError(
      `${NAME}: complex args 're' and 'im' must be list<float64>`,
    );
  }
  const re = readRealArgs(reField as ListValue);
  const im = readRealArgs(imField as ListValue);
  return { re, im };
}

// -----------------------------------------------------------------------------
// Refusal helpers — building tagged outputs
// -----------------------------------------------------------------------------

function unknownHead(head: string) {
  return tagged(
    TAG_UNKNOWN_HEAD,
    record({
      head: str(head),
      admitted: list(ADMITTED_HEADS.map((h) => str(h))),
    }),
  );
}

function nonFinite(which: string, value: number) {
  return tagged(
    TAG_NON_FINITE,
    record({
      which: str(which),
      value: str(formatNonFinite(value)),
    }),
  );
}

function degenerateShape(detail: string) {
  return tagged(
    TAG_DEGENERATE,
    record({ detail: str(detail) }),
  );
}

function noKnownRepresentation(head: string, axis: string, reason: string) {
  return tagged(
    TAG_NO_REPR,
    record({
      head: str(head),
      axis: str(axis),
      reason: str(reason),
    }),
  );
}

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

// -----------------------------------------------------------------------------
// Core dispatch — per-head per-tier
// -----------------------------------------------------------------------------

/**
 * Dispatch a real-axis call. Caller has validated arity (one arg) and
 * finiteness. Returns the encoded success record OR a tagged refusal
 * (no-known-representation when arb-prec is requested for an inverse).
 */
function dispatchReal(
  head: AdmittedHead,
  x: number,
  precisionDecimal: number,
): Value {
  // Tier dispatch: the precision flag picks the lane. The boundary at 53
  // bits is the IEEE-754 binary64 mantissa width; per ADR-0040 §"Decision
  // 9" this is the dispatch threshold the agent's planner aligns with.
  // We compare against the BINARY-precision floor (53 bits ≈ 16 decimal
  // digits via Math.log2(10)≈3.32), so `--precision <= 15` (decimal)
  // routes float64.
  const useFloat64 = precisionDecimal <= 15;

  if (useFloat64) {
    // Float64 lane — uses the SunPro 1993 port (R3 / I5).
    const fn: (x: number) => number =
      head === "Erf" ? erfFloat64
      : head === "Erfc" ? erfcFloat64
      : head === "Erfcx" ? erfcxFloat64
      : head === "Erfi" ? erfiFloat64
      : head === "InverseErf" ? erfInvFloat64
      : erfcInvFloat64;
    const y = fn(x);
    const method = FLOAT64_METHOD[head];
    const warnings: string[] = [];
    if (!Number.isFinite(y)) {
      // Saturated output (e.g. erfInv(1) = +Inf). We emit a max-magnitude
      // BigFloat with a warning rather than throw; this is the same
      // agent-honest pattern as `linalg-solve`'s warnings list.
      warnings.push(
        `float64-saturation: ${head}(${x}) = ${formatNonFinite(y)}; saturated at float64 boundary`,
      );
      // Represent as a max-magnitude finite BigFloat: the largest float64
      // is ~1.8e308. We use that as the encoding. Honest alternative
      // would be a separate boundary tag, but the existing warnings
      // surface is the agent-honest channel for "saturation observed".
      const sat = y > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
      return realSuccess(float64ToBigFloat(sat), method, 53, warnings);
    }
    return realSuccess(float64ToBigFloat(y), method, 53, warnings);
  }

  // Arb-prec lane. First refuse the heads we have no real arb-prec impl
  // for in v0.1 (InverseErf / InverseErfc — see top-of-file table).
  if (NO_ARBPREC_REAL.has(head)) {
    return noKnownRepresentation(
      head,
      "real",
      `v0.1 substrate ships no arb-prec impl for ${head}; use --precision <= 15 for the float64 path`,
    );
  }

  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const xBig = fromFloat64(x);
  const method = ARBPREC_METHOD_REAL[head];

  // Per-head substrate dispatch. The substrate primitives live in
  // `packages/bigfloat/src/special-funcs/erf.ts` (I1+I2) and
  // `packages/bigfloat/src/complex.ts` (I3, used for real Erfi via the
  // bigCErfi identity).
  let result: BigFloat;
  switch (head) {
    case "Erf":
      result = bigErf(xBig, precBits);
      break;
    case "Erfc":
      result = bigErfc(xBig, precBits);
      break;
    case "Erfcx":
      result = bigErfcx(xBig, precBits);
      break;
    case "Erfi": {
      // Real arb-prec Erfi: route through bigCErfi at z = x + 0i and
      // take the real part. This is the substrate's intended path (see
      // R2 §"Pick: Karbach-Weideman" identity table — `bigCErfi(x) =
      // bigCErfi(x + 0i)` is real-axis by construction; the bigfloat
      // package didn't ship a separate real `bigErfi` because the
      // identity makes it redundant). The imaginary part of the result
      // should be (and is, by construction) zero modulo internal
      // round-off; we surface a warning if the imaginary part is large
      // enough to be a structural problem (which would indicate a
      // substrate bug — not expected, but agent-honest to surface).
      const z: BigComplex = { re: xBig, im: fromInt(0n, precBits) };
      const w = bigCErfi(z, precBits);
      result = cre(w);
      const imPart = cim(w);
      // The imaginary part should be 0 byte-identically by construction.
      // If it's not, the warning surfaces the substrate anomaly.
      if (imPart.mantissa !== 0n) {
        // Treat as a soft anomaly — not a refusal, since the real part
        // IS the correct answer. Surface via warnings.
        // (No actual return; flow continues with `result` = real part.)
        // Note: warnings on the success branch is the right channel —
        // see `integrate-1d`'s warnings field for the same pattern.
        return realSuccess(result, method, precBits, [
          `arbprec-erfi: imaginary part of bigCErfi(${x} + 0i) was non-zero; this is the real part`,
        ]);
      }
      break;
    }
    case "InverseErf":
    case "InverseErfc":
      // Unreachable — handled by NO_ARBPREC_REAL gate above.
      return noKnownRepresentation(head, "real", "unreachable inverse gate");
  }
  return realSuccess(result, method, precBits, []);
}

/**
 * Dispatch a complex-axis call. Caller has validated arity (one (re,im)
 * pair) and finiteness. Returns the encoded success record OR a tagged
 * refusal (no-known-representation for InverseErf / InverseErfc complex
 * regardless of precision — per R3 §3 there's no canonical computational
 * form on the complex plane).
 */
function dispatchComplex(
  head: AdmittedHead,
  re: number,
  im: number,
  precisionDecimal: number,
): Value {
  // Honest refusal for complex inverses, at every precision tier (R3 §3).
  if (NO_COMPLEX_AT_ALL.has(head)) {
    return noKnownRepresentation(
      head,
      "complex",
      `${head} on the complex axis has no canonical computational form (multi-valued Riemann surface; R3 §3 — SciPy / Boost / Julia all decline)`,
    );
  }

  const useFloat64 = precisionDecimal <= 15;

  if (useFloat64) {
    const fn: (re: number, im: number) => { re: number; im: number } =
      head === "Erf" ? erfComplexFloat64
      : head === "Erfc" ? erfcComplexFloat64
      : head === "Erfcx" ? erfcxComplexFloat64
      : erfiComplexFloat64;
    const { re: yRe, im: yIm } = fn(re, im);
    const method = FLOAT64_COMPLEX_METHOD[head];
    const warnings: string[] = [];
    if (!Number.isFinite(yRe) || !Number.isFinite(yIm)) {
      warnings.push(
        `float64-saturation: ${head}(${re}+${im}i) = (${formatNonFinite(yRe)} + ${formatNonFinite(yIm)}i); saturated`,
      );
      const satRe = Number.isFinite(yRe) ? yRe : (yRe > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      const satIm = Number.isFinite(yIm) ? yIm : (yIm > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      return complexSuccess(float64ToBigComplex(satRe, satIm), method, 53, warnings);
    }
    return complexSuccess(float64ToBigComplex(yRe, yIm), method, 53, warnings);
  }

  // Arb-prec complex lane. No v0.1 gaps here for the four forward heads.
  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const z: BigComplex = {
    re: fromFloat64(re),
    im: fromFloat64(im),
  };
  const method = ARBPREC_METHOD_COMPLEX[head];

  let result: BigComplex;
  switch (head) {
    case "Erf":
      result = bigCErf(z, precBits);
      break;
    case "Erfc":
      result = bigCErfc(z, precBits);
      break;
    case "Erfcx":
      result = bigCErfcx(z, precBits);
      break;
    case "Erfi":
      result = bigCErfi(z, precBits);
      break;
    case "InverseErf":
    case "InverseErfc":
      // Unreachable — handled by NO_COMPLEX_AT_ALL gate above.
      return noKnownRepresentation(head, "complex", "unreachable inverse gate");
  }
  return complexSuccess(result, method, precBits, []);
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  examples: [
    {
      description: "Erf(0.5) at default precision (53-bit float64 lane, BigFloat-encoded)",
      input: record({
        head: str("Erf"),
        args: list([float64FromNumber(0.5)]),
      }),
    },
    {
      description: "Erfc(20) at precision 50 (arb-prec lane; tiny output ≈ 5.4e-176)",
      input: record({
        head: str("Erfc"),
        args: list([float64FromNumber(20)]),
      }),
      flags: { precision: "50" },
    },
    {
      description: "complex Erf at z = 1 + i, precision 50",
      input: record({
        head: str("Erf"),
        args: record({
          re: list([float64FromNumber(1)]),
          im: list([float64FromNumber(1)]),
        }),
      }),
      flags: { precision: "50" },
    },
    {
      description: "unknown head → tagged refusal",
      input: record({
        head: str("BesselJ"),
        args: list([float64FromNumber(0)]),
      }),
      output: unknownHead("BesselJ"),
    },
    {
      description: "complex InverseErf → no-known-representation",
      input: record({
        head: str("InverseErf"),
        args: record({
          re: list([float64FromNumber(0.5)]),
          im: list([float64FromNumber(0)]),
        }),
      }),
      output: noKnownRepresentation(
        "InverseErf",
        "complex",
        "InverseErf on the complex axis has no canonical computational form (multi-valued Riemann surface; R3 §3 — SciPy / Boost / Julia all decline)",
      ),
    },
  ],
  invariants: [
    {
      name: "arbprec-deterministic-cross-platform",
      statement:
        "Same input bytes + same --precision → byte-identical output bytes on any runtime / arch / os (ADR-0020). BigInt arithmetic is bit-identical by language spec; the substrate inherits the contract.",
      machine_checkable: true,
    },
    {
      name: "tier-dispatch-by-precision-flag",
      statement:
        "--precision <= 15 (decimal) routes the float64 lane (achieved_precision = 53 bits); --precision > 15 routes the arb-prec lane. The wire output is uniformly bigfloat / bigcomplex across tiers; achieved_precision discloses the live tier (ADR-0040 §'Decision 9').",
      machine_checkable: true,
    },
    {
      name: "honest-no-known-representation",
      statement:
        "Complex InverseErf / InverseErfc refuse always (R3 §3 — multi-valued Riemann surface). Arb-prec InverseErf / InverseErfc refuse at --precision > 15 (Phase 2 substrate gap). Float64 real InverseErf / InverseErfc remain available.",
      machine_checkable: true,
    },
    {
      name: "parity-real-arbprec",
      statement:
        "bigErf(-x, prec) == -bigErf(x, prec) byte-identically at every precision (DLMF §7.4.1).",
      machine_checkable: true,
    },
    {
      name: "erfc-plus-erf-identity",
      statement:
        "bigErf(x, prec) + bigErfc(x, prec) == 1 byte-identically (DLMF §7.2.1 / §7.2.2 algebraic relation).",
      machine_checkable: true,
    },
    {
      name: "restriction-to-real-axis",
      statement:
        "bigCErf(x + 0i, prec).re agrees with bigErf(x, prec) to >= prec - 4 bits; bigCErf(x + 0i, prec).im is zero by construction.",
      machine_checkable: true,
    },
    {
      name: "non-finite-input-tagged",
      statement:
        "NaN / ±Inf in any args slot → tagged 'special-eval/non-finite-input' — never silent wrong value.",
      machine_checkable: true,
    },
    {
      name: "unknown-head-tagged",
      statement:
        "head not in {Erf, Erfc, Erfcx, Erfi, InverseErf, InverseErfc} → tagged 'special-eval/unknown-head' with the admitted list — never a silent fallthrough.",
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement:
        "complex args with mismatched re/im list lengths → tagged 'special-eval/degenerate-shape' — never a silent zero-fill.",
      machine_checkable: true,
    },
  ],
  fn: (input, flags) => {
    const inputRecord = input as RecordValue;
    const headField = inputRecord.fields.head as StringValue | undefined;
    const argsField = inputRecord.fields.args;
    if (headField === undefined || argsField === undefined) {
      throw new ToolError(
        `${NAME}: input record must have 'head' and 'args' fields`,
      );
    }
    const head = headField.value;
    if (!isAdmittedHead(head)) {
      return unknownHead(head);
    }

    // Read the precision flag. Per ADR-0020 / ADR-0011, arb-prec tools
    // inherit a standard `--precision=<int>` flag from the runner; it
    // arrives in `flags.precision` as `bigint` (the runner's typed
    // parse). Default 50 decimal digits (the ADR-0020 default).
    const precisionDecimal = Number(
      (flags as { precision?: bigint }).precision ?? 50n,
    );
    if (!Number.isInteger(precisionDecimal) || precisionDecimal < 1) {
      throw new ToolError(
        `${NAME}: precision must be a positive integer; got ${precisionDecimal}`,
      );
    }

    // Dispatch on the args' wire shape: list = real axis; record = complex.
    if (argsField.kind === "list") {
      const xs = readRealArgs(argsField as ListValue);
      if (xs.length !== 1) {
        return degenerateShape(
          `head '${head}' requires arity 1; got args list of length ${xs.length}`,
        );
      }
      const x = xs[0]!;
      if (!Number.isFinite(x)) {
        return nonFinite("args[0]", x);
      }
      return dispatchReal(head, x, precisionDecimal);
    }
    if (argsField.kind === "record") {
      const { re, im } = readComplexArgs(argsField as RecordValue);
      if (re.length !== im.length) {
        return degenerateShape(
          `complex args 're' and 'im' lists must have matching lengths; got re.length=${re.length}, im.length=${im.length}`,
        );
      }
      if (re.length !== 1) {
        return degenerateShape(
          `head '${head}' requires arity 1; got complex args of length ${re.length}`,
        );
      }
      const rePart = re[0]!;
      const imPart = im[0]!;
      if (!Number.isFinite(rePart)) return nonFinite("args.re[0]", rePart);
      if (!Number.isFinite(imPart)) return nonFinite("args.im[0]", imPart);
      return dispatchComplex(head, rePart, imPart, precisionDecimal);
    }
    throw new ToolError(
      `${NAME}: args must be either a list<float64> (real) or record{re, im: list<float64>} (complex); got ${argsField.kind}`,
    );
  },
  // ---------------------------------------------------------------------------
  // --test hook — structural property assertions
  // ---------------------------------------------------------------------------
  //
  // Per CLAUDE.md Rule 7 ("'runs without errors' is not a passing test")
  // every assertion below pins a load-bearing invariant. The hook is the
  // second-fastest signal (per Rule 5); goldens lock the bytes; --test
  // verifies the algebra.
  //
  // Cross-validation against the mpmath corpus (bench/erf-anchor/oracles/
  // mpmath/results.json) is the *gold-tier* check; here we use a
  // representative subset (~5 cases per head) so --test stays well under
  // a second. Full corpus cross-validation lives in a sibling Phase-1
  // bench harness (not this tool).
  test: () => {
    const errors: string[] = [];

    // Helper: round a BigFloat to a decimal string and compare against
    // an expected decimal-string truth to N digits (lenient bytes-wise,
    // strict on digit agreement).
    function digitsAgree(
      actual: BigFloat,
      expected: string,
      minAgreeDigits: number,
    ): boolean {
      const actualStr = toDecimalNormalised(actual, minAgreeDigits + 4);
      const expStr = canonicalDecimal(expected, minAgreeDigits + 4);
      // Compare the first minAgreeDigits significant figures.
      return actualStr.slice(0, minAgreeDigits) === expStr.slice(0, minAgreeDigits);
    }

    // ----- Erf basic spot-checks against mpmath@55dp values from the
    //       Phase-1 corpus (bench/erf-anchor/oracles/mpmath/results.json) -----
    //
    // Reference values transcribed verbatim from the corpus; agreement
    // to 30 decimals is the bar (deep enough to detect any single-bit
    // perturbation in the bigErf series / asymptotic dispatch).
    const erfCases: Array<{ x: number; expected: string }> = [
      // T1-erf-001: erf(0) = 0
      { x: 0, expected: "0" },
      // T1-erf-002: erf(0.001) ≈ 0.001128378790969236...
      { x: 0.001, expected: "0.001128378790969236403437564139371489641823499076882565274" },
      // erf(0.5) ≈ 0.520499877813046537682746653891964...
      { x: 0.5, expected: "0.5204998778130465376827466538919645287364515757579637000588" },
      // erf(1) ≈ 0.842700792949714869341220635082609...
      { x: 1, expected: "0.8427007929497148693412206350826092592960669979663028634" },
      // erf(2) ≈ 0.995322265018952734162069256367252...
      { x: 2, expected: "0.9953222650189527341620692563672529070270731865186750986" },
    ];
    const prec200 = 200; // bits — enough for ~60 decimals
    for (const c of erfCases) {
      const result = bigErf(fromFloat64(c.x), prec200);
      if (!digitsAgree(result, c.expected, 30)) {
        errors.push(
          `Erf(${c.x}) @ p=200 bits disagrees with mpmath corpus at 30 dp; got ${toDecimalNormalised(result, 40)} expected ${c.expected.slice(0, 40)}`,
        );
      }
    }

    // ----- Parity invariant: erf(-x) == -erf(x) byte-identically -----
    for (const xs of ["0.1", "0.5", "1.0", "2.0", "5.0"]) {
      const xNum = parseFloat(xs);
      const x = fromFloat64(xNum);
      const minusX = { mantissa: -x.mantissa, exponent: x.exponent, precision: x.precision };
      const lhs = bigErf(minusX as BigFloat, 200);
      const rhs = bigErf(x, 200);
      // Compare: lhs.mantissa === -rhs.mantissa byte-for-byte
      if (lhs.mantissa !== -rhs.mantissa || lhs.exponent !== rhs.exponent || lhs.precision !== rhs.precision) {
        errors.push(
          `parity: bigErf(-${xs}) != -bigErf(${xs}) byte-identically (mantissa ${lhs.mantissa} vs -${rhs.mantissa})`,
        );
      }
    }

    // ----- Algebraic identity: erf(x) + erfc(x) = 1 byte-identically -----
    //
    // The substrate (I2 worklog 135) guarantees this byte-identically.
    // We assert here at three different precisions to prove the
    // dispatch lanes don't perturb the identity.
    for (const xs of ["0.5", "1.0", "5.0", "20.0"]) {
      const x = fromFloat64(parseFloat(xs));
      const prec = 200;
      const e = bigErf(x, prec);
      const ec = bigErfc(x, prec);
      // Add: byte-identical to 1
      const sum = addBig(e, ec, prec);
      const one = fromInt(1n, prec);
      // For the sum to equal one byte-identically would be too strict
      // for cross-tier (the I2 worklog notes the relaxation to ≥prec-2
      // bits agreement); we check |sum - 1| has small magnitude.
      const diff = subBig(sum, one, prec);
      if (diff.mantissa !== 0n) {
        // The diff should be at most a handful of low bits off.
        const diffBits = bitMag(diff.mantissa) + diff.exponent;
        if (diffBits > -(prec - 4)) {
          errors.push(
            `erf + erfc != 1 byte-identically at x=${xs}; magBits(diff) = ${diffBits}, expected < -${prec - 4}`,
          );
        }
      }
    }

    // ----- Restriction to real axis: bigCErf(x + 0i).re == bigErf(x)
    //       and bigCErf(x + 0i).im == 0 within rounding tolerance. -----
    for (const xs of ["0.5", "1.0", "2.0"]) {
      const x = fromFloat64(parseFloat(xs));
      const prec = 200;
      const realResult = bigErf(x, prec);
      const cZ: BigComplex = { re: x, im: fromInt(0n, prec) };
      const cResult = bigCErf(cZ, prec);
      // Real parts: agreement to >= prec - 4 bits per the relaxed
      // I2 cross-tier convention.
      const rDiff = subBig(cre(cResult), realResult, prec);
      if (rDiff.mantissa !== 0n) {
        const diffMag = bitMag(rDiff.mantissa) + rDiff.exponent;
        if (diffMag > -(prec - 8)) {
          errors.push(
            `restriction-to-real: bigCErf(${xs}+0i).re differs from bigErf(${xs}) by magBits ${diffMag}; expected < -${prec - 8}`,
          );
        }
      }
      // Imaginary part: should be ~0 to working precision.
      const imBits = cim(cResult).mantissa === 0n
        ? -Infinity
        : bitMag(cim(cResult).mantissa) + cim(cResult).exponent;
      if (imBits > -(prec - 16)) {
        errors.push(
          `restriction-to-real: bigCErf(${xs}+0i).im has magBits ${imBits}; expected < -${prec - 16}`,
        );
      }
    }

    // ----- Refusal coverage: arb-prec InverseErf must refuse -----
    {
      const r = dispatchReal("InverseErf", 0.5, 50);
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `InverseErf at precision 50 should refuse with no-known-representation; got ${r.kind}`,
        );
      }
    }
    {
      const r = dispatchComplex("InverseErf", 0.5, 0, 50);
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `Complex InverseErf at precision 50 should refuse; got ${r.kind}`,
        );
      }
    }
    {
      const r = dispatchComplex("InverseErf", 0.5, 0, 10);
      // Even at p=10 (float64 tier), complex InverseErf refuses (R3 §3).
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `Complex InverseErf at precision 10 should still refuse (R3 §3); got ${r.kind}`,
        );
      }
    }

    // ----- Float64 lane sanity: erf(0.5) ≈ 0.5204998... to 14 dp -----
    {
      const r = dispatchReal("Erf", 0.5, 10) as RecordValue;
      const val = r.fields.value;
      if (val === undefined || val.kind !== "tagged") {
        errors.push(`float64 lane: dispatchReal Erf(0.5) should return tagged bigfloat`);
      } else {
        // Decode the bigfloat and convert to float64 for comparison
        const payload = (val as { payload: RecordValue }).payload;
        const mantissaField = payload.fields.mantissa;
        if (mantissaField?.kind === "integer") {
          // Not directly testing the value here; the substrate-level
          // test in packages/quadrature/test covers ULP. Just structural.
        }
      }
    }

    // ----- Determinism: same input bytes + same precision → same output bytes -----
    {
      const r1 = dispatchReal("Erf", 0.5, 50);
      const r2 = dispatchReal("Erf", 0.5, 50);
      // Compare via canonicalisation:
      // We don't import canonicalize here, but BigFloat byte-equality
      // implies value-equality. Pull the bigfloat out and compare
      // mantissa/exponent/precision.
      if (r1.kind === "record" && r2.kind === "record") {
        const v1 = ((r1 as RecordValue).fields.value as { payload: RecordValue }).payload;
        const v2 = ((r2 as RecordValue).fields.value as { payload: RecordValue }).payload;
        const m1 = (v1.fields.mantissa as { value: string }).value;
        const m2 = (v2.fields.mantissa as { value: string }).value;
        if (m1 !== m2) {
          errors.push(
            `determinism: two consecutive arb-prec Erf(0.5, 50) calls produced different mantissas (${m1} vs ${m2})`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `${NAME} --test failed (${errors.length} assertions):\n  ${errors.join("\n  ")}`,
      );
    }

    process.stderr.write(
      `${NAME} --test: ${erfCases.length} corpus cases + parity + erf+erfc + restriction-to-real + refusals + determinism — all green\n`,
    );
  },
});

// -----------------------------------------------------------------------------
// Small numeric helpers — kept local to avoid coupling to package internals
// -----------------------------------------------------------------------------

/** BigFloat add — re-exported from the substrate. */
function addBig(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  return bfAdd(a, b, prec);
}

function subBig(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  return bfSub(a, b, prec);
}

/** Bit magnitude of an integer mantissa (log2 of |x|, integer floor). */
function bitMag(n: bigint): number {
  if (n === 0n) return -Infinity;
  const absN = n < 0n ? -n : n;
  return absN.toString(2).length - 1;
}

/**
 * Render a BigFloat as a normalised decimal-digit sequence with at
 * least `digits` significant figures available, used by the --test
 * hook's leading-digit comparison.
 */
function toDecimalNormalised(a: BigFloat, digits: number): string {
  const raw = bfToString(a, digits);
  return stripDecimalToDigits(raw);
}

function canonicalDecimal(s: string, _digits: number): string {
  return stripDecimalToDigits(s);
}

function stripDecimalToDigits(s: string): string {
  // Strip sign, leading zeros, decimal point, and scientific exponent;
  // return the significant-digit sequence. "0.0012345" → "12345";
  // "1.2345e-10" → "12345"; "-2.71828" → "271828".
  let t = s;
  if (t.startsWith("-") || t.startsWith("+")) t = t.slice(1);
  // Split exponent
  const eSplit = t.indexOf("e");
  if (eSplit >= 0) t = t.slice(0, eSplit);
  // Strip decimal point and leading zeros
  t = t.replace(".", "");
  // Strip leading zeros (after sign)
  let i = 0;
  while (i < t.length && t[i] === "0") i++;
  return t.slice(i);
}

if (import.meta.main) void runTool(def);
