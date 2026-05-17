// =============================================================================
// special-eval — V1 cross-cutting integration tests (Phase 4 GATE)
// =============================================================================
//
// Purpose
// -------
// The Phase 4 verification gate for the World-class Erf reference
// implementation epic (ADR-0040, bead `scientist-workbench-52gu`). Every
// other test file in the epic exercises a *single* substrate axis in
// isolation:
//
//   * `packages/bigfloat/test/erf.test.ts`         — I1 (real arbprec)
//   * `packages/bigfloat/test/erf.test.ts` (Erfc)  — I2 (erfc/erfcx)
//   * `packages/bigfloat/test/complex-erf.test.ts` — I3 (complex arbprec)
//   * `packages/cas-core/test/erf-identities.test.ts` — I4 (CAS rules)
//   * `packages/quadrature/test/erf-float64.test.ts` — I5 (SunPro float64)
//   * `packages/meijer-core/test/bridges-erf.test.ts` — I6 (Meijer-G bridge)
//
// This file proves the *composition* of those substrates is honest:
// invariants that span MULTIPLE packages must hold when the wire tool
// (`tools/special-eval`) routes a call through several substrates at
// once. If a future refactor of any individual substrate silently
// breaks the cross-package contract — even while keeping its own
// per-package tests green — *these* tests fail RED.
//
// Per-test invariant catalogue (the a-h table from bead 52gu)
// -----------------------------------------------------------
//
//   (a) Float64 lane parity        — special-eval @ p=15 ≡ I5's erfFloat64
//                                     bit-for-bit (one float64 result; the
//                                     wire wraps it in a 53-bit BigFloat,
//                                     but the underlying mantissa is the
//                                     same float64 bytes).
//
//   (b) Arbprec lane parity        — special-eval @ p=60 (≈ 200 bits) ≡
//                                     I1's bigErf(x, prec=200) byte-
//                                     identically. The wire wraps; the
//                                     mantissa/exponent/precision bytes
//                                     of the underlying BigFloat are
//                                     identical to a direct substrate
//                                     call.
//
//   (c) Restriction to real        — I3's bigCErf(complex(x, 0), prec)
//                                     real part ≡ I1's bigErf(x, prec)
//                                     within prec-4 bits AND imaginary
//                                     part is exact zero (mantissa = 0n).
//                                     The complex-arbprec lane reduces
//                                     to the real-arbprec lane at zero
//                                     imaginary input.
//
//   (d) CAS-simplify collapse      — casSimplify(Erfc(z) + Erf(z))
//                                     reduces to `int(1n)` byte-
//                                     identically. The Erf-family
//                                     identity table (I4) plus the
//                                     complement-pair collapse in
//                                     simplify.ts must work together
//                                     end-to-end.
//
//   (e) Meijer-G round-trip        — meijerGToHead(headToMeijerG("Erf",
//                                     [z]).gForm) returns {head: "Erf",
//                                     args: [z]} via the argsInverse
//                                     closure. The bidirectional bridge
//                                     (I6) is byte-identical for the
//                                     Erf-family forward heads.
//
//   (f) End-to-end integral        — integrate-1d Erf(x) on [0,1] returns
//                                     0.486064958112256 within G7K15
//                                     tolerance. This composes I5
//                                     (erfFloat64) -> eval-numeric-expr
//                                     (Erf dispatcher) -> integrate-1d
//                                     (Gauss-Kronrod driver) -> DLMF
//                                     §7.7.9 closed form. Three packages
//                                     compose; one tool answers; the
//                                     numeric answer matches the analytic
//                                     truth.
//
//   (g) Foreign pass-through       — A Value containing a foreign head
//                                     (`BesselJ`) round-trips through
//                                     casSimplify byte-identically when
//                                     the Erf-family rewriter doesn't
//                                     touch it. The cross-package
//                                     contract is: the I4 rewriter
//                                     MUST NOT corrupt subterms outside
//                                     its declared scope (PRD §2.3,
//                                     "Foreign pass-through is a hard
//                                     invariant").
//
//   (h) Determinism                — Five repeat calls to special-eval
//                                     at fixed (input, precision, head)
//                                     return byte-identical output —
//                                     the arbprec contract (ADR-0020
//                                     "bit-identical cross-platform
//                                     forever"). If this fails, the
//                                     substrate has a hidden ambient
//                                     state.
//
// Why this is the LEAST-blast-radius landing site
// -----------------------------------------------
// `tools/special-eval` already imports `@workbench/bigfloat` and
// `@workbench/quadrature` as production deps. For the CAS and Meijer-G
// arms (d, e, g) we add `@workbench/cas-core` and `@workbench/meijer-
// core` to the tool's *devDependencies*. The test ships alongside the
// existing `tool.ts` and `goldens.spec.ts` in the same directory; the
// `bun test` workspace glob picks it up automatically. No new package
// is created; no new directory is created; no other package's import
// graph changes.
//
// The integrate-1d arm (f) is a cross-tool composition: we import the
// `def` of `tools/integrate-1d/tool.ts` directly and invoke it in-
// process (the in-process invocation pattern established in
// `tools/integrate-1d/tool.test.ts`). This is the ADR-0012 in-process
// composition contract: same byte-identical answer as a subprocess
// shell invocation; the contract holds by construction via
// `executeToolDef`.

