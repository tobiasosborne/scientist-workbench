// =============================================================================
// zeta.test — bigHurwitzZeta / bigRiemannZeta (arb-prec Hurwitz / Riemann zeta)
// =============================================================================
//
// Validates the standalone Hurwitz-zeta substrate extracted from the v0.1
// polygamma path (ADR-0042 §Decision 12) implemented in
// `packages/bigfloat/src/special-funcs/zeta.ts`.
//
// Reference values (mpmath 1.3.0 at 60 dps, cross-checked against the
// closed forms below):
//
//   ζ(2) = π²/6   = 1.6449340668482264364724151666460251892189499012068  (Basel)
//   ζ(3)          = 1.2020569031595942853997381615114499907649862923405  (Apéry)
//   ζ(4) = π⁴/90  = 1.0823232337111381915160036965411679027747509519187
//   ζ(6) = π⁶/945 = 1.0173430619844491397145179297909205279018174900329
//
// Cross-substrate identity (the load-bearing test): ζ(2, a) = ψ'(a), the
// trigamma function — both are Σ_{k≥0} (a+k)^{-2} (DLMF §5.15.1 / §25.11.12).
// We compute ζ(2, a) via `bigHurwitzZeta` and ψ'(a) via the independent
// `trigamma` / `polygamma(1, ·)` Stirling path and assert agreement.
//
// Recurrence identity (DLMF §25.11.3): ζ(s, a) = ζ(s, a+1) + a^{-s}, the
// telescoping that the self-shift inside `bigHurwitzZeta` is built on.
//
// MUTATION-PROOF MARKERS this file pins (CLAUDE.md Rule 7; perturb-and-
// verify transcript captured in the task report):
//
//   M1. The Euler-Maclaurin Bernoulli index is `B_{2k}`. In
//       `zeta.ts:hurwitzZetaEulerMaclaurin`, replacing `bernoulli(2 * k, …)`
//       with `bernoulli(2 * k + 2, …)` shifts every correction term — the
//       Apéry-constant golden ζ(3) and the Basel golden ζ(2) both go RED.
//
//   M2. The Pochhammer advance `(s)_{2k-1} → (s)_{2k+1}` multiplies in
//       `(s+2k-1)·(s+2k)`. Dropping the `(s+2k)` factor (advancing by one
//       integer instead of two) misaligns the series; ζ(3) and ζ(4) both
//       go RED.
//
//   M3. The self-shift recurrence in `bigHurwitzZeta` *adds* the head sum:
//       `ζ(s,a) = Σ_{k<N}(a+k)^{-s} + ζ(s,a+N)`. Negating the shift sum
//       (`shiftSum = sub(shiftSum, inv, …)`) collapses every below-threshold
//       result — ζ(2)/ζ(3)/ζ(4)/ζ(6) (all use a = 1, below threshold) and
//       every trigamma cross-check go RED.
//
//   M4. The shift count `N` must clear the threshold. Forcing `N = 0`
//       (no shift) evaluates the Poincaré-asymptotic core at small `a`
//       where it diverges; the below-threshold self-shift tests go RED.

import { describe, expect, test } from "bun:test";
import {
  bigHurwitzZeta,
  bigRiemannZeta,
  hurwitzShiftThreshold,
  _hurwitzZetaCVZ,
  trigamma,
  polygamma,
  fromInt,
  fromString,
  toString,
  toFloat64,
  decimalToBinaryPrecision,
  pi,
  mul,
  div,
  sub,
  add,
  abs,
  type BigFloat,
} from "../../src/index.js";

const PREC50DPS = decimalToBinaryPrecision(50); // ≈ 196 bits

/** |a − b| as a float64, for tolerance assertions. */
function diff(a: BigFloat, b: BigFloat, prec: number): number {
  return toFloat64(abs(sub(a, b, prec))).value;
}

// ---------------------------------------------------------------------------
// 1–4. Riemann zeta closed-form goldens.
// ---------------------------------------------------------------------------

