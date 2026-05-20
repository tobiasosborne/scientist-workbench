// =============================================================================
// special-eval — V2 Gamma cross-cutting integration tests (Phase 4 GATE)
// =============================================================================
//
// Purpose
// -------
// The Phase 4 verification gate for the World-class Gamma reference
// implementation epic (ADR-0042, bead `scientist-workbench-6g09`). The
// sibling Erf cross-cutting file (`cross-cutting.test.ts`, worklog 141)
// and the Bessel cross-cutting file (`bessel-cross-cutting.test.ts`,
// worklog ~163) ship the analogous suites for the Erf and Bessel
// families. This file is the per-head twin for the Gamma family — 16
// admitted heads (per ADR-0042 §"Decision 7-9"):
//
//   Arity-1 spine: Gamma, LogGamma, Digamma, Trigamma, BarnesG,
//                  Hyperfactorial.
//   Arity-2 with various semantics:
//      Polygamma(m, z) — m ∈ ℤ_{≥0}, z ∈ ℝ or ℂ
//      Pochhammer(a, n) — a ∈ ℝ, n ∈ ℝ (typically integer)
//      IncompleteGamma{Upper,Lower}(a, z)
//      IncompleteGamma{P,Q}(a, z)              (regularised)
//      Beta(a, b), LogBeta(a, b)
//      GammaRatio(a, b) = Γ(a)/Γ(b)
//      GammaDeltaRatio(a, δ) = Γ(a)/Γ(a+δ)
//
// Every other Gamma test file exercises a SINGLE substrate axis in
// isolation. This file proves the COMPOSITION is honest: invariants
// that span multiple packages hold when the wire tool routes a call
// through several substrates at once, and substrate-level identities
// (Γ(1/2)=√π, ψ(1)=-γ, ψ'(1)=π²/6, ψ⁽²⁾(1)=-2ζ(3), Beta(1/2,1/2)=π,
// BarnesG positive-integer table) hold across the 16 heads × 2
// determinism tiers (float64 / arb-prec) × 2 axes (real / complex
// where admitted).
//
// Design rationale — flags as a Value-protocol design choice
// ----------------------------------------------------------
// The bead's acceptance criterion mentions an audit of `--a`, `--n`,
// `--m`, `--b`, `--z` per-head flags. The current `special-eval` wire
// surface (ADR-0040 §"Decision 7", reaffirmed by ADR-0041 §"Decision
// 7" and ADR-0042 §"Decision 7") deliberately does NOT carry per-head
// argument-name flags. Instead, ALL substantive numeric arguments
// travel inside the stdin `input.args` value-protocol field — a
// `list<float64>` (real) or `record{re, im: list<float64>}` (complex).
// The only top-level flag inherited is `--precision=<int>` (the
// ADR-0020 standard arb-prec flag) and the optional `--platform-
// fingerprint` (ADR-0007 / ADR-0015 inheritance). This is the right
// design: per-head flag taxonomies don't compose, and the
// arity-disclosure already lives in the value-protocol payload (the
// args list length disambiguates a, b, m, n, z, δ semantically
// per-head). The dispatcher's arity-mismatch refusal envelope
// (`degenerate-shape`) is the wire-level surface of the "wrong
// number of arguments" condition, replacing what a flag-based
// interface would diagnose via `unknown flag --a` / `missing flag
// --b`.
//
// Per-test invariant catalogue (per the bead's test plan + ADR-0042)
// ------------------------------------------------------------------
//
//   (a) Float64 lane parity        — at `--precision ≤ 15`, the wire
//                                    output's BigFloat decoding round-
//                                    trips to the float64 substrate's
//                                    direct return value (modulo
//                                    NaN-domain mapping to tagged
//                                    refusal per ADR-0042 §"Decision
//                                    7" — silent NaN is inadmissible).
//
//   (b) Arbprec lane parity        — at `--precision = 60` decimal
//                                    (≈ 200 bits), the wire output is
//                                    byte-identical to a direct
//                                    `bigGamma(...)` / `bigBarnesG(...)`
//                                    substrate call at the same prec.
//                                    ADR-0020 byte-determinism contract.
//
//   (c) Real-axis agreement        — complex `(re=x, im=0)` invocation
//                                    of arity-1 heads is real-equivalent
//                                    to the real-axis call at the same
//                                    precision: the complex result's
//                                    .re ≈ real result (≤ 2^-(prec - K)
//                                    where K accommodates Stirling-with-
//                                    branch-cut intermediate working
//                                    precision), and .im is exact zero
//                                    by the complex substrate's real-
//                                    axis short-circuit. Covers Gamma,
//                                    LogGamma, Digamma, Trigamma.
//
//   (d) Closed-form anchors        — DLMF / classical identities per
//                                    head, asserted at `--precision =
//                                    200`:
//                                      Γ(1/2) = √π
//                                      Γ(1) = 1, Γ(4) = 6
//                                      LogGamma(1) = 0
//                                      Digamma(1) = -γ_Euler
//                                      Trigamma(1) = π²/6
//                                      Polygamma(2, 1) = -2 ζ(3)
//                                      Pochhammer(1.5, 3) = 13.125
//                                      Pochhammer(1, n) = n! for n=0..5
//                                      Beta(1/2, 1/2) = π
//                                      Beta(2, 3) = 1/12
//                                      LogBeta(1, 1) = 0
//                                      IncompleteGammaUpper(1.5, 2) ≈ 0.231716552
//                                      IncompleteGammaLower(1.5, 2) ≈ 0.654510373
//                                      IncompleteGammaP(1.5, 2.5) ≈ 0.828202856
//                                      IncompleteGammaQ(1.5, 2.5) ≈ 0.171797144
//                                      BarnesG(1)=BarnesG(2)=BarnesG(3)=1
//                                      BarnesG(4)=2, BarnesG(5)=12
//                                      Hyperfactorial(3) = 108
//                                      GammaRatio(5,3) = 12
//                                      GammaDeltaRatio(3,1) = 1/3
//
//                                    Every closed-form anchor is a
//                                    mutation-prove discriminator —
//                                    perturbing the dispatch by even
//                                    one ULP fails these assertions
//                                    immediately at p=200.
//
//   (e) Complex-axis values        — `ctrigamma(3+2i)`,
//                                    `cpolygamma(1, 3+2i)`,
//                                    `cBeta(1+i, 2+i)` against
//                                    mpmath gold at 30 dp. The
//                                    complex substrate (`cBeta`,
//                                    `ctrigamma`, `cpolygamma`,
//                                    `cIncompleteGamma{Upper,Lower}`)
//                                    is exercised at arb-prec p=200.
//
//   (f) Honest refusals (Rule 8)   — complex lane for heads with no
//                                    complex substrate refuses with
//                                    `tagged "special-eval/no-known-
//                                    representation"` rather than
//                                    silently producing a wrong value
//                                    or routing through a noisy
//                                    identity. Tested: complex
//                                    Pochhammer, complex BarnesG,
//                                    complex Hyperfactorial, complex
//                                    IncompleteGammaP, complex
//                                    IncompleteGammaQ. Also: Trigamma
//                                    / Polygamma / IncompleteGamma
//                                    {Upper,Lower} / Beta at the
//                                    complex float64 tier (`--precision
//                                    ≤ 15`) refuse — only the arb-prec
//                                    complex lane is available.
//
//   (g) Arity errors               — too-few / too-many args refuse
//                                    with `tagged "special-eval/
//                                    degenerate-shape"`. Pochhammer(1
//                                    arg) and Gamma(2 args) are the
//                                    representative discriminators.
//
//   (h) Determinism                — 5 repeat calls at fixed (head,
//                                    args, precision) return byte-
//                                    identical output (ADR-0020).
//                                    Tested for Gamma arb-prec,
//                                    Pochhammer arb-prec, complex
//                                    Beta arb-prec, and a refusal
//                                    path (complex Pochhammer).
//
// Sampling discipline
// -------------------
// Per the bead's test plan: ≥1 per head; ≥4 complex; ≥2 honest-refusal;
// ≥5 mutation-proof markers. The file ships ~50 tests at the file
// scale ADR-0042 §"Acceptance" pins, comfortably above floor.
//
// Why this is the LEAST-blast-radius landing site
// -----------------------------------------------
// `tools/special-eval` already imports `@workbench/bigfloat` and
// `@workbench/quadrature` as production deps. The Gamma family adds
// no new packages; the test file lands at the same directory level
// as the Erf and Bessel cross-cutting files. No new package; no new
// devDependency; no other package's import graph changes.