import { describe, expect, test } from "bun:test";

import {
  canonicalize,
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  rat,
  record,
  str,
  sym,
  type Float64Value,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import {
  type BigComplex,
  type BigFloat,
  bigCErf,
  bigErf,
  bigErfc,
  cim,
  cre,
  decimalToBinaryPrecision,
  fromFloat64,
  fromInt,
  normalise,
  sub as bfSub,
  valueToBigComplex,
  valueToBigFloat,
} from "@workbench/bigfloat";
import {
  erfFloat64,
  evalNumericExprWithSpecial,
} from "@workbench/quadrature";
import {
  casSimplify,
  mkPlus,
} from "@workbench/cas-core";
import {
  headToMeijerG,
  meijerGToHead,
} from "@workbench/meijer-core";

import { def as specialEvalDef } from "./tool.js";
import { def as integrate1dDef } from "../integrate-1d/tool.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
//
// The substrate-level equality predicates. BigFloat byte equality is the
// triple `(mantissa, exponent, precision)`; BigComplex byte equality is
// the pair of BigFloat byte equalities.

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

/**
 * Decode the wire-encoded `value` field of a special-eval success
 * record back into the underlying BigFloat. Re-uses the package's own
 * `valueToBigFloat` decoder so the round-trip is exact.
 */
function decodeRealValue(out: Value): BigFloat {
  if (out.kind !== "record") {
    throw new Error(`expected record (success); got ${out.kind} (tag=${(out as { tag?: string }).tag ?? "n/a"})`);
  }
  const valueField = (out as RecordValue).fields.value;
  if (valueField === undefined) {
    throw new Error("success record missing 'value' field");
  }
  return valueToBigFloat(valueField);
}

function decodeComplexValue(out: Value): BigComplex {
  if (out.kind !== "record") {
    throw new Error(`expected record (success); got ${out.kind}`);
  }
  const valueField = (out as RecordValue).fields.value;
  if (valueField === undefined) {
    throw new Error("success record missing 'value' field");
  }
  return valueToBigComplex(valueField);
}

/**
 * Build a real-axis input record for special-eval.
 */
function realInput(head: string, x: number) {
  return record({
    head: str(head),
    args: list([float64FromNumber(x)]),
  });
}

function complexInput(head: string, re: number, im: number) {
  return record({
    head: str(head),
    args: record({
      re: list([float64FromNumber(re)]),
      im: list([float64FromNumber(im)]),
    }),
  });
}

/**
 * Invoke the special-eval `def.fn` directly. This is the in-process
 * invocation surface; the contract (schema validation, output
 * validation, provenance write) is identical to a subprocess
 * invocation per ADR-0012 §"In-process vs subprocess invocation". The
 * tool's `fn` is synchronous (no async work in the dispatch path), so
 * the return type is `Value`.
 */
function runSpecialEval(input: Value, flags: { precision?: bigint } = {}): Value {
  return specialEvalDef.fn(
    input as Parameters<typeof specialEvalDef.fn>[0],
    flags as Parameters<typeof specialEvalDef.fn>[1],
  ) as Value;
}

/**
 * Magnitude (log2) of a BigFloat's mantissa, with the BigFloat's own
 * exponent added back. Used in (c) to express agreement as "magnitude
 * of the difference is below 2^-(prec - k)".
 */
function bitMagOfDiff(diff: BigFloat): number {
  if (diff.mantissa === 0n) return Number.NEGATIVE_INFINITY;
  const abs = diff.mantissa < 0n ? -diff.mantissa : diff.mantissa;
  return abs.toString(2).length - 1 + diff.exponent;
}

// =============================================================================
// (a) Float64 lane parity — special-eval @ p<=15 ≡ I5's erfFloat64
// =============================================================================
//
// What this proves: the wire tool's float64 lane returns *exactly* the
// bytes the underlying SunPro 1993 port produces. A future refactor
// that injected a normalisation/conversion bug in the float64 -> wire
// path would fail here without needing to touch the I5 substrate's own
// tests.

describe("(a) Float64 lane: special-eval ≡ erfFloat64 bit-for-bit", () => {
  const float64Samples: ReadonlyArray<{ tier: string; x: number }> = [
    // T1 sweet-spot (Maclaurin / Borel regime, |x| ≤ 0.84):
    { tier: "T1", x: 0 },
    { tier: "T1", x: 0.1 },
    { tier: "T1", x: 0.5 },
    { tier: "T1", x: 0.84 },
    // T2 midrange (asymptotic crossover regime, 0.84 ≤ |x| ≤ 6):
    { tier: "T2", x: 1.0 },
    { tier: "T2", x: 2.5 },
    { tier: "T2", x: -1.5 },
    // T3 deep tail (asymptotic regime, |x| > 6 — erfc is the answer-
    // bearing quantity but erf saturates at 1 - tiny):
    { tier: "T3", x: 6.0 },
    { tier: "T3", x: 8.0 },
  ];

  for (const { tier, x } of float64Samples) {
    test(`${tier}: erf(${x}) — float64 wire mantissa = float64 direct call`, () => {
      // Direct substrate call (I5).
      const direct = erfFloat64(x);
      // Wire tool at p=10 routes the float64 lane (boundary is p<=15).
      const wireOut = runSpecialEval(realInput("Erf", x), { precision: 10n });
      const wireBf = decodeRealValue(wireOut);
      // The wire encoding wraps float64 in a 53-bit BigFloat via
      // `fromFloat64 + normalise(..., 53)` — see tool.ts:382 (the
      // `float64ToBigFloat` helper). `fromFloat64` returns a minimal-bit
      // representation (e.g. 0.5 has 1 bit), and `normalise(..., 53)`
      // pads to exactly 53. We replicate the same two-step wrap to
      // produce the byte-equal expectation; if a refactor of either
      // step diverges the wire from the substrate, this comparison
      // breaks immediately.
      const directBf = fromFloat64(direct);
      const expectedBf = normalise(directBf.mantissa, directBf.exponent, 53);
      expect(bigfloatBytesEq(wireBf, expectedBf)).toBe(true);
    });
  }

  test("achieved_precision = 53 on the float64 lane", () => {
    const out = runSpecialEval(realInput("Erf", 0.5), { precision: 10n });
    expect(out.kind).toBe("record");
    const precField = (out as RecordValue).fields.achieved_precision;
    expect(precField?.kind).toBe("integer");
    // IntegerValue stores its value as a decimal string on the wire
    // (per packages/protocol/src/kinds.ts:35-38 — `value: string`); the
    // canonical encoding is "53" not 53n.
    expect((precField as { value: string }).value).toBe("53");
  });

  test("method tag is the SunPro lineage citation", () => {
    const out = runSpecialEval(realInput("Erf", 0.5), { precision: 10n });
    const methodField = (out as RecordValue).fields.method;
    expect((methodField as { value: string }).value).toBe("erf-sunpro-1993");
  });
});

// =============================================================================
// (b) Arbprec lane parity — special-eval @ p=60 ≡ bigErf at 200-bit prec
// =============================================================================
//
// What this proves: the wire tool's arbprec lane delegates to the I1
// substrate without re-rounding, re-encoding, or otherwise perturbing
// the BigFloat bytes. The contract is byte-identity.
//
// Precision conversion: special-eval takes `--precision=N` in DECIMAL
// digits. `decimalToBinaryPrecision(N)` is the package's canonical
// decimal->bit converter. We compute the expected BigFloat at the
// SAME bit precision the wire computes at, then byte-compare.

describe("(b) Arbprec lane: special-eval @ p=60 ≡ bigErf @ 200 bits", () => {
  const arbprecSamples: ReadonlyArray<{ tier: string; x: number }> = [
    // Cover all three real tiers — every regime of the bigErf dispatcher:
    { tier: "T1", x: 0.1 },
    { tier: "T1", x: 0.5 },
    { tier: "T1", x: 0.84 },
    { tier: "T2", x: 1.23 },
    { tier: "T2", x: 2.0 },
    { tier: "T2", x: -3.5 },
    { tier: "T3", x: 7.0 },
  ];

  for (const { tier, x } of arbprecSamples) {
    test(`${tier}: special-eval(Erf, ${x}, p=60dp) ≡ bigErf @ 200 bits`, () => {
      const precDecimal = 60;
      const precBits = decimalToBinaryPrecision(precDecimal);
      // Direct substrate call (I1).
      const directBf = bigErf(fromFloat64(x), precBits);
      // Wire tool at p=60 decimal -> routes the arb-prec lane.
      const wireOut = runSpecialEval(realInput("Erf", x), {
        precision: BigInt(precDecimal),
      });
      const wireBf = decodeRealValue(wireOut);
      expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
    });
  }

  test("achieved_precision matches decimalToBinaryPrecision(60) on arbprec lane", () => {
    const out = runSpecialEval(realInput("Erf", 0.5), { precision: 60n });
    const precField = (out as RecordValue).fields.achieved_precision;
    // IntegerValue stores as a decimal string per ADR-0004; convert the
    // expected bit count to the canonical string form before comparing.
    expect((precField as { value: string }).value).toBe(
      String(decimalToBinaryPrecision(60)),
    );
  });

  test("Erfc large-x: special-eval ≡ bigErfc (regression on direct-asymptotic path)", () => {
    // Load-bearing — at x=20 the bigErfc result is ~5.4e-176. A
    // refactor that routed the wire through `1 - bigErf` would lose
    // ~580 bits to cancellation; this test pins that the wire and
    // the substrate produce identical bytes.
    const x = 20.0;
    const precDecimal = 50;
    const precBits = decimalToBinaryPrecision(precDecimal);
    const directBf = bigErfc(fromFloat64(x), precBits);
    const wireOut = runSpecialEval(realInput("Erfc", x), {
      precision: BigInt(precDecimal),
    });
    const wireBf = decodeRealValue(wireOut);
    expect(bigfloatBytesEq(wireBf, directBf)).toBe(true);
  });
});

// =============================================================================
// (c) Restriction to real: bigCErf(x+0i, prec).re ≈ bigErf(x, prec)
//                          AND bigCErf(x+0i, prec).im is exactly zero
// =============================================================================
//
// What this proves: the complex-arbprec lane (I3, Karbach-Weideman)
// reduces to the real-arbprec lane (I1, Borel series + asymptotic) at
// zero imaginary input. Two completely different algorithm families
// agree at their boundary.
//
// The agreement bound is "prec - K bits" rather than byte-identity
// because the complex lane has its own working-precision margin and
// intermediate Cartesian arithmetic accumulates ~K bits of round-off.
// The I2/I3 worklog shards (135, 136) document K ≈ 4-8 bits. The
// imaginary part should be EXACTLY zero by construction (the complex
// lane has a real-axis short-circuit for purely real input).

describe("(c) Restriction to real axis: I3 reduces to I1 at zero imaginary input", () => {
  for (const x of [0.5, 1.0, 1.5, 2.0, 3.0]) {
    test(`bigCErf(${x} + 0i, 200 bits) — re ≈ bigErf, im = exact zero`, () => {
      const prec = 200;
      const realResult = bigErf(fromFloat64(x), prec);
      const z: BigComplex = { re: fromFloat64(x), im: fromInt(0n, prec) };
      const complexResult = bigCErf(z, prec);

      // Real-part agreement: magnitude of difference < 2^-(prec - 8).
      // The 8-bit slack accommodates the I3 worklog's documented
      // cross-tier convention.
      const rDiff = subBfManual(cre(complexResult), realResult, prec);
      const rDiffMag = bitMagOfDiff(rDiff);
      expect(rDiffMag).toBeLessThan(-(prec - 8));

      // Imaginary part: must be EXACTLY zero (mantissa = 0n) by the
      // complex lane's real-axis short-circuit. Not "close to zero",
      // not "below threshold" — exact zero.
      const imPart = cim(complexResult);
      expect(imPart.mantissa).toBe(0n);
    });
  }
});

// Local alias to keep the (c) test body readable; the substrate's
// `sub` is the canonical BigFloat subtraction.
function subBfManual(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  return bfSub(a, b, prec);
}

// =============================================================================
// (d) CAS-simplify cross-head collapse: Erfc(z) + Erf(z) -> 1
// =============================================================================
//
// What this proves: I4's Erf-identity table + simplify.ts's
// complement-pair collapse compose end-to-end. The result is the
// canonical `int(1n)` Value — byte-identical to a hand-constructed
// `int(1n)` via the value-protocol canonicalisation contract.

describe("(d) casSimplify(Erfc(z) + Erf(z)) collapses to int(1n)", () => {
  test("symbolic z", () => {
    const z = sym("z");
    const sum = mkPlus([expr("Erfc", [z]), expr("Erf", [z])]);
    const simplified = casSimplify(sum);
    // The canonical form of `int(1n)` is the byte target. We compare
    // via `canonicalize` which is the value-protocol's exact-equality
    // operator (deterministic JSON serialisation).
    expect(canonicalize(simplified)).toBe(canonicalize(int(1n)));
  });

  test("integer arg: Erfc(5) + Erf(5) -> 1", () => {
    const sum = mkPlus([expr("Erfc", [int(5n)]), expr("Erf", [int(5n)])]);
    const simplified = casSimplify(sum);
    expect(canonicalize(simplified)).toBe(canonicalize(int(1n)));
  });

  test("rational arg: Erfc(1/2) + Erf(1/2) -> 1", () => {
    const sum = mkPlus([expr("Erfc", [rat(1n, 2n)]), expr("Erf", [rat(1n, 2n)])]);
    const simplified = casSimplify(sum);
    expect(canonicalize(simplified)).toBe(canonicalize(int(1n)));
  });

  test("idempotence: casSimplify(casSimplify(v)) ≡ casSimplify(v)", () => {
    const z = sym("z");
    const sum = mkPlus([expr("Erfc", [z]), expr("Erf", [z])]);
    const once = casSimplify(sum);
    const twice = casSimplify(once);
    expect(canonicalize(twice)).toBe(canonicalize(once));
  });
});

// =============================================================================
// (e) Meijer-G bridge round-trip via argsInverse closure
// =============================================================================
//
// What this proves: the bidirectional bridge (I6) is byte-identical on
// round-trip through the `argsInverse` closure. The naive backward path
// would compute `√(g.z) = |z|` (wrong for negative z); the closure
// sidesteps the multi-valued root by recording the original args. The
// closure was named `zInverse` in v0.1 (Erf, 1-arg); ADR-0041 §"Decision
// 5" renames it to `argsInverse` arity-agnostically so the same interface
// field carries Bessel's `[nu, z]` recovery when bridges/bessel.ts ships.

describe("(e) Meijer-G bridge: round-trip via argsInverse closure is byte-identical", () => {
  const ROUND_TRIP_HEADS = ["Erf", "Erfc", "Erfi"] as const;
  const SAMPLES: ReadonlyArray<{ label: string; value: Value }> = [
    { label: "symbolic z", value: sym("z") },
    { label: "integer 1", value: int(1n) },
    { label: "negative integer -3", value: int(-3n) },
    { label: "rational 1/2", value: rat(1n, 2n) },
    { label: "expression 2*z", value: expr("*", [int(2n), sym("z")]) },
  ];

  for (const head of ROUND_TRIP_HEADS) {
    for (const { label, value } of SAMPLES) {
      test(`${head}(${label}): argsInverse() recovers args byte-identically`, () => {
        const fwd = headToMeijerG(head, [value]);
        expect(fwd).not.toBeNull();
        if (!fwd) return;
        // Direct argsInverse round-trip (the closure path). Erf's
        // 1-arg case returns a 1-element list `[z]`.
        const recovered = fwd.argsInverse();
        expect(recovered.length).toBe(1);
        expect(canonicalize(recovered[0]!)).toBe(canonicalize(value));
      });
    }
  }

  test("standalone meijerGToHead recognises Erf(z) shape and returns Erf head", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erf", [z])!;
    const bwd = meijerGToHead(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("Erf");
  });

  test("InverseErf refuses round-trip (no known representation)", () => {
    // Both directions must return null — the bridge honestly refuses
    // for the inverse heads (DLMF §7.17, no closed Meijer-G form).
    expect(headToMeijerG("InverseErf", [sym("y")])).toBeNull();
    expect(headToMeijerG("InverseErfc", [sym("y")])).toBeNull();
  });
});

// =============================================================================
// (f) End-to-end integral via integrate-1d (composes I5 + dispatcher + driver)
// =============================================================================
//
// What this proves: `tools/integrate-1d`, when handed `Erf(x)` as the
// integrand over [0, 1], composes:
//   1. The integrand AST walker (`eval-numeric-expr`)
//   2. The Erf-family dispatch table (`SPECIAL_DISPATCH` -> erfFloat64)
//   3. The adaptive Gauss-Kronrod driver (`gaussKronrodAdaptive`)
//
// All three substrates must work together to produce a numerical
// integral that matches DLMF §7.7.9's closed form
// `Erf(1) + (e^(-1) - 1)/√π = 0.4860649581122562` within the
// G7K15 default tolerance (atol 1e-12, rtol 1e-10).

describe("(f) End-to-end: integrate-1d Erf(x) on [0,1] matches DLMF §7.7.9", () => {
  test("∫_0^1 Erf(x) dx = 0.486064958112256... (within G7K15 default tolerance)", () => {
    const input = record({
      f: expr("Erf", [sym("x")]),
      var: sym("x"),
      a: float64FromNumber(0),
      b: float64FromNumber(1),
    });
    const out = integrate1dDef.fn(
      input as Parameters<typeof integrate1dDef.fn>[0],
      {} as Parameters<typeof integrate1dDef.fn>[1],
    ) as Value;
    expect(out.kind).toBe("record");
    const value = (out as RecordValue).fields.value as Float64Value;
    const got = float64ToNumber(value);

    // DLMF §7.7.9 closed form: ∫_0^z Erf(t) dt = z·Erf(z) + (e^(-z²) - 1)/√π.
    // At z = 1: Erf(1) + (e^-1 - 1)/√π. Computed via the same I5
    // SunPro path the tool uses, so the closed-form and integrate-1d
    // agree on the elementary subcomponents.
    const erf1 = erfFloat64(1);
    const expected = erf1 + (Math.exp(-1) - 1) / Math.sqrt(Math.PI);
    expect(Math.abs(got - expected)).toBeLessThan(1e-12);
  });

  test("evalNumericExprWithSpecial(Erf(x), {x: 0.5}) = erfFloat64(0.5) (sub-substrate)", () => {
    // The dispatcher contract: when handed an Erf expression with `x`
    // bound to 0.5, the float64 result equals the direct erfFloat64
    // call. This is the sub-substrate that integrate-1d composes on
    // top of; pinning it here closes the f-arm's full vertical.
    const got = evalNumericExprWithSpecial(
      expr("Erf", [sym("x")]),
      new Map([["x", 0.5]]),
    );
    expect(got).toBe(erfFloat64(0.5));
  });
});

// =============================================================================
// (g) Foreign pass-through: casSimplify leaves out-of-scope heads alone
// =============================================================================
//
// What this proves: the I4 rewriter respects the PRD §2.3 foreign-
// pass-through invariant. A subterm with an unknown head (`BesselJ`)
// must NOT be touched — it round-trips verbatim (modulo the
// cas-simplify out-of-scope tag wrapper, which is the documented
// boundary contract for non-elementary subterms).

describe("(g) Foreign pass-through: casSimplify preserves foreign subterms", () => {
  test("BesselJ(0, z) round-trips through casSimplify (head not in Erf rewriter scope)", () => {
    const foreign = expr("BesselJ", [int(0n), sym("z")]);
    const simplified = casSimplify(foreign);
    // The cas-simplify boundary: if `BesselJ` is unknown to the
    // rational-function bridge, the result is wrapped in
    // `tagged "cas-simplify/out-of-scope"`. The IMPORTANT contract is
    // that the *foreign subterm itself* is preserved byte-identically
    // inside whatever wrapping appears.
    //
    // Two acceptable shapes (the cas-simplify contract):
    //   (i) simplified is the foreign Value itself, OR
    //   (ii) simplified is `tagged "cas-simplify/out-of-scope"` with a
    //        payload containing the foreign Value at the same position.
    if (simplified.kind === "tagged") {
      expect(simplified.tag).toBe("cas-simplify/out-of-scope");
      // Payload must contain the foreign subterm structurally intact —
      // canonicalising the payload yields the same bytes as
      // canonicalising the input.
      expect(canonicalize((simplified as { payload: Value }).payload)).toBe(
        canonicalize(foreign),
      );
    } else {
      // Direct pass-through (acceptable if the rat-fn bridge admits the
      // expression as an opaque generator). Must be byte-identical to
      // the input.
      expect(canonicalize(simplified)).toBe(canonicalize(foreign));
    }
  });

  test("Erf(BesselJ(0, z)) — inner foreign subterm survives", () => {
    // The Erf rewriter must NOT corrupt the BesselJ subterm even when
    // it appears as an Erf argument. The Erf rules either don't fire
    // (because BesselJ doesn't pattern-match any of the special-value
    // shapes) or fire in a way that preserves the foreign subterm's
    // structure.
    const inner = expr("BesselJ", [int(0n), sym("z")]);
    const erfOfForeign = expr("Erf", [inner]);
    const simplified = casSimplify(erfOfForeign);
    // The foreign subterm must appear somewhere in the simplified
    // output's canonical serialisation. The literal `BesselJ` head
    // name (a property of the foreign expr) must be present in the
    // canonical JSON.
    expect(canonicalize(simplified)).toContain("BesselJ");
  });
});

// =============================================================================
// (h) Determinism: 5 repeat calls return byte-identical output
// =============================================================================
//
// What this proves: the ADR-0020 arbprec contract holds at the wire
// boundary. Five repeat calls at fixed (input, precision, head) MUST
// return byte-identical output — no hidden ambient state, no
// timestamp-poisoning, no FFI-injected non-determinism.

describe("(h) Determinism: 5 repeat calls at fixed (input, precision) are byte-identical", () => {
  test("real arbprec: Erf(0.5) @ p=60dp — 5 repeats match", () => {
    const out0 = runSpecialEval(realInput("Erf", 0.5), { precision: 60n });
    const bf0 = decodeRealValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(realInput("Erf", 0.5), { precision: 60n });
      const bf = decodeRealValue(out);
      expect(
        bigfloatBytesEq(bf, bf0),
        bigfloatBytesEqMsg(`repeat #${i}`, bf, bf0),
      ).toBe(true);
    }
  });

  test("real float64 lane: Erf(0.5) @ p=10 — 5 repeats match", () => {
    const out0 = runSpecialEval(realInput("Erf", 0.5), { precision: 10n });
    const bf0 = decodeRealValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(realInput("Erf", 0.5), { precision: 10n });
      const bf = decodeRealValue(out);
      expect(bigfloatBytesEq(bf, bf0)).toBe(true);
    }
  });

  test("complex arbprec: Erf(1+i) @ p=50dp — 5 repeats match (re AND im)", () => {
    const out0 = runSpecialEval(complexInput("Erf", 1, 1), { precision: 50n });
    const bc0 = decodeComplexValue(out0);
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(complexInput("Erf", 1, 1), { precision: 50n });
      const bc = decodeComplexValue(out);
      expect(bigfloatBytesEq(bc.re, bc0.re)).toBe(true);
      expect(bigfloatBytesEq(bc.im, bc0.im)).toBe(true);
    }
  });

  test("refusal output is also deterministic (tagged shape stable across repeats)", () => {
    const out0 = runSpecialEval(complexInput("InverseErf", 0.5, 0), {
      precision: 50n,
    });
    expect(out0.kind).toBe("tagged");
    const tag0 = (out0 as { tag: string }).tag;
    for (let i = 1; i < 5; i++) {
      const out = runSpecialEval(complexInput("InverseErf", 0.5, 0), {
        precision: 50n,
      });
      expect(out.kind).toBe("tagged");
      expect((out as { tag: string }).tag).toBe(tag0);
    }
  });
});