describe("bigRiemannZeta — closed-form goldens", () => {
  test("ζ(2) = π²/6 (Basel problem) to 50 dp", () => {
    const r = bigRiemannZeta(2, 200);
    expect(toString(r, 50)).toBe(
      "1.6449340668482264364724151666460251892189499012068",
    );
  });

  test("ζ(3) = Apéry's constant to 50 dp", () => {
    // Apéry's constant — the canonical irrational-zeta value. ζ(3) has no
    // π-power closed form, so this golden is a pure mpmath-oracle pin.
    const r = bigRiemannZeta(3, 200);
    expect(toString(r, 50)).toBe(
      "1.2020569031595942853997381615114499907649862923405",
    );
  });

  test("ζ(4) = π⁴/90 to 50 dp", () => {
    const r = bigRiemannZeta(4, 200);
    expect(toString(r, 50)).toBe(
      "1.0823232337111381915160036965411679027747509519187",
    );
    // Independent closed-form cross-check via the π chain.
    const p = pi(200);
    const p2 = mul(p, p, 200);
    const p4 = mul(p2, p2, 200);
    const expected = div(p4, fromInt(90n, 200), 200);
    expect(diff(r, expected, 200)).toBeLessThan(1e-45);
  });

  test("ζ(6) = π⁶/945 to 50 dp", () => {
    const r = bigRiemannZeta(6, 200);
    expect(toString(r, 50)).toBe(
      "1.0173430619844491397145179297909205279018174900329",
    );
    const p = pi(200);
    const p2 = mul(p, p, 200);
    const p6 = mul(mul(p2, p2, 200), p2, 200);
    const expected = div(p6, fromInt(945n, 200), 200);
    expect(diff(r, expected, 200)).toBeLessThan(1e-45);
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-substrate identity ζ(2, a) = ψ'(a) — the load-bearing test.
// ---------------------------------------------------------------------------

describe("bigHurwitzZeta — cross-substrate identity ζ(2, a) = trigamma(a)", () => {
  // ζ(2, a) = Σ_{k≥0} (a+k)^{-2} = ψ'(a) (DLMF §5.15.1). The two routes are
  // entirely independent: `bigHurwitzZeta` is the Euler-Maclaurin + self-
  // shift path; `trigamma` is the dedicated Stirling-style series in
  // `special.ts`. Agreement to prec−8 bits is the decisive cross-check that
  // the extracted substrate computes the right function, not just a self-
  // consistent one.
  //
  // prec − 8 bits at prec = 196 ⇒ ~188 bits ⇒ ~56 decimal digits of
  // agreement; we assert a conservative 1e-45 absolute tolerance.
  const cases = ["0.5", "1", "2", "3.5", "10"];
  for (const aStr of cases) {
    test(`ζ(2, ${aStr}) agrees with trigamma(${aStr})`, () => {
      const a = fromString(aStr, PREC50DPS);
      const viaZeta = bigHurwitzZeta(2, a, PREC50DPS);
      const viaTrigamma = trigamma(a, PREC50DPS);
      expect(diff(viaZeta, viaTrigamma, PREC50DPS)).toBeLessThan(1e-45);
    });
  }

  test("ζ(2, a) = polygamma(1, a) for the polygamma dispatch entry point", () => {
    // polygamma(1, ·) routes to trigamma; this confirms the public
    // polygamma surface and the zeta substrate agree on the m=1 / s=2 case.
    const a = fromString("4.25", PREC50DPS);
    const viaZeta = bigHurwitzZeta(2, a, PREC50DPS);
    const viaPoly = polygamma(1, a, PREC50DPS);
    expect(diff(viaZeta, viaPoly, PREC50DPS)).toBeLessThan(1e-45);
  });
});

// ---------------------------------------------------------------------------
// 6. Self-shift correctness — below AND above the shift threshold.
// ---------------------------------------------------------------------------

describe("bigHurwitzZeta — self-shift correctness", () => {
  // The shift threshold at prec = 200 bits, s = 2 is 51 (verified directly
  // below). Inputs a = 0.5 and a = 2 are far BELOW it — exactly the regime
  // the v0.1 private helper got WRONG without a caller pre-shift. Input
  // a = 60 is comfortably ABOVE it, so the EM core runs with N = 0 shift
  // steps. Both must be correct, cross-checked against trigamma.

  test("shift threshold at prec=200, s=2 is below 60 and above 2", () => {
    const t = hurwitzShiftThreshold(200, 2);
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(60);
  });

  test("below-threshold a = 0.5 is correct (self-shift exercised)", () => {
    // ζ(2, 1/2) = π²/2 (DLMF §25.11.12: ζ(s,1/2) = (2^s−1)ζ(s)).
    const r = bigHurwitzZeta(2, fromString("0.5", 200), 200);
    const p = pi(200);
    const expected = div(mul(p, p, 200), fromInt(2n, 200), 200);
    expect(diff(r, expected, 200)).toBeLessThan(1e-45);
  });

  test("below-threshold a = 2 is correct (self-shift exercised)", () => {
    // ζ(2, 2) = ζ(2) − 1 = π²/6 − 1.
    const r = bigHurwitzZeta(2, fromInt(2n, 200), 200);
    const expected = sub(bigRiemannZeta(2, 200), fromInt(1n, 200), 200);
    expect(diff(r, expected, 200)).toBeLessThan(1e-45);
  });

  test("above-threshold a = 60 is correct (N = 0, core runs directly)", () => {
    // a = 60 > threshold(200,2)=51 ⇒ no shift; the EM core is the whole
    // computation. Cross-check against trigamma(60).
    const a = fromInt(60n, 200);
    const r = bigHurwitzZeta(2, a, 200);
    expect(diff(r, trigamma(a, 200), 200)).toBeLessThan(1e-45);
  });

  test("below- and above-threshold agree on the recurrence bridge", () => {
    // ζ(2, 3) computed self-shifted from a=3 must equal ζ(2, 60) plus the
    // explicit head Σ_{k=3}^{59} k^{-2} — an end-to-end consistency check
    // that the self-shift produces the same answer as a hand-walked one.
    const lowResult = bigHurwitzZeta(2, fromInt(3n, 200), 200);
    const highResult = bigHurwitzZeta(2, fromInt(60n, 200), 200);
    let head: BigFloat = { mantissa: 0n, exponent: 0, precision: 200 };
    for (let k = 3; k < 60; k++) {
      const term = div(
        fromInt(1n, 200),
        mul(fromInt(BigInt(k), 200), fromInt(BigInt(k), 200), 200),
        200,
      );
      head = add(head, term, 200);
    }
    const reconstructed = add(highResult, head, 200);
    expect(diff(lowResult, reconstructed, 200)).toBeLessThan(1e-45);
  });
});

// ---------------------------------------------------------------------------
// 7. Recurrence identity ζ(s, a) = ζ(s, a+1) + a^{-s}.
// ---------------------------------------------------------------------------

describe("bigHurwitzZeta — recurrence identity", () => {
  // DLMF §25.11.3: ζ(s, a) = a^{-s} + ζ(s, a+1). Verified for several
  // (s, a) pairs to prec−8 bits.
  const cases: Array<[number, string]> = [
    [2, "1.5"],
    [3, "2"],
    [4, "0.75"],
    [5, "7"],
  ];
  for (const [s, aStr] of cases) {
    test(`ζ(${s}, ${aStr}) = ζ(${s}, ${aStr}+1) + ${aStr}^(-${s})`, () => {
      const a = fromString(aStr, 200);
      const aPlus1 = add(a, fromInt(1n, 200), 200);
      const lhs = bigHurwitzZeta(s, a, 200);
      // a^{-s} = 1 / a^s, with a^s built by `s` (small) repeated multiplies.
      let aPowS = fromInt(1n, 200);
      for (let i = 0; i < s; i++) aPowS = mul(aPowS, a, 200);
      const rhsTerm = div(fromInt(1n, 200), aPowS, 200);
      const rhs = add(bigHurwitzZeta(s, aPlus1, 200), rhsTerm, 200);
      expect(diff(lhs, rhs, 200)).toBeLessThan(1e-45);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Refusals — loud RangeError on out-of-scope input (CLAUDE.md Rule 1).
// ---------------------------------------------------------------------------

describe("bigHurwitzZeta / bigRiemannZeta — honest refusals", () => {
  // v0.1 scope is integer s ≥ 2. General complex s (including the critical
  // strip and the functional equation) is a documented v0.2-of-v0.2 lift —
  // see the zeta.ts module header. Out-of-scope input throws loudly rather
  // than returning a plausible-looking wrong value.

  test("non-integer s throws", () => {
    expect(() => bigHurwitzZeta(2.5, fromInt(3n, 200), 200)).toThrow();
    expect(() => bigRiemannZeta(3.5, 200)).toThrow();
  });

  test("s < 2 throws (including the s = 1 pole of ζ)", () => {
    expect(() => bigHurwitzZeta(1, fromInt(3n, 200), 200)).toThrow();
    expect(() => bigHurwitzZeta(0, fromInt(3n, 200), 200)).toThrow();
    expect(() => bigHurwitzZeta(-1, fromInt(3n, 200), 200)).toThrow();
    expect(() => bigRiemannZeta(1, 200)).toThrow();
  });

  test("a ≤ 0 throws (poles of the Hurwitz zeta on this branch)", () => {
    expect(() => bigHurwitzZeta(2, fromInt(0n, 200), 200)).toThrow();
    expect(() => bigHurwitzZeta(2, fromString("-0.5", 200), 200)).toThrow();
    expect(() => bigHurwitzZeta(2, fromInt(-3n, 200), 200)).toThrow();
  });
});

// ===========================================================================
// 9–15. Cohen-Villegas-Zagier (CVZ) lane — bead scientist-workbench-idq1.
// ===========================================================================
//
// `_hurwitzZetaCVZ` is the second evaluation lane for ζ(s, a): the
// Cohen-Villegas-Zagier convergence-acceleration method (Cohen, Villegas &
// Zagier 2000) applied through the eta-transform recurrence
//
//     ζ(s, a) = Σ_{j≥0} 2^{j(1-s)} · η(s, a_j),   a_0 = a, a_{j+1} = (a_j+1)/2,
//
// with each alternating eta `η(s, a_j) = Σ_{k≥0} (-1)^k (a_j+k)^{-s}`
// evaluated by CVZ Algorithm 1. See `zeta.ts` §"CVZ lane" for the full
// derivation. The lane is correct and geometrically convergent but, per the
// §"Lane selection" finding, NOT on the production dispatch (it is ~100×
// slower than Euler-Maclaurin for integer s ≥ 2) — `_hurwitzZetaCVZ` is the
// exported handle so the suite can cross-validate it against the
// Euler-Maclaurin lane (which is what `bigHurwitzZeta` runs).
//
// MUTATION-PROOF MARKERS this block pins (CLAUDE.md Rule 7; perturb-and-
// verify transcript captured in the task report):
//
//   M5. The CVZ Algorithm-1 recurrence is initialised `b ← −1` in
//       `zeta.ts:hurwitzEtaCVZ`. Flipping the initialiser to `b ← +1`
//       (`let bNum = -1n` → `let bNum = 1n`) inverts the accelerator
//       weights — every `_hurwitzZetaCVZ` value diverges from the
//       Euler-Maclaurin lane and the path-agreement tests below go RED.
//
//   M6. The eta-transform prefactor is `2^{j(1-s)}` — a shrinking,
//       negative-exponent power. In `_hurwitzZetaCVZ`, replacing
//       `prefExp = -j * (s - 1)` with `+j * (s - 1)` makes the recurrence
//       diverge; every CVZ cross-check and small-`a` correctness test
//       goes RED.
//
//   M7. The CVZ `d_n` weights satisfy `d_k = 6·d_{k-1} − d_{k-2}`.
//       Changing the `6n *` coefficient (e.g. to `5n *`) or the sign of
//       the `− d[d.length - 2]` term breaks the `(3+√8)^{-n}` geometric
//       exactness; the path-agreement tests lose all precision and go RED.

describe("_hurwitzZetaCVZ — path agreement with the Euler-Maclaurin lane", () => {
  // The decisive cross-validation: the CVZ lane and the Euler-Maclaurin
  // lane (`bigHurwitzZeta`) are wholly independent algorithms — CVZ is
  // geometric via the eta-transform, EM is asymptotic via the shift +
  // Bernoulli series. They must agree to `prec − 8` bits everywhere in
  // the overlap region (which, the two lanes both being exact, is the
  // entire domain). prec − 8 at prec = 196 ⇒ ~188 bits ⇒ ~56 decimal
  // digits; we assert a conservative relative tolerance.
  //
  // The assertion is RELATIVE (|CVZ−EM| / |EM|): ζ(2, 0.01) ≈ 10⁴, so an
  // absolute 1e-45 tolerance would be far stricter than prec−8 bits there
  // — a relative bound is the honest cross-check.
  const cases: Array<[number, string, number]> = [
    [2, "0.01", 200],
    [2, "0.1", 200],
    [2, "0.5", 200],
    [2, "1", 200],
    [2, "2", 200],
    [3, "0.1", 200],
    [3, "1.5", 200],
    [4, "0.75", 256],
    [6, "1", 256],
    [5, "3.5", 256],
  ];
  for (const [s, aStr, prec] of cases) {
    test(`ζ(${s}, ${aStr}) — CVZ agrees with Euler-Maclaurin to prec−8 bits`, () => {
      const a = fromString(aStr, prec);
      const viaCVZ = _hurwitzZetaCVZ(s, a, prec);
      const viaEM = bigHurwitzZeta(s, a, prec);
      const absDiff = toFloat64(abs(sub(viaCVZ, viaEM, prec))).value;
      const scale = toFloat64(abs(viaEM)).value;
      // prec − 8 bits of relative agreement ⇒ rel error < 2^-(prec-8).
      const relTol = Math.pow(2, -(prec - 8));
      expect(absDiff / scale).toBeLessThan(relTol);
    });
  }
});

describe("_hurwitzZetaCVZ — small-a correctness via the trigamma identity", () => {
  // ζ(2, a) = ψ'(a) (DLMF §5.15.1 / §25.11.12) and, more generally,
  // ζ(m+1, a) = (-1)^{m+1}/m! · ψ^{(m)}(a). The small-a regime — a ≤ 1 —
  // is exactly what the CVZ lane is designed to converge on geometrically;
  // here we cross-check the CVZ output against the independent polygamma
  // Stirling path, NOT against `bigHurwitzZeta` (so the test does not
  // merely re-confirm the path-agreement block above).

  test("ζ(2, 0.01) via CVZ equals trigamma(0.01)", () => {
    // ψ'(0.01) — trigamma is the independent Stirling-series substrate.
    const a = fromString("0.01", 200);
    const viaCVZ = _hurwitzZetaCVZ(2, a, 200);
    const viaTrigamma = trigamma(a, 200);
    const rel =
      toFloat64(abs(sub(viaCVZ, viaTrigamma, 200))).value /
      toFloat64(abs(viaTrigamma)).value;
    expect(rel).toBeLessThan(Math.pow(2, -(200 - 8)));
  });

  test("ζ(3, 0.1) via CVZ matches the polygamma(2, ·) identity", () => {
    // ψ^{(2)}(a) = (-1)^3 · 2! · ζ(3, a) = -2·ζ(3, a)
    //   ⇒ ζ(3, a) = -ψ^{(2)}(a) / 2.
    const a = fromString("0.1", 200);
    const viaCVZ = _hurwitzZetaCVZ(3, a, 200);
    const psi2 = polygamma(2, a, 200);
    const viaIdentity = div(psi2, fromInt(-2n, 200), 200);
    const rel =
      toFloat64(abs(sub(viaCVZ, viaIdentity, 200))).value /
      toFloat64(abs(viaIdentity)).value;
    expect(rel).toBeLessThan(Math.pow(2, -(200 - 8)));
  });

  test("ζ(2, 0.5) via CVZ equals π²/2 (closed form)", () => {
    // ζ(s, 1/2) = (2^s − 1)·ζ(s) (DLMF §25.11.12), so ζ(2, 1/2) = 3·ζ(2)
    // = 3·π²/6 = π²/2.
    const r = _hurwitzZetaCVZ(2, fromString("0.5", 200), 200);
    const p = pi(200);
    const expected = div(mul(p, p, 200), fromInt(2n, 200), 200);
    const rel =
      toFloat64(abs(sub(r, expected, 200))).value /
      toFloat64(abs(expected)).value;
    expect(rel).toBeLessThan(Math.pow(2, -(200 - 8)));
  });
});

describe("_hurwitzZetaCVZ — Riemann zeta closed-form goldens", () => {
  // ζ(s) = ζ(s, 1); a = 1 is small (well inside the CVZ-favourable band).
  // The CVZ lane must reproduce the closed-form Riemann values to 50 dp.

  test("ζ(2) = π²/6 (Basel) to 50 dp via CVZ", () => {
    const r = _hurwitzZetaCVZ(2, fromInt(1n, 240), 240);
    expect(toString(r, 50)).toBe(
      "1.6449340668482264364724151666460251892189499012068",
    );
  });

  test("ζ(3) = Apéry's constant to 50 dp via CVZ", () => {
    const r = _hurwitzZetaCVZ(3, fromInt(1n, 240), 240);
    expect(toString(r, 50)).toBe(
      "1.2020569031595942853997381615114499907649862923405",
    );
  });

  test("ζ(4) = π⁴/90 to 50 dp via CVZ", () => {
    const r = _hurwitzZetaCVZ(4, fromInt(1n, 240), 240);
    expect(toString(r, 50)).toBe(
      "1.0823232337111381915160036965411679027747509519187",
    );
  });

  test("ζ(6) = π⁶/945 to 50 dp via CVZ", () => {
    const r = _hurwitzZetaCVZ(6, fromInt(1n, 240), 240);
    expect(toString(r, 50)).toBe(
      "1.0173430619844491397145179297909205279018174900329",
    );
  });
});

describe("_hurwitzZetaCVZ — recurrence identity across the lane", () => {
  // DLMF §25.11.3: ζ(s, a) = a^{-s} + ζ(s, a+1). The CVZ lane must obey
  // the recurrence too — and the test exercises it with `a` on both sides
  // of any plausible CVZ/EM-favourable cutoff (a = 0.4 → a+1 = 1.4, a = 3
  // → a+1 = 4), so it is a genuine bridge test, not a self-restatement.
  const cases: Array<[number, string]> = [
    [2, "0.4"],
    [3, "0.9"],
    [4, "1.25"],
    [5, "3"],
  ];
  for (const [s, aStr] of cases) {
    test(`ζ(${s}, ${aStr}) = ζ(${s}, ${aStr}+1) + ${aStr}^(-${s}) [CVZ]`, () => {
      const prec = 200;
      const a = fromString(aStr, prec);
      const aPlus1 = add(a, fromInt(1n, prec), prec);
      const lhs = _hurwitzZetaCVZ(s, a, prec);
      let aPowS = fromInt(1n, prec);
      for (let i = 0; i < s; i++) aPowS = mul(aPowS, a, prec);
      const rhsTerm = div(fromInt(1n, prec), aPowS, prec);
      const rhs = add(_hurwitzZetaCVZ(s, aPlus1, prec), rhsTerm, prec);
      const rel =
        toFloat64(abs(sub(lhs, rhs, prec))).value /
        toFloat64(abs(lhs)).value;
      expect(rel).toBeLessThan(Math.pow(2, -(prec - 8)));
    });
  }
});

describe("_hurwitzZetaCVZ — determinism (arbprec contract)", () => {
  // arbprec: true — same (s, a, prec) bytes ⇒ byte-identical BigFloat.
  // The CVZ lane uses exact integer d_n weights and exact BigInt b-ratio
  // arithmetic, so repeat calls must be bit-identical. The CVZ lane is
  // deliberately ~100× slower than Euler-Maclaurin (see `zeta.ts`
  // §"Lane selection"), so these tests carry a generous explicit
  // timeout; the repeat count is 5 calls total (1 reference + 4
  // re-checks), each compared mantissa/exponent/precision-exact.
  test(
    "five repeat calls of ζ(2, 0.3) are byte-identical",
    () => {
      const a = fromString("0.3", 200);
      const first = _hurwitzZetaCVZ(2, a, 200);
      for (let i = 0; i < 4; i++) {
        const r = _hurwitzZetaCVZ(2, a, 200);
        expect(r.mantissa).toBe(first.mantissa);
        expect(r.exponent).toBe(first.exponent);
        expect(r.precision).toBe(first.precision);
      }
    },
    20000,
  );

  test(
    "five repeat calls of ζ(4, 1.5) are byte-identical",
    () => {
      const a = fromString("1.5", 256);
      const first = _hurwitzZetaCVZ(4, a, 256);
      for (let i = 0; i < 4; i++) {
        const r = _hurwitzZetaCVZ(4, a, 256);
        expect(r.mantissa).toBe(first.mantissa);
        expect(r.exponent).toBe(first.exponent);
        expect(r.precision).toBe(first.precision);
      }
    },
    20000,
  );
});

describe("_hurwitzZetaCVZ — honest refusals", () => {
  // The CVZ lane shares the integer-s ≥ 2 scope of the Euler-Maclaurin
  // lane; out-of-scope `s` throws loudly (CLAUDE.md Rule 1).
  test("non-integer s throws", () => {
    expect(() => _hurwitzZetaCVZ(2.5, fromInt(3n, 200), 200)).toThrow();
  });
  test("s < 2 throws", () => {
    expect(() => _hurwitzZetaCVZ(1, fromInt(3n, 200), 200)).toThrow();
    expect(() => _hurwitzZetaCVZ(0, fromInt(3n, 200), 200)).toThrow();
  });
});