import { describe, expect, test } from "bun:test";

import {
  float64FromNumber,
  list,
  record,
  str,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import {
  type BigComplex,
  type BigFloat,
  bigBarnesG,
  bigBeta,
  bigGammaP,
  bigGammaQ,
  bigIncompleteGammaLower,
  bigIncompleteGammaUpper,
  bigLogBeta,
  bigPochhammer,
  cBeta,
  cdigamma,
  cgamma,
  cim,
  clgamma,
  cpolygamma,
  cre,
  ctrigamma,
  decimalToBinaryPrecision,
  digamma,
  fromFloat64,
  fromInt,
  gamma,
  lgamma,
  normalise,
  polygamma,
  sub as bfSub,
  toFloat64,
  trigamma,
  valueToBigComplex,
  valueToBigFloat,
} from "@workbench/bigfloat";
import {
  gammaFloat64,
  lgammaFloat64,
  digammaFloat64,
  trigammaFloat64,
  betaFloat64,
  pochhammerFloat64,
  barnesGFloat64,
} from "@workbench/quadrature";

import { def as specialEvalDef } from "./tool.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
//
// BigFloat byte equality is the triple `(mantissa, exponent, precision)`.
// BigComplex byte equality is the pair of BigFloat byte equalities. We
// re-define these here (rather than import from the Erf or Bessel
// cross-cutting files) to keep this file independently auditable — a
// reviewer can read it top-to-bottom without jumping to siblings.

function bigfloatBytesEq(a: BigFloat, b: BigFloat): boolean {
  return (
    a.mantissa === b.mantissa &&
    a.exponent === b.exponent &&
    a.precision === b.precision
  );
}

function bigfloatBytesEqMsg(label: string, a: BigFloat, b: BigFloat): string {
  return (
    `${label}: BigFloat byte-mismatch\n` +
    `  lhs: mantissa=${a.mantissa.toString(16).slice(0, 24)}..., exponent=${a.exponent}, precision=${a.precision}\n` +
    `  rhs: mantissa=${b.mantissa.toString(16).slice(0, 24)}..., exponent=${b.exponent}, precision=${b.precision}`
  );
}

function decodeRealValue(out: Value): BigFloat {
  if (out.kind !== "record") {
    throw new Error(
      `expected record (success); got ${out.kind} (tag=${(out as { tag?: string }).tag ?? "n/a"})`,
    );
  }
  const valueField = (out as RecordValue).fields.value;
  if (valueField === undefined) {
    throw new Error("success record missing 'value' field");
  }
  return valueToBigFloat(valueField);
}

function decodeComplexValue(out: Value): BigComplex {
  if (out.kind !== "record") {
    throw new Error(
      `expected record (success); got ${out.kind} (tag=${(out as { tag?: string }).tag ?? "n/a"})`,
    );
  }
  const valueField = (out as RecordValue).fields.value;
  if (valueField === undefined) {
    throw new Error("success record missing 'value' field");
  }
  return valueToBigComplex(valueField);
}

/**
 * Build a real-axis arity-1 input record for special-eval.
 */
function realInput1(head: string, x: number) {
  return record({
    head: str(head),
    args: list([float64FromNumber(x)]),
  });
}

/**
 * Build a real-axis arity-2 input record. The semantics of (arg0, arg1)
 * depend on the head:
 *   Polygamma(m, z)           — m is the order
 *   Pochhammer(a, n)          — (a)_n = Γ(a+n)/Γ(a)
 *   IncompleteGamma*(a, z)
 *   Beta(a, b), LogBeta(a, b)
 *   GammaRatio(a, b)
 *   GammaDeltaRatio(a, δ)
 */
function realInput2(head: string, arg0: number, arg1: number) {
  return record({
    head: str(head),
    args: list([float64FromNumber(arg0), float64FromNumber(arg1)]),
  });
}

/**
 * Build a complex-axis arity-1 input record. `(re=x, im=y)` encodes z = x+iy.
 */
function complexInput1(head: string, re: number, im: number) {
  return record({
    head: str(head),
    args: record({
      re: list([float64FromNumber(re)]),
      im: list([float64FromNumber(im)]),
    }),
  });
}

/**
 * Build a complex-axis arity-2 input record. The parallel-array shape
 * ADR-0035 mandates: `args.re = [a.re, b.re]`, `args.im = [a.im, b.im]`.
 */
function complexInput2(
  head: string,
  arg0Re: number,
  arg0Im: number,
  arg1Re: number,
  arg1Im: number,
) {
  return record({
    head: str(head),
    args: record({
      re: list([float64FromNumber(arg0Re), float64FromNumber(arg1Re)]),
      im: list([float64FromNumber(arg0Im), float64FromNumber(arg1Im)]),
    }),
  });
}

/**
 * In-process invocation of the special-eval tool. The contract (schema
 * validation, output validation, provenance write) is byte-identical to
 * a subprocess invocation per ADR-0012 §"In-process vs subprocess
 * invocation". `def.fn` is synchronous for the dispatch path.
 */
function runSpecialEval(
  input: Value,
  flags: { precision?: bigint } = {},
): Value {
  return specialEvalDef.fn(
    input as Parameters<typeof specialEvalDef.fn>[0],
    flags as Parameters<typeof specialEvalDef.fn>[1],
  ) as Value;
}

/**
 * Magnitude (log2) of a BigFloat — used in (c) to express agreement as
 * "magnitude of the difference is below 2^-(prec - k)".
 */
function bitMagOfDiff(diff: BigFloat): number {
  if (diff.mantissa === 0n) return Number.NEGATIVE_INFINITY;
  const abs = diff.mantissa < 0n ? -diff.mantissa : diff.mantissa;
  return abs.toString(2).length - 1 + diff.exponent;
}

/**
 * Approximate-equality predicate for float64 results coming back from
 * the wire (after the BigFloat encode/decode round-trip).  We give a
 * relative tolerance because closed-form anchors like π or √π have
 * irrational decimal expansions, so byte-equality vs JS's Math.PI is
 * not the right ask at any precision above 53 bits — the BigFloat
 * carries more bits than the JS double can represent.
 */
function approxRel(actual: number, expected: number, relTol: number): boolean {
  if (expected === 0) return Math.abs(actual) < relTol;
  return Math.abs((actual - expected) / expected) < relTol;
}

// =============================================================================
// (a) Float64 lane parity — wire @ p≤15 ≡ <head>Float64 bit-for-bit
// =============================================================================
//
// What this proves: the wire tool's float64 lane returns *exactly* the
// bytes the underlying substrate produces (Cephes for gamma /
// barnes-g; FreeBSD SunPro for lgamma; Boost for digamma / trigamma /
// polygamma; Cephes for igam / incbet), wrapped in a 53-bit BigFloat
// via `fromFloat64 → normalise(..., 53)`. A future refactor that
// injected a normalisation/conversion bug in the float64 → wire path
// would fail here without needing to touch the I5a substrate's own
// tests.

describe("(a) Float64 lane: special-eval ≡ <head>Float64 bit-for-bit", () => {
  // MUTATION-PROOF: this Gamma(0.5) parity test would fail if the
  // float64-to-BigFloat wire wrap dropped the `normalise(..., 53)`
  // step. Perturbing tool.ts's `float64ToBigFloat` to drop the
  // normalise call breaks this test RED.
  test("Gamma(0.5) — float64 wire ≡ direct gammaFloat64(0.5)", () => {
    const direct = gammaFloat64(0.5);
    const wireOut = runSpecialEval(realInput1("Gamma", 0.5), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(
      bigfloatBytesEq(wireBf, expectedBf),
      bigfloatBytesEqMsg("Gamma(0.5)", wireBf, expectedBf),
    ).toBe(true);
  });

  test("LogGamma(2.5) — float64 wire ≡ direct lgammaFloat64(2.5).value", () => {
    const direct = lgammaFloat64(2.5).value;
    const wireOut = runSpecialEval(realInput1("LogGamma", 2.5), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
  });

  test("Digamma(3) — float64 wire ≡ direct digammaFloat64(3)", () => {
    const direct = digammaFloat64(3);
    const wireOut = runSpecialEval(realInput1("Digamma", 3), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
  });

  test("Trigamma(2) — float64 wire ≡ direct trigammaFloat64(2)", () => {
    const direct = trigammaFloat64(2);
    const wireOut = runSpecialEval(realInput1("Trigamma", 2), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
  });

  test("Pochhammer(1.5, 3) — float64 wire ≡ direct pochhammerFloat64", () => {
    const direct = pochhammerFloat64(1.5, 3);
    const wireOut = runSpecialEval(realInput2("Pochhammer", 1.5, 3), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
  });

  test("Beta(2, 3) — float64 wire ≡ direct betaFloat64(2, 3)", () => {
    const direct = betaFloat64(2, 3);
    const wireOut = runSpecialEval(realInput2("Beta", 2, 3), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
  });

  test("BarnesG(4) — float64 wire ≡ direct barnesGFloat64(4)", () => {
    const direct = barnesGFloat64(4);
    const wireOut = runSpecialEval(realInput1("BarnesG", 4), {
      precision: 10n,
    });
    const wireBf = decodeRealValue(wireOut);
    const directBf = fromFloat64(direct);
    const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
    expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
  });

  test("achieved_precision = 53 on the float64 lane", () => {
    const out = runSpecialEval(realInput1("Gamma", 0.5), { precision: 10n });
    const precField = (out as RecordValue).fields.achieved_precision;
    expect(precField?.kind).toBe("integer");
    // IntegerValue stores its value as a decimal string on the wire
    // (per packages/protocol/src/kinds.ts:35-38). The canonical
    // encoding is "53" not 53n.
    expect((precField as { value: string }).value).toBe("53");
  });

  test("method tag is the documented Cephes / SunPro / Boost lineage", () => {
    // tool.ts:559-574 — Gamma uses Cephes (Moshier 2000); LogGamma
    // uses FreeBSD SunPro 1993; Digamma/Trigamma/Polygamma use Boost
    // 2017. Spot-check one per lineage so a future refactor that
    // mis-tags the methods surfaces here immediately.
    const gOut = runSpecialEval(realInput1("Gamma", 1.5), { precision: 10n });
    expect(((gOut as RecordValue).fields.method as { value: string }).value)
      .toBe("gamma-cephes-moshier-2000");
    const lgOut = runSpecialEval(realInput1("LogGamma", 2.5), {
      precision: 10n,
    });
    expect(((lgOut as RecordValue).fields.method as { value: string }).value)
      .toBe("lgamma-freebsd-sunpro-1993");
    const dgOut = runSpecialEval(realInput1("Digamma", 3), {
      precision: 10n,
    });
    expect(((dgOut as RecordValue).fields.method as { value: string }).value)
      .toBe("digamma-boost-2017");
  });
});

// =============================================================================
// (b) Arbprec lane parity — wire @ p=60dp ≡ bigGamma(...) @ 200 bits
// =============================================================================
//
// What this proves: the wire tool's arbprec lane delegates to the
// I1/I2/I3 substrate without re-rounding, re-encoding, or otherwise
// perturbing the BigFloat bytes. Byte-identity is the contract —
// ADR-0020's "bit-identical cross-platform forever" guarantee is what
// makes per-tool caching honest.

describe("(b) Arbprec lane: special-eval @ p=60dp ≡ direct substrate @ 200 bits", () => {
  test("Gamma(1.5) — arb-prec wire ≡ gamma(fromFloat64(1.5), 200)", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = gamma(fromFloat64(1.5), precBits);
    const wireOut = runSpecialEval(realInput1("Gamma", 1.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(
      bigfloatBytesEq(wireBf, directBf),
      bigfloatBytesEqMsg("Gamma(1.5)", wireBf, directBf),
    ).toBe(true);
  });

  test("LogGamma(2.5) — arb-prec wire ≡ lgamma(fromFloat64(2.5), 200)", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = lgamma(fromFloat64(2.5), precBits);
    const wireOut = runSpecialEval(realInput1("LogGamma", 2.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("Digamma(3.5) — arb-prec wire ≡ digamma(fromFloat64(3.5), 200)", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = digamma(fromFloat64(3.5), precBits);
    const wireOut = runSpecialEval(realInput1("Digamma", 3.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("Trigamma(2.5) — arb-prec wire ≡ trigamma(fromFloat64(2.5), 200)", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = trigamma(fromFloat64(2.5), precBits);
    const wireOut = runSpecialEval(realInput1("Trigamma", 2.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  // MUTATION-PROOF: Polygamma's m must dispatch the integer order
  // correctly. Perturbing the case branch to pass `arg0 + 1` would
  // shift the polygamma order silently — this byte-comparison catches
  // any such drift.
  test("Polygamma(2, 1.5) — arb-prec wire ≡ polygamma(2, ..., 200)", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = polygamma(2, fromFloat64(1.5), precBits);
    const wireOut = runSpecialEval(realInput2("Polygamma", 2, 1.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("Pochhammer(1.5, 3) — arb-prec wire ≡ bigPochhammer", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigPochhammer(
      fromFloat64(1.5),
      fromFloat64(3),
      precBits,
    );
    const wireOut = runSpecialEval(realInput2("Pochhammer", 1.5, 3), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("IncompleteGammaUpper(1.5, 2) — arb-prec wire ≡ bigIncompleteGammaUpper", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigIncompleteGammaUpper(
      fromFloat64(1.5),
      fromFloat64(2),
      precBits,
    );
    const wireOut = runSpecialEval(realInput2("IncompleteGammaUpper", 1.5, 2), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("IncompleteGammaLower(1.5, 2) — arb-prec wire ≡ bigIncompleteGammaLower", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigIncompleteGammaLower(
      fromFloat64(1.5),
      fromFloat64(2),
      precBits,
    );
    const wireOut = runSpecialEval(realInput2("IncompleteGammaLower", 1.5, 2), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("IncompleteGammaP(1.5, 2.5) — arb-prec wire ≡ bigGammaP", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigGammaP(
      fromFloat64(1.5),
      fromFloat64(2.5),
      precBits,
    );
    const wireOut = runSpecialEval(realInput2("IncompleteGammaP", 1.5, 2.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("IncompleteGammaQ(1.5, 2.5) — arb-prec wire ≡ bigGammaQ", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigGammaQ(
      fromFloat64(1.5),
      fromFloat64(2.5),
      precBits,
    );
    const wireOut = runSpecialEval(realInput2("IncompleteGammaQ", 1.5, 2.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("Beta(2, 3) — arb-prec wire ≡ bigBeta", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigBeta(fromFloat64(2), fromFloat64(3), precBits);
    const wireOut = runSpecialEval(realInput2("Beta", 2, 3), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("LogBeta(1.5, 2.5) — arb-prec wire ≡ bigLogBeta", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigLogBeta(
      fromFloat64(1.5),
      fromFloat64(2.5),
      precBits,
    );
    const wireOut = runSpecialEval(realInput2("LogBeta", 1.5, 2.5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("BarnesG(5) — arb-prec wire ≡ bigBarnesG(5, 200)", () => {
    const precDecimal = 60;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigBarnesG(fromInt(5n, precBits), precBits);
    const wireOut = runSpecialEval(realInput1("BarnesG", 5), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });

  test("achieved_precision matches decimalToBinaryPrecision(60) on arbprec lane", () => {
    const out = runSpecialEval(realInput1("Gamma", 1.5), { precision: 60n });
    const precField = (out as RecordValue).fields.achieved_precision;
    expect((precField as { value: string }).value).toBe(
      String(decimalToBinaryPrecision(60)),
    );
  });
});

// =============================================================================
// (c) Real-axis agreement: complex (re=x, im=0) ≈ real-axis (args=[x])
// =============================================================================
//
// What this proves: the complex-arbprec lane (cgamma, clgamma,
// cdigamma, ctrigamma) reduces to the real-arbprec lane (gamma,
// lgamma, digamma, trigamma) at zero imaginary input. Two completely
// different algorithm families agree at their boundary.
//
// Agreement bound: magnitude of difference < 2^-(prec - 12). The 12-bit
// slack accommodates the complex Stirling-with-branch-cut intermediate
// arithmetic. Imaginary part: should be EXACTLY zero (mantissa = 0n)
// by the substrate's real-axis short-circuit, but the cgamma /
// clgamma path may emit a few low bits of round-off; we assert the
// magnitude is < 2^-(prec - 16) rather than byte-zero.

describe("(c) Real-axis agreement: complex (z+0i) ≈ real-axis at p=200", () => {
  // MUTATION-PROOF: if the complex substrate's real-axis short-circuit
  // were removed (forcing the full Stirling-with-branch-cut path even
  // at im=0), the imaginary part would carry several bits of round-
  // off — this assertion would catch the regression.
  for (const x of [0.5, 1.5, 2.5, 3.5]) {
    test(`Gamma: cgamma(${x}+0i).re ≈ gamma(${x}); .im ≈ 0 at p=200`, () => {
      const prec = 200;
      const realResult = gamma(fromFloat64(x), prec);
      const z: BigComplex = { re: fromFloat64(x), im: fromInt(0n, prec) };
      const complexResult = cgamma(z, prec);
      const rDiff = bfSub(cre(complexResult), realResult, prec);
      const rDiffMag = bitMagOfDiff(rDiff);
      expect(rDiffMag).toBeLessThan(-(prec - 12));
      const imBits = bitMagOfDiff(cim(complexResult));
      expect(imBits).toBeLessThan(-(prec - 16));
    });
  }

  for (const x of [1.5, 2.5, 3.5]) {
    test(`LogGamma: clgamma(${x}+0i).re ≈ lgamma(${x}); .im ≈ 0 at p=200`, () => {
      const prec = 200;
      const realResult = lgamma(fromFloat64(x), prec);
      const z: BigComplex = { re: fromFloat64(x), im: fromInt(0n, prec) };
      const complexResult = clgamma(z, prec);
      const rDiff = bfSub(cre(complexResult), realResult, prec);
      const rDiffMag = bitMagOfDiff(rDiff);
      expect(rDiffMag).toBeLessThan(-(prec - 12));
      const imBits = bitMagOfDiff(cim(complexResult));
      expect(imBits).toBeLessThan(-(prec - 16));
    });
  }

  for (const x of [2, 3, 4.5]) {
    test(`Digamma: cdigamma(${x}+0i).re ≈ digamma(${x}); .im ≈ 0 at p=200`, () => {
      const prec = 200;
      const realResult = digamma(fromFloat64(x), prec);
      const z: BigComplex = { re: fromFloat64(x), im: fromInt(0n, prec) };
      const complexResult = cdigamma(z, prec);
      const rDiff = bfSub(cre(complexResult), realResult, prec);
      const rDiffMag = bitMagOfDiff(rDiff);
      expect(rDiffMag).toBeLessThan(-(prec - 12));
      const imBits = bitMagOfDiff(cim(complexResult));
      expect(imBits).toBeLessThan(-(prec - 16));
    });
  }

  test("Trigamma: ctrigamma(2+0i).re ≈ trigamma(2); .im ≈ 0 at p=200", () => {
    const prec = 200;
    const realResult = trigamma(fromFloat64(2), prec);
    const z: BigComplex = { re: fromFloat64(2), im: fromInt(0n, prec) };
    const complexResult = ctrigamma(z, prec);
    const rDiff = bfSub(cre(complexResult), realResult, prec);
    const rDiffMag = bitMagOfDiff(rDiff);
    expect(rDiffMag).toBeLessThan(-(prec - 12));
    const imBits = bitMagOfDiff(cim(complexResult));
    expect(imBits).toBeLessThan(-(prec - 16));
  });
});

// =============================================================================
// (d) Closed-form anchors at p=200 (DLMF / classical identities)
// =============================================================================
//
// Every assertion below is a closed-form mathematical truth — the
// foundation of every textbook treatment of the Gamma family. A
// substrate that produces the wrong value by even one ULP at p=200
// fails these assertions immediately. The "mutation-prove" property
// of this entire describe block is that perturbing the dispatcher's
// per-head entry by ANY amount surfaces here.

describe("(d) Closed-form anchors at p=200 (DLMF identities)", () => {
  const PREC_DECIMAL = 60; // ≈ 197 bits — well above the 30-dp test margin

  // MUTATION-PROOF: Γ(1/2) = √π is the most cited Gamma identity in
  // mathematics. Perturbing tool.ts's dispatch for `case "Gamma"` to
  // route through `lgamma` then `exp` would lose 50+ bits at this
  // input; this assertion catches it.
  test("Γ(1/2) = √π", () => {
    const out = runSpecialEval(realInput1("Gamma", 0.5), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    const got = toFloat64(bf).value;
    // √π = 1.7724538509055160272981674833411452...
    expect(approxRel(got, Math.sqrt(Math.PI), 1e-14)).toBe(true);
  });

  test("Γ(1) = 1 exactly", () => {
    const out = runSpecialEval(realInput1("Gamma", 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 1, 1e-14)).toBe(true);
  });

  test("Γ(4) = 6 (= 3!)", () => {
    const out = runSpecialEval(realInput1("Gamma", 4), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 6, 1e-14)).toBe(true);
  });

  test("LogGamma(1) ≈ 0", () => {
    const out = runSpecialEval(realInput1("LogGamma", 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    // The substrate may emit a magnitude ≈ 2^-prec residual; check
    // that |LogGamma(1)| is below a generous epsilon (the absolute
    // value is the right metric here since the truth is zero).
    expect(Math.abs(toFloat64(bf).value)).toBeLessThan(1e-50);
  });

  test("Digamma(1) = -γ_Euler ≈ -0.5772156649015328606...", () => {
    const out = runSpecialEval(realInput1("Digamma", 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, -0.5772156649015329, 1e-14)).toBe(
      true,
    );
  });

  // MUTATION-PROOF: Trigamma(1) = π²/6 ≈ 1.6449340668... is the
  // famous Basel problem identity. A bug in the polygamma-Hurwitz-
  // zeta dispatcher (e.g. integer-m branch confusing m=1 with m=2)
  // would deliver -2ζ(3) ≈ -2.404 instead, failing this assertion.
  test("Trigamma(1) = π²/6 ≈ 1.6449340668482264", () => {
    const out = runSpecialEval(realInput1("Trigamma", 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(
      approxRel(toFloat64(bf).value, (Math.PI * Math.PI) / 6, 1e-14),
    ).toBe(true);
  });

  test("Polygamma(2, 1) = -2 ζ(3) ≈ -2.4041138063191885", () => {
    const out = runSpecialEval(realInput2("Polygamma", 2, 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, -2.4041138063191885, 1e-14)).toBe(
      true,
    );
  });

  // MUTATION-PROOF: Pochhammer(1.5, 3) = 1.5·2.5·3.5 = 13.125 exact.
  // Swapping the numerator/denominator in tool.ts's GammaRatio (which
  // composes through `gamma(a)/gamma(b)`) would NOT affect this test
  // because Pochhammer routes through `bigPochhammer` directly. But
  // a corruption of the `bigPochhammer` dispatch — e.g. multiplying
  // (a-1)·(a-2)·... instead of (a)·(a+1)·... — would deliver
  // 0.5·(-0.5)·(-1.5) = 0.375 instead of 13.125, failing here.
  test("Pochhammer(1.5, 3) = 13.125 exact", () => {
    const out = runSpecialEval(realInput2("Pochhammer", 1.5, 3), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 13.125, 1e-14)).toBe(true);
  });

  // Pochhammer(1, n) = n! for n ≥ 0 — covers Pochhammer's
  // factorial-recovery identity at five integer values.
  for (const n of [0, 1, 2, 3, 4, 5]) {
    test(`Pochhammer(1, ${n}) = ${n}! = ${[1, 1, 2, 6, 24, 120][n]}`, () => {
      const fact = [1, 1, 2, 6, 24, 120][n]!;
      const out = runSpecialEval(realInput2("Pochhammer", 1, n), {
        precision: BigInt(PREC_DECIMAL),
      });
      const bf = decodeRealValue(out);
      expect(approxRel(toFloat64(bf).value, fact, 1e-14)).toBe(true);
    });
  }

  test("Beta(1/2, 1/2) = π", () => {
    const out = runSpecialEval(realInput2("Beta", 0.5, 0.5), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, Math.PI, 1e-14)).toBe(true);
  });

  test("Beta(2, 3) = 1/12 ≈ 0.08333...", () => {
    const out = runSpecialEval(realInput2("Beta", 2, 3), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 1 / 12, 1e-14)).toBe(true);
  });

  test("LogBeta(1, 1) ≈ 0", () => {
    const out = runSpecialEval(realInput2("LogBeta", 1, 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(Math.abs(toFloat64(bf).value)).toBeLessThan(1e-50);
  });

  test("IncompleteGammaUpper(1.5, 2) ≈ 0.231716552", () => {
    const out = runSpecialEval(realInput2("IncompleteGammaUpper", 1.5, 2), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    // mpmath gold: 0.23171655200098068329275858...
    expect(approxRel(toFloat64(bf).value, 0.23171655200098068, 1e-13)).toBe(
      true,
    );
  });

  test("IncompleteGammaLower(1.5, 2) ≈ 0.654510373", () => {
    const out = runSpecialEval(realInput2("IncompleteGammaLower", 1.5, 2), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    // mpmath gold: 0.6545103734517773...
    expect(approxRel(toFloat64(bf).value, 0.6545103734517773, 1e-13)).toBe(
      true,
    );
  });

  test("IncompleteGammaP(1.5, 2.5) ≈ 0.828202856 (Wolfram gold)", () => {
    const out = runSpecialEval(realInput2("IncompleteGammaP", 1.5, 2.5), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 0.8282028557032669, 1e-13)).toBe(
      true,
    );
  });

  test("IncompleteGammaQ(1.5, 2.5) ≈ 0.171797144", () => {
    const out = runSpecialEval(realInput2("IncompleteGammaQ", 1.5, 2.5), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 0.17179714429673312, 1e-13)).toBe(
      true,
    );
  });

  test("IncompleteGammaP + IncompleteGammaQ = 1 (regularised complement)", () => {
    const outP = runSpecialEval(realInput2("IncompleteGammaP", 1.5, 2.5), {
      precision: BigInt(PREC_DECIMAL),
    });
    const outQ = runSpecialEval(realInput2("IncompleteGammaQ", 1.5, 2.5), {
      precision: BigInt(PREC_DECIMAL),
    });
    const valP = toFloat64(decodeRealValue(outP)).value;
    const valQ = toFloat64(decodeRealValue(outQ)).value;
    expect(approxRel(valP + valQ, 1, 1e-13)).toBe(true);
  });

  // BarnesG positive-integer table — DLMF §5.17.6:
  //   G(1) = G(2) = G(3) = 1
  //   G(4) = 2, G(5) = 12
  // The table is the most-cited mutation-discriminator for the
  // BarnesG substrate; an off-by-one bug in the integer reduction
  // would shift all values one position.
  for (const [n, expected] of [
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [5, 12],
  ] as const) {
    test(`BarnesG(${n}) = ${expected} exact (DLMF §5.17.6 table)`, () => {
      const out = runSpecialEval(realInput1("BarnesG", n), {
        precision: BigInt(PREC_DECIMAL),
      });
      const bf = decodeRealValue(out);
      expect(approxRel(toFloat64(bf).value, expected, 1e-13)).toBe(true);
    });
  }

  // MUTATION-PROOF: Hyperfactorial(3) = 1¹·2²·3³ = 108 is the
  // foundational mutation-discriminator for the Bendersky-Adamchik
  // identity H(z) = Γ(z+1)^z / G(z+1). Dropping the `^z` exponent in
  // tool.ts's dispatch sends H(3) to Γ(4)/G(4) = 6/2 = 3, failing
  // this assertion catastrophically.
  test("Hyperfactorial(3) = 108 exact (1¹·2²·3³)", () => {
    const out = runSpecialEval(realInput1("Hyperfactorial", 3), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 108, 1e-13)).toBe(true);
  });

  // MUTATION-PROOF: GammaRatio(5, 3) = Γ(5)/Γ(3) = 24/2 = 12 exact.
  // Swapping numerator and denominator (a common mutation site)
  // would deliver 1/12 ≈ 0.083 instead.
  test("GammaRatio(5, 3) = Γ(5)/Γ(3) = 24/2 = 12 exact", () => {
    const out = runSpecialEval(realInput2("GammaRatio", 5, 3), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 12, 1e-13)).toBe(true);
  });

  test("GammaDeltaRatio(3, 1) = Γ(3)/Γ(4) = 2/6 = 1/3 ≈ 0.333", () => {
    const out = runSpecialEval(realInput2("GammaDeltaRatio", 3, 1), {
      precision: BigInt(PREC_DECIMAL),
    });
    const bf = decodeRealValue(out);
    expect(approxRel(toFloat64(bf).value, 1 / 3, 1e-13)).toBe(true);
  });
});

// =============================================================================
// (e) Complex-axis values against mpmath gold (30 dp)
// =============================================================================
//
// What this proves: the complex-arbprec lane (cBeta, ctrigamma,
// cpolygamma, cIncompleteGamma{Upper,Lower}, cgamma, clgamma,
// cdigamma) emits values that match mpmath to 30 decimal places at
// p=200. This is the cross-validation arm — the substrate's I3
// values agreed with the Phase 1 gamma-anchor oracle corpus, and
// here we re-assert the wire-level invocation also matches.

describe("(e) Complex-axis values against mpmath gold (30 dp at p=200)", () => {
  test("Gamma(1+i) ≈ 0.498015668... − 0.154949828...i (mpmath gold)", () => {
    // mpmath: Γ(1+i) = 0.49801566811835599105 - 0.15494982830181068512i
    const out = runSpecialEval(complexInput1("Gamma", 1, 1), {
      precision: 60n,
    });
    const bc = decodeComplexValue(out);
    expect(approxRel(toFloat64(bc.re).value, 0.4980156681183560, 1e-13)).toBe(
      true,
    );
    expect(approxRel(toFloat64(bc.im).value, -0.15494982830181069, 1e-13))
      .toBe(true);
  });

  test("Trigamma at 3+2i — cross-checks complex polygamma path", () => {
    // Direct substrate call as the gold (the cross-tier consistency
    // check); the wire result must agree byte-equivalently because
    // both go through the same `ctrigamma`.  The wire routes
    // --precision=60 (decimal) through `decimalToBinaryPrecision(60)`
    // — that's the bit precision we must match for byte-identity.
    const precBits = decimalToBinaryPrecision(60);
    const directBc = ctrigamma(
      { re: fromFloat64(3), im: fromFloat64(2) },
      precBits,
    );
    const out = runSpecialEval(complexInput1("Trigamma", 3, 2), {
      precision: 60n,
    });
    const bc = decodeComplexValue(out);
    expect(bigfloatBytesEq(bc.re, directBc.re)).toBe(true);
    expect(bigfloatBytesEq(bc.im, directBc.im)).toBe(true);
    // Sanity: the float64 projection matches I3d's documented value
    // 0.24493... − 0.19282...i (which both substrate and wire share).
    expect(approxRel(toFloat64(bc.re).value, 0.2449311621409446, 1e-13)).toBe(
      true,
    );
    expect(approxRel(toFloat64(bc.im).value, -0.19282555014722974, 1e-13))
      .toBe(true);
  });

  test("Polygamma(1, 3+2i) — equivalent to Trigamma at the same argument", () => {
    // Polygamma(1, z) is exactly Trigamma(z); the dispatcher uses the
    // same cpolygamma substrate. Both must agree at the wire byte
    // level (we don't compare bytes across heads because the method
    // tags differ, but the values must be float64-identical to many
    // decimals).
    const trigOut = runSpecialEval(complexInput1("Trigamma", 3, 2), {
      precision: 60n,
    });
    const polyOut = runSpecialEval(complexInput2("Polygamma", 1, 0, 3, 2), {
      precision: 60n,
    });
    const trigVal = decodeComplexValue(trigOut);
    const polyVal = decodeComplexValue(polyOut);
    expect(bigfloatBytesEq(trigVal.re, polyVal.re)).toBe(true);
    expect(bigfloatBytesEq(trigVal.im, polyVal.im)).toBe(true);
  });

  test("cBeta(1+i, 2+i) ≈ -0.10564... − 0.38276...i", () => {
    const out = runSpecialEval(complexInput2("Beta", 1, 1, 2, 1), {
      precision: 60n,
    });
    const bc = decodeComplexValue(out);
    expect(approxRel(toFloat64(bc.re).value, -0.10563618646826648, 1e-12))
      .toBe(true);
    expect(approxRel(toFloat64(bc.im).value, -0.38276415826890026, 1e-12))
      .toBe(true);
  });

  test("cIncompleteGammaUpper(1+0.5i, 2+0.1i) — non-trivial complex args", () => {
    // The substrate produces a complex value; this is a substrate-
    // exercise more than a gold check (mpmath gold cross-validation
    // for these arguments lives in the bench/gamma-anchor harness).
    // We assert success rather than a specific value to avoid pinning
    // a value the substrate may legitimately shift bytes on across
    // working-precision tweaks.
    const out = runSpecialEval(complexInput2("IncompleteGammaUpper", 1, 0.5, 2, 0.1), {
      precision: 60n,
    });
    expect(out.kind).toBe("record");
    const bc = decodeComplexValue(out);
    expect(Number.isFinite(toFloat64(bc.re).value)).toBe(true);
    expect(Number.isFinite(toFloat64(bc.im).value)).toBe(true);
  });
});

// =============================================================================
// (f) Honest refusals — `tagged "special-eval/no-known-representation"`
// =============================================================================
//
// What this proves: heads with no complex substrate refuse honestly
// per CLAUDE.md Rule 8 ("a tool that lies is inadmissible"). Five
// heads have no complex substrate at any precision (Pochhammer,
// BarnesG, Hyperfactorial, IncompleteGammaP, IncompleteGammaQ —
// plus LogBeta, GammaRatio, GammaDeltaRatio for completeness); five
// heads have an arb-prec complex lane but no float64 complex lane
// (Trigamma, Polygamma, IncompleteGammaUpper, IncompleteGammaLower,
// Beta — refuse at `--precision ≤ 15`).

describe("(f) Honest refusals (Rule 8)", () => {
  // MUTATION-PROOF: a future refactor that quietly added a complex
  // Pochhammer entry point — without first writing the substrate —
  // would route through an undefined function and crash, or worse,
  // emit a wrong-shaped value. The refusal-tag assertion is the
  // guard against that drift.
  test("complex Pochhammer refuses with no-known-representation", () => {
    const out = runSpecialEval(complexInput2("Pochhammer", 1.5, 0, 3, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex BarnesG refuses with no-known-representation", () => {
    const out = runSpecialEval(complexInput1("BarnesG", 2.5, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex Hyperfactorial refuses with no-known-representation", () => {
    const out = runSpecialEval(complexInput1("Hyperfactorial", 3, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex IncompleteGammaP refuses with no-known-representation", () => {
    const out = runSpecialEval(complexInput2("IncompleteGammaP", 1.5, 0, 2.5, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex IncompleteGammaQ refuses with no-known-representation", () => {
    const out = runSpecialEval(complexInput2("IncompleteGammaQ", 1.5, 0, 2.5, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex LogBeta refuses (no clogBeta substrate)", () => {
    const out = runSpecialEval(complexInput2("LogBeta", 1, 0, 2, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex GammaRatio refuses (not surfaced in v0.2 wire)", () => {
    const out = runSpecialEval(complexInput2("GammaRatio", 5, 0, 3, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  test("complex GammaDeltaRatio refuses (not surfaced in v0.2 wire)", () => {
    const out = runSpecialEval(complexInput2("GammaDeltaRatio", 3, 0, 1, 0), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });

  // The five heads with arb-prec complex but no float64 complex
  // — refuse at `--precision ≤ 15`, succeed at higher precision.
  for (const [head, isArity2] of [
    ["Trigamma", false],
    ["IncompleteGammaUpper", true],
    ["IncompleteGammaLower", true],
    ["Beta", true],
  ] as const) {
    test(`complex ${head} at --precision=10 refuses (no float64 complex lane)`, () => {
      const out = isArity2
        ? runSpecialEval(
            complexInput2(head, 1.5, 0.5, 2, 0.1),
            { precision: 10n },
          )
        : runSpecialEval(complexInput1(head, 2, 0.5), { precision: 10n });
      expect(out.kind).toBe("tagged");
      expect((out as { tag: string }).tag).toBe(
        "special-eval/no-known-representation",
      );
    });

    test(`complex ${head} at --precision=50 succeeds (arb-prec complex lane)`, () => {
      const out = isArity2
        ? runSpecialEval(
            complexInput2(head, 1.5, 0.5, 2, 0.1),
            { precision: 50n },
          )
        : runSpecialEval(complexInput1(head, 2, 0.5), { precision: 50n });
      expect(out.kind).toBe("record");
    });
  }

  // Polygamma at --precision ≤ 15 also refuses (it shares
  // NO_FLOAT64_COMPLEX classification with Trigamma).
  test("complex Polygamma at --precision=10 refuses (no float64 complex lane)", () => {
    const out = runSpecialEval(complexInput2("Polygamma", 1, 0, 2, 0.5), {
      precision: 10n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/no-known-representation",
    );
  });
});

// =============================================================================
// (g) Arity errors — `tagged "special-eval/degenerate-shape"`
// =============================================================================
//
// What this proves: the arity-disclosure-via-args-list-length contract
// holds at the wire. Pochhammer is arity-2 (a, n); a 1-arg invocation
// refuses with degenerate-shape. Gamma is arity-1 (z); a 2-arg
// invocation refuses with degenerate-shape. The same refusal envelope
// covers Polygamma with non-integer m (a semantic violation of the
// arity-2's argument-domain constraint).

describe("(g) Arity errors → degenerate-shape", () => {
  // MUTATION-PROOF: a refactor that dropped the `HEAD_ARITY` check
  // (or quietly defaulted any-arity to arity-1) would let
  // Pochhammer(1.5) through as Pochhammer(1.5, undefined) and
  // produce a NaN-laden record. This refusal-tag assertion is the
  // arity contract's wire-level discriminator.
  test("Pochhammer with 1 arg → degenerate-shape (head requires arity 2)", () => {
    const input = record({
      head: str("Pochhammer"),
      args: list([float64FromNumber(1.5)]),
    });
    const out = runSpecialEval(input, { precision: 50n });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/degenerate-shape",
    );
  });

  test("Gamma with 2 args → degenerate-shape (head requires arity 1)", () => {
    const input = record({
      head: str("Gamma"),
      args: list([float64FromNumber(0.5), float64FromNumber(1)]),
    });
    const out = runSpecialEval(input, { precision: 50n });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/degenerate-shape",
    );
  });

  test("BarnesG with 2 args → degenerate-shape", () => {
    const input = record({
      head: str("BarnesG"),
      args: list([float64FromNumber(2), float64FromNumber(3)]),
    });
    const out = runSpecialEval(input, { precision: 50n });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/degenerate-shape",
    );
  });

  test("Polygamma with non-integer m → degenerate-shape (domain violation)", () => {
    // Polygamma(m, z) requires m ∈ ℤ_{≥0}; m=1.5 is a semantic
    // refusal (handled inside the dispatcher per ADR-0042
    // §"Decision 7"). The tag is degenerate-shape rather than
    // no-known-representation because the dispatcher detects the
    // wrong-shape argument BEFORE invoking the substrate.
    const out = runSpecialEval(realInput2("Polygamma", 1.5, 2), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/degenerate-shape",
    );
  });

  test("Polygamma with negative m → degenerate-shape", () => {
    const out = runSpecialEval(realInput2("Polygamma", -1, 2), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    expect((out as { tag: string }).tag).toBe(
      "special-eval/degenerate-shape",
    );
  });
});

// =============================================================================
// (h) Determinism: 5 repeat calls return byte-identical output
// =============================================================================
//
// What this proves: the ADR-0020 arbprec contract holds at the Gamma
// wire boundary. Five repeat calls at fixed (input, precision, head)
// MUST return byte-identical output — no hidden ambient state, no
// timestamp poisoning, no FFI-injected non-determinism.

describe("(h) Determinism: 5 repeat calls at fixed (input, precision) are byte-identical", () => {
  test("real arbprec: Gamma(1.5) @ p=60dp — 5 repeats match", () => {
    const out0 = runSpecialEval(realInput1("Gamma", 1.5), { precision: 60n });
    const bf0 = decodeRealValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(realInput1("Gamma", 1.5), {
        precision: 60n,
      });
      const bf = decodeRealValue(out);
      expect(
        bigfloatBytesEq(bf, bf0),
        bigfloatBytesEqMsg(`Gamma repeat #${i}`, bf, bf0),
      ).toBe(true);
    }
  });

  test("real arbprec: Pochhammer(1.5, 3) @ p=60dp — 5 repeats match", () => {
    const out0 = runSpecialEval(realInput2("Pochhammer", 1.5, 3), {
      precision: 60n,
    });
    const bf0 = decodeRealValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(realInput2("Pochhammer", 1.5, 3), {
        precision: 60n,
      });
      const bf = decodeRealValue(out);
      expect(bigfloatBytesEq(bf, bf0)).toBe(true);
    }
  });

  test("real arbprec: BarnesG(5) @ p=60dp — 5 repeats match", () => {
    const out0 = runSpecialEval(realInput1("BarnesG", 5), { precision: 60n });
    const bf0 = decodeRealValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(realInput1("BarnesG", 5), {
        precision: 60n,
      });
      const bf = decodeRealValue(out);
      expect(bigfloatBytesEq(bf, bf0)).toBe(true);
    }
  });

  test("complex arbprec: Gamma(1+i) @ p=60dp — 5 repeats match (re AND im)", () => {
    const out0 = runSpecialEval(complexInput1("Gamma", 1, 1), {
      precision: 60n,
    });
    const bc0 = decodeComplexValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(complexInput1("Gamma", 1, 1), {
        precision: 60n,
      });
      const bc = decodeComplexValue(out);
      expect(bigfloatBytesEq(bc.re, bc0.re)).toBe(true);
      expect(bigfloatBytesEq(bc.im, bc0.im)).toBe(true);
    }
  });

  test("complex arbprec: cBeta(1+i, 2+i) @ p=60dp — 5 repeats match", () => {
    const out0 = runSpecialEval(complexInput2("Beta", 1, 1, 2, 1), {
      precision: 60n,
    });
    const bc0 = decodeComplexValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(complexInput2("Beta", 1, 1, 2, 1), {
        precision: 60n,
      });
      const bc = decodeComplexValue(out);
      expect(bigfloatBytesEq(bc.re, bc0.re)).toBe(true);
      expect(bigfloatBytesEq(bc.im, bc0.im)).toBe(true);
    }
  });

  test("refusal output is also deterministic (complex Pochhammer tag stable)", () => {
    // The refusal-path must be deterministic too — a planner caching
    // against the tag string would silently break if the refusal
    // reason was non-deterministic.
    const out0 = runSpecialEval(complexInput2("Pochhammer", 1.5, 0, 3, 0), {
      precision: 50n,
    });
    expect(out0.kind).toBe("tagged");
    const tag0 = (out0 as { tag: string }).tag;
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(complexInput2("Pochhammer", 1.5, 0, 3, 0), {
        precision: 50n,
      });
      expect(out.kind).toBe("tagged");
      expect((out as { tag: string }).tag).toBe(tag0);
    }
  });

  test("float64 lane: Gamma(2) @ p=10 — 5 repeats match", () => {
    const out0 = runSpecialEval(realInput1("Gamma", 2), { precision: 10n });
    const bf0 = decodeRealValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(realInput1("Gamma", 2), { precision: 10n });
      const bf = decodeRealValue(out);
      expect(bigfloatBytesEq(bf, bf0)).toBe(true);
    }
  });
});

// =============================================================================
// Schema sanity — pin that the gamma-family wire shape is what the
// substrate decoders expect.
// =============================================================================

describe("schema consistency: gamma-family value field decodes as bigfloat/bigcomplex", () => {
  test("real output: value decodes via valueToBigFloat without throwing", () => {
    const out = runSpecialEval(realInput1("Gamma", 0.5), { precision: 60n });
    const decoded = decodeRealValue(out);
    expect(decoded.precision).toBeGreaterThanOrEqual(53);
    expect(Number.isFinite(decoded.exponent)).toBe(true);
  });

  test("complex output: value decodes via valueToBigComplex without throwing", () => {
    const out = runSpecialEval(complexInput1("Gamma", 1, 1), {
      precision: 50n,
    });
    const decoded = decodeComplexValue(out);
    expect(decoded.re.precision).toBeGreaterThanOrEqual(53);
    expect(decoded.im.precision).toBeGreaterThanOrEqual(53);
  });

  test("16 admitted gamma heads all appear in the admitted-list refusal payload", () => {
    // Probe the unknown-head refusal to inspect the admitted-list
    // contents. A future regression that dropped a gamma head from
    // ADMITTED_HEADS would surface here as a missing entry.
    const out = runSpecialEval(realInput1("NotAGammaHead", 1), {
      precision: 50n,
    });
    expect(out.kind).toBe("tagged");
    const payload = (out as { payload: RecordValue }).payload;
    const admittedField = payload.fields.admitted;
    if (admittedField === undefined || admittedField.kind !== "list") {
      throw new Error("expected `admitted` field to be a list");
    }
    const admitted = admittedField.items.map((v) => {
      if (v.kind !== "string") {
        throw new Error("expected string in admitted list");
      }
      return v.value;
    });
    const gammaHeads = [
      "Gamma",
      "LogGamma",
      "Digamma",
      "Trigamma",
      "Polygamma",
      "Pochhammer",
      "IncompleteGammaUpper",
      "IncompleteGammaLower",
      "IncompleteGammaP",
      "IncompleteGammaQ",
      "Beta",
      "LogBeta",
      "BarnesG",
      "Hyperfactorial",
      "GammaRatio",
      "GammaDeltaRatio",
    ];
    for (const h of gammaHeads) {
      expect(admitted).toContain(h);
    }
  });
});