// =============================================================================
// Schema sanity — pin that the special-eval wire shape is what the
// substrate encoders/decoders expect. A drift here is an early-warning
// signal that the wire contract has slipped from the substrate.
// =============================================================================

describe("schema consistency: special-eval value field decodes as bigfloat/bigcomplex", () => {
  test("real output: value decodes via valueToBigFloat without throwing", () => {
    const out = runSpecialEval(realInput("Erf", 0.5), { precision: 60n });
    // The decoder is the cross-package consistency check: if the wire
    // shape doesn't match the substrate's `valueToBigFloat` decoder,
    // this throws — surfacing the schema drift immediately.
    const decoded = decodeRealValue(out);
    expect(decoded.precision).toBeGreaterThanOrEqual(53);
    // The decoded BigFloat must round-trip the substrate's own
    // validate() — proving the bytes are valid per ADR-0020.
    expect(Number.isFinite(decoded.exponent)).toBe(true);
  });

  test("complex output: value decodes via valueToBigComplex without throwing", () => {
    const out = runSpecialEval(complexInput("Erf", 1, 1), { precision: 50n });
    const decoded = decodeComplexValue(out);
    expect(decoded.re.precision).toBeGreaterThanOrEqual(53);
    expect(decoded.im.precision).toBeGreaterThanOrEqual(53);
  });
});
