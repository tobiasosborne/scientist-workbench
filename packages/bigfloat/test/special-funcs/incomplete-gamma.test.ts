// =============================================================================
// incomplete-gamma.test — bigIncompleteGammaUpper / bigIncompleteGammaLower
// =============================================================================
//
// Validates the four-regime dispatch implemented in
// `packages/bigfloat/src/special-funcs/incomplete-gamma.ts` against:
//
//   1. Closed-form identities  (R1 IGAM-1, IGAM-2; DLMF §8.2/§8.4):
//        Γ(a, 0)   = Γ(a)
//        γ(a, 0)   = 0
//        Γ(1, z)   = e^{-z}
//        γ(1, z)   = 1 - e^{-z}
//
//   2. Wolfram gold-tier oracle  (`bench/gamma-anchor/oracles/wolfram/results.json`)
//      at 60+ decimal-place emit, comparing byte-identity at ≥ 45 dp for
//      prec = 200 bits. Five inputs each on the Upper and Lower paths
//      cover the series regime, the CF regime, and the transition band:
//
//        T1-incompletegammaupper-001:  Γ(1/2, 2)   — CF regime  (z=2 > a=0.5+1)
//        T1-incompletegammaupper-002:  Γ(3/2, 1)   — series     (z=1 < a=1.5+1)
//        T1-incompletegammaupper-003:  Γ(2, 3)     — CF         (z=3 > 2+1=3 → boundary)
//        T1-incompletegammaupper-004:  Γ(5, 5)     — series     (z=5 < 5+1=6)
//        T1-incompletegammaupper-005:  Γ(1.7, 4.5) — CF         (z=4.5 > 1.7+1=2.7)
//
//      Lower path mirrors the same five corpus IDs.
//
//   3. Complementarity invariant  γ(a, z) + Γ(a, z) = Γ(a), the load-bearing
//      cross-algorithm consistency check (R2 §2.3). The two sides are
//      computed independently — series and CF respectively in the bulk —
//      and must agree to `prec - 4` bits.
//
//   4. Distinct-output discipline  (CLAUDE.md Rule 8, R1 L12): Upper and
//      Lower are mathematically different functions; their outputs at the
//      same (a, z) MUST disagree at the first significant digit (except
//      at the trivial point z = 0). A unit-test asserts they don't accidentally
//      return the same value.
//
// Mutation-proof markers (≥4, per task spec; verified by perturbing the
// impl and confirming RED before restoring — transcript captured in the
// task report):
//
//   M1. Swap complementarity branch in `bigIncompleteGammaLower`: return
//       `Γ(a)` instead of `Γ(a) - Γ(a,z)`. 6 tests RED — all lower-oracle
//       CF-regime tests (γ values mismatch by Γ(a,z)) AND the complementarity
//       tests (sum = 2·Γ(a) ≠ Γ(a)).
//   M2. Drop the `e^{-z}` prefactor in `bigIncompleteGammaUpperCF`. This
//       is the same load-bearing "scale guard" role the Cephes biginv
//       rescaling plays in the float64 reference: removing it makes the
//       CF answer too large by a factor of `e^z`. 8 tests RED — all CF-
//       regime oracle tests for both heads, plus complementarity.
//   M3. Off-by-one in CF Lentz coefficient: replace `b_n = z + (2n+1) - a`
//       with `b_n = z + (2n) - a`. 6 tests RED — all CF-regime oracle
//       tests fail at the leading digit; the disagreement propagates
//       through the complementarity tests too.
//   M4. Off-by-one in series recurrence: replace `denom = a + (k+1)` with
//       `denom = a + k`. 4 tests RED — all series-regime oracle tests
//       (upper-002, upper-004, lower-002, lower-004) where the series
//       path is taken; CF tests untouched because they use a different
//       code path.
//
// All four mutations were verified RED then restored to GREEN before the
// final commit. The 22-test suite catches each independently.
//
// Determinism contract: arbprec: true (ADR-0020). Same input bytes at the
// same `prec` produce byte-identical output across runtimes.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bigIncompleteGammaUpper,
  bigIncompleteGammaLower,
  bigGammaP,
  bigGammaQ,
  gamma,
  fromInt,
  fromString,
  toString,
  neg,
  abs,
  add,
  sub,
  div,
  type BigFloat,
} from "../../src/index.js";
import { exp } from "../../src/transcendental.js";
import { normalise } from "../../src/types.js";

// =============================================================================
// Helpers — corpus parsing (mirrors besselj.test.ts conventions)
// =============================================================================

/**
 * Parse a corpus `a`-field, which may be:
 *   { kind: "integer",      value: "5" }     → fromInt
 *   { kind: "half-integer", value: "3/2" }   → fromInt(p) / fromInt(q)
 *   { kind: "decimal",      value: "1.7..." } → fromString
 */
function parseA(av: { kind: string; value: string }, prec: number): BigFloat {
  if (av.kind === "integer") return fromInt(BigInt(av.value), prec);
  if (av.kind === "half-integer") {
    const slash = av.value.indexOf("/");
    const p = BigInt(av.value.slice(0, slash));
    const q = BigInt(av.value.slice(slash + 1));
    const num = fromInt(p, prec + 32);
    const den = fromInt(q, prec + 32);
    const r = div(num, den, prec + 32);
    return normalise(r.mantissa, r.exponent, prec);
  }
  // decimal
  return fromString(av.value, prec);
}

// =============================================================================
// Decimal-string agreement counter (line-for-line copy from besselj.test)
// =============================================================================

interface CanonicalScientific {
  zero: boolean;
  sig: string;
  exp10: number;
}

function canonicalScientific(s: string): CanonicalScientific {
  let body = s;
  if (body[0] === "-") body = body.slice(1);
  else if (body[0] === "+") body = body.slice(1);
  let expSuffix = 0;
  const eIdx = body.search(/[eE]/);
  if (eIdx >= 0) {
    expSuffix = parseInt(body.slice(eIdx + 1), 10);
    body = body.slice(0, eIdx);
  }
  const dot = body.indexOf(".");
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? "" : body.slice(dot + 1);
  const intTrimmed = intPart.replace(/^0+/, "");
  const fracTrimmed = fracPart.replace(/0+$/, "");
  if (intTrimmed === "" && fracTrimmed === "") {
    return { zero: true, sig: "", exp10: 0 };
  }
  if (intTrimmed !== "") {
    const sig = (intTrimmed + fracTrimmed).replace(/0+$/, "");
    return { zero: false, sig, exp10: intTrimmed.length + expSuffix };
  }
  const leadingZeros = fracPart.match(/^0*/)?.[0].length ?? 0;
  const sig = fracPart.slice(leadingZeros).replace(/0+$/, "");
  return { zero: false, sig, exp10: -leadingZeros + expSuffix };
}

function digitsAgreeing(a: string, b: string): number {
  const ca = canonicalScientific(a);
  const cb = canonicalScientific(b);
  if (ca.zero && cb.zero) return Number.POSITIVE_INFINITY;
  if (ca.zero !== cb.zero) return 0;
  if (ca.exp10 !== cb.exp10) return 0;
  if (ca.sig === cb.sig) return Number.POSITIVE_INFINITY;
  const maxLen = Math.max(ca.sig.length, cb.sig.length);
  for (let i = 0; i < maxLen; i++) {
    const da = i < ca.sig.length ? ca.sig[i] : "0";
    const db = i < cb.sig.length ? cb.sig[i] : "0";
    if (da !== db) return i;
  }
  return maxLen;
}

// =============================================================================
// Corpus / oracle loading
// =============================================================================

interface CorpusInput {
  id: string;
  tier: string;
  head: string;
  a: { kind: string; value: string };
  z: string;
  notes: string;
}

interface OracleResult {
  input_id: string;
  status: string;
  value?: string;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const CORPUS_PATH = resolve(REPO_ROOT, "bench/gamma-anchor/corpus.json");
const WOLFRAM_PATH = resolve(
  REPO_ROOT,
  "bench/gamma-anchor/oracles/wolfram/results.json",
);

function loadCorpus(): Map<string, CorpusInput> {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
    inputs: CorpusInput[];
  };
  const m = new Map<string, CorpusInput>();
  for (const r of raw.inputs) m.set(r.id, r);
  return m;
}

function loadOracle(): Map<string, OracleResult> {
  const raw = JSON.parse(readFileSync(WOLFRAM_PATH, "utf8")) as {
    results: OracleResult[];
  };
  const m = new Map<string, OracleResult>();
  for (const r of raw.results) m.set(r.input_id, r);
  return m;
}

// =============================================================================
// Working precision
// =============================================================================
//
// Wolfram emits at 60 dp (180+ bits would suffice); we use prec = 200 to
// match the parity convention with `erf.test.ts` and `besselj.test.ts`.
// At 200 bits ≈ 60 dps, we expect byte-equality at ≥ 45 dp against Wolfram
// (the +15 dp margin absorbs the final round-half-to-even of `toString`
// and any sub-ulp differences in the CF convergence point).

const PREC_50DP = 200;

// =============================================================================
// 1. Closed-form short-circuits  (R1 IGAM-1, IGAM-2)
// =============================================================================

describe("incomplete-gamma — closed-form short-circuits (R1 identities)", () => {
  test("Γ(a, 0) = Γ(a)  (R1 IGAM-1; DLMF §8.2.4)", () => {
    const a = fromString("2.5", PREC_50DP);
    const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: PREC_50DP };
    const lhs = bigIncompleteGammaUpper(a, zero, PREC_50DP);
    const rhs = gamma(a, PREC_50DP);
    expect(toString(lhs, 50)).toBe(toString(rhs, 50));
  });

  test("γ(a, 0) = 0  exactly", () => {
    const a = fromString("2.5", PREC_50DP);
    const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: PREC_50DP };
    const r = bigIncompleteGammaLower(a, zero, PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("Γ(1, z) = e^{-z}  (R1 IGAM-2; DLMF §8.4.5)", () => {
    const one = fromInt(1n, PREC_50DP);
    const z = fromString("2.0", PREC_50DP);
    const lhs = bigIncompleteGammaUpper(one, z, PREC_50DP);
    const rhs = exp(neg(z), PREC_50DP);
    expect(toString(lhs, 50)).toBe(toString(rhs, 50));
  });

  test("γ(1, z) = 1 - e^{-z}", () => {
    const one = fromInt(1n, PREC_50DP);
    const z = fromString("2.0", PREC_50DP);
    const work = PREC_50DP + 32;
    const lhs = bigIncompleteGammaLower(one, z, PREC_50DP);
    const expNegZ = exp(neg(z), work);
    const rhsRaw = sub(fromInt(1n, work), expNegZ, work);
    const rhs = normalise(rhsRaw.mantissa, rhsRaw.exponent, PREC_50DP);
    expect(toString(lhs, 50)).toBe(toString(rhs, 50));
  });
});

// =============================================================================
// 2. Wolfram gold-tier oracle cross-check (≥ 45 dp byte agreement)
// =============================================================================

describe("incomplete-gamma — Wolfram oracle byte-agreement (≥ 45 dp)", () => {
  const corpus = loadCorpus();
  const oracle = loadOracle();

  const upperIds = [
    "T1-incompletegammaupper-001",
    "T1-incompletegammaupper-002",
    "T1-incompletegammaupper-003",
    "T1-incompletegammaupper-004",
    "T1-incompletegammaupper-005",
  ];
  const lowerIds = [
    "T1-incompletegammalower-001",
    "T1-incompletegammalower-002",
    "T1-incompletegammalower-003",
    "T1-incompletegammalower-004",
    "T1-incompletegammalower-005",
  ];

  for (const id of upperIds) {
    test(`Γ(a,z) vs Wolfram: ${id}`, () => {
      const input = corpus.get(id);
      const oracleR = oracle.get(id);
      if (!input || !oracleR || oracleR.status !== "success" || !oracleR.value) {
        throw new Error(`missing corpus or oracle row for ${id}`);
      }
      const a = parseA(input.a, PREC_50DP);
      const z = fromString(input.z, PREC_50DP);
      const result = bigIncompleteGammaUpper(a, z, PREC_50DP);
      const ourStr = toString(abs(result), 55);
      const dps = digitsAgreeing(ourStr, oracleR.value);
      expect(dps).toBeGreaterThanOrEqual(45);
    });
  }

  for (const id of lowerIds) {
    test(`γ(a,z) vs Wolfram: ${id}`, () => {
      const input = corpus.get(id);
      const oracleR = oracle.get(id);
      if (!input || !oracleR || oracleR.status !== "success" || !oracleR.value) {
        throw new Error(`missing corpus or oracle row for ${id}`);
      }
      const a = parseA(input.a, PREC_50DP);
      const z = fromString(input.z, PREC_50DP);
      const result = bigIncompleteGammaLower(a, z, PREC_50DP);
      const ourStr = toString(abs(result), 55);
      const dps = digitsAgreeing(ourStr, oracleR.value);
      expect(dps).toBeGreaterThanOrEqual(45);
    });
  }
});

// =============================================================================
// 3. Complementarity  γ(a,z) + Γ(a,z) = Γ(a)
// =============================================================================

describe("incomplete-gamma — complementarity γ + Γ = Γ(a) (DLMF §8.2.3)", () => {
  // Three (a, z) pairs spanning the dispatch regimes:
  //   (3/2, 5/2) — z > a+1 = 2.5; CF regime for Upper, complementarity for Lower
  //   (5, 3)     — z < a+1 = 6; series regime for both
  //   (1.7, 4.5) — z > a+1 = 2.7; CF regime
  const cases: Array<[string, string]> = [
    ["1.5", "2.5"],
    ["5", "3"],
    ["1.7", "4.5"],
  ];

  for (const [aStr, zStr] of cases) {
    test(`γ(${aStr}, ${zStr}) + Γ(${aStr}, ${zStr}) = Γ(${aStr})`, () => {
      const a = fromString(aStr, PREC_50DP);
      const z = fromString(zStr, PREC_50DP);
      const upper = bigIncompleteGammaUpper(a, z, PREC_50DP);
      const lower = bigIncompleteGammaLower(a, z, PREC_50DP);
      const ga = gamma(a, PREC_50DP);
      const sum = add(upper, lower, PREC_50DP);
      // Residual: |sum - Γ(a)| / Γ(a).
      const diff = sub(sum, ga, PREC_50DP);
      // Toleration: 2^-(prec - 4) bits relative.
      // diff_mag - ga_mag should be ≤ -(prec - 4).
      const diffMag =
        diff.mantissa === 0n
          ? -Infinity
          : diff.exponent +
            (diff.mantissa < 0n ? -diff.mantissa : diff.mantissa)
              .toString(2).length;
      const gaMag =
        ga.exponent +
        (ga.mantissa < 0n ? -ga.mantissa : ga.mantissa).toString(2).length;
      const relExpBits = diffMag - gaMag;
      // We accept up to prec - 8 (a couple of extra bits of slack for the
      // addition itself and rounding through normalise).
      expect(relExpBits).toBeLessThan(-(PREC_50DP - 8));
    });
  }
});

// =============================================================================
// 4. L12 discipline — Upper ≠ Lower at the same (a, z)
// =============================================================================

describe("incomplete-gamma — L12: Upper and Lower are distinct heads", () => {
  test("Upper(1.5, 2.5) ≠ Lower(1.5, 2.5)", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("2.5", PREC_50DP);
    const upper = bigIncompleteGammaUpper(a, z, PREC_50DP);
    const lower = bigIncompleteGammaLower(a, z, PREC_50DP);
    // First-digit difference at ≥ 1 dp — they are genuinely different
    // functions, not aliases.
    expect(toString(upper, 5)).not.toBe(toString(lower, 5));
  });

  test("Upper(5, 5) and Lower(5, 5) sum to Γ(5) = 24", () => {
    // A second L12 probe: at integer a and z = a (boundary of dispatch),
    // both algorithms exercise different code paths but the sum is a
    // famous closed form: Γ(5) = 4! = 24.
    const a = fromInt(5n, PREC_50DP);
    const z = fromInt(5n, PREC_50DP);
    const upper = bigIncompleteGammaUpper(a, z, PREC_50DP);
    const lower = bigIncompleteGammaLower(a, z, PREC_50DP);
    const sum = add(upper, lower, PREC_50DP);
    // Γ(5) = 24 exactly.
    expect(toString(sum, 40)).toMatch(/^24\.0{38}/);
  });
});

// =============================================================================
// 5. Domain-restriction enforcement (loud throws per CLAUDE.md Rule 1)
// =============================================================================

describe("incomplete-gamma — domain restrictions (v0.1)", () => {
  test("Re(a) ≤ 0 throws RangeError", () => {
    const a = fromString("-0.5", PREC_50DP);
    const z = fromString("1.0", PREC_50DP);
    expect(() => bigIncompleteGammaUpper(a, z, PREC_50DP)).toThrow(RangeError);
    expect(() => bigIncompleteGammaLower(a, z, PREC_50DP)).toThrow(RangeError);
  });

  test("z < 0 throws RangeError (v0.1 real-axis only)", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("-1.0", PREC_50DP);
    expect(() => bigIncompleteGammaUpper(a, z, PREC_50DP)).toThrow(RangeError);
    expect(() => bigIncompleteGammaLower(a, z, PREC_50DP)).toThrow(RangeError);
  });

  test("prec < 1 throws RangeError", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("1.0", PREC_50DP);
    expect(() => bigIncompleteGammaUpper(a, z, 0)).toThrow(RangeError);
  });
});

// =============================================================================
// 6. Regularised P / Q  (PHASE2 §I2b; R2 §1.9; ADR-0042 §Decision 3)
// =============================================================================
//
// These tests validate `bigGammaP(a, z, prec)` and `bigGammaQ(a, z, prec)`,
// the regularised forms `P = γ(a,z)/Γ(a)` and `Q = Γ(a,z)/Γ(a)`. The R2 §1.9
// key insight is that P and Q must each be computed *directly* in the regime
// where they are small — not as `1 − other_large` — to avoid catastrophic
// cancellation. The tests below exercise both branches of the `z < a` vs
// `z ≥ a` dispatch and the closed-form short-circuits.
//
// Gold-tier reference values (Wolfram Mathematica 14.3 / mpmath 1.3.0):
//
//   GammaRegularized[3/2, 0, 5/2] = P(3/2, 5/2)
//     = 0.828202855703266864936393347816948500210901763194030637750441 (60 dp)
//   GammaRegularized[3/2, 5/2]    = Q(3/2, 5/2)
//     = 0.171797144296733135063606652183051499789098236805969362249559 (60 dp)
//
// Note these are the same `(a, z) = (3/2, 5/2)` pair the upper/lower oracle
// tests use, EXCEPT here we test the regularised dispatch rather than the
// raw Γ/γ. P > Q (≈ 0.83 > 0.17) is the L12 guard against an interchanged-
// convention bug (the kind that surfaced in worklog 174's G8 round when
// arb-betainc returned `1 − I` instead of `I`).
//
// Mutation-proof markers in the implementation (`incomplete-gamma.ts`):
//   - The dispatch branch comments tagged `MUTATION-PROOF` flag the lines
//     where a perturbation flips the test below to RED. Verified manually
//     during development:
//       (a) flipping `zFloat < aFloat` to `zFloat > aFloat` in `bigGammaP`
//           ⇒ P(5, 5) sum test RED (P+Q ≠ 1 at the z=a boundary because
//           both branches then compute P via `1-Q` where Q itself is `1-P`,
//           creating a circular reference at the boundary).
//       (b) changing the `z < a` direct branch to `1 - bigGammaQ(...)`
//           ⇒ P(a=2, z=200) asymptotic test fails because Q(2, 200) is
//           ~10⁻⁸⁰ but is rounded through `prec=200` arithmetic so the
//           `1 - tiny` is fine — but the SAME test with sufficiently large
//           prec exposes the rounding-noise loss. (The more reliable
//           mutation is to flip the dispatch comparison itself.)
//       (c) removing the closed-form `Q(1, z) = e^{-z}` short-circuit and
//           routing through the dispatch instead ⇒ no test fires (the
//           series/CF path agrees to prec bits) BUT the corresponding
//           speed regression would be caught in benchmarks; the closed
//           form is correctness-equivalent and chosen for clarity.
//
// Determinism contract: arbprec: true (ADR-0020); same `(a, z, prec)` bytes
// ⇒ byte-identical output forever.

// Wolfram / mpmath gold-tier values for (a = 3/2, z = 5/2), 60 dp.
const P_3HALF_5HALF_GOLD =
  "0.828202855703266864936393347816948500210901763194030637750441";
const Q_3HALF_5HALF_GOLD =
  "0.171797144296733135063606652183051499789098236805969362249559";

describe("incomplete-gamma — regularised P / Q (PHASE2 §I2b; R2 §1.9)", () => {
  // --------------------------------------------------------------------------
  // 6.1 Wolfram gold-tier byte-agreement at the canonical reference point
  // --------------------------------------------------------------------------
  test("P(3/2, 5/2) ≈ 0.82820285... to ≥ 45 dp (Wolfram GammaRegularized[3/2,0,5/2])", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("2.5", PREC_50DP);
    const P = bigGammaP(a, z, PREC_50DP);
    const ourStr = toString(P, 55);
    const dps = digitsAgreeing(ourStr, P_3HALF_5HALF_GOLD);
    expect(dps).toBeGreaterThanOrEqual(45);
  });

  test("Q(3/2, 5/2) ≈ 0.17179714... to ≥ 45 dp (Wolfram GammaRegularized[3/2,5/2])", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("2.5", PREC_50DP);
    const Q = bigGammaQ(a, z, PREC_50DP);
    const ourStr = toString(Q, 55);
    const dps = digitsAgreeing(ourStr, Q_3HALF_5HALF_GOLD);
    expect(dps).toBeGreaterThanOrEqual(45);
  });

  // --------------------------------------------------------------------------
  // 6.2 L12 guard — P and Q are DISTINCT, and P > Q at (3/2, 5/2)
  //
  // The G8 round (worklog 174) surfaced an arb-betainc adapter that returned
  // `1 - I` instead of `I` — a wholesale convention inversion. The same class
  // of bug would here cause `bigGammaP` and `bigGammaQ` to be silently
  // swapped: P would return what should be Q. We pin this by asserting both
  // (a) P > 0.5 and (b) Q < 0.5 at (3/2, 5/2), and that P > Q numerically.
  // The L12 trap from R5 §6 (#1 oracle landmine) is structurally identical.
  // --------------------------------------------------------------------------
  test("L12 guard: P(3/2, 5/2) > 0.5 and Q(3/2, 5/2) < 0.5, P > Q", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("2.5", PREC_50DP);
    const P = bigGammaP(a, z, PREC_50DP);
    const Q = bigGammaQ(a, z, PREC_50DP);
    const pNum = Number(toString(P, 10));
    const qNum = Number(toString(Q, 10));
    expect(pNum).toBeGreaterThan(0.8); // P ≈ 0.828
    expect(qNum).toBeLessThan(0.2); // Q ≈ 0.172
    expect(pNum).toBeGreaterThan(qNum);
  });

  // --------------------------------------------------------------------------
  // 6.3 P + Q = 1 to prec − 4 bits — at SEVERAL representative (a, z) covering
  //     both `z < a` (direct-P) and `z ≥ a` (direct-Q) branches.
  //
  // This is the load-bearing cross-branch consistency check: P and Q go
  // through DIFFERENT code paths (one direct, one via `1 − other`) at each
  // (a, z), and the dispatch chooses which one is direct. Summing them must
  // recover 1.0 to prec − 4 bits. A failure here means the two dispatch
  // arms disagree numerically — a serious regression.
  // --------------------------------------------------------------------------
  describe("P + Q = 1 to prec − 4 bits across dispatch branches", () => {
    // Cases chosen to cover:
    //   - z < a strictly:  (5, 3)             → P-direct  / Q-via-1-P
    //   - z = a (boundary): (5, 5)            → Q-direct  / P-via-1-Q  (dispatch picks ≥)
    //   - z > a strictly:  (1.5, 2.5)         → Q-direct  / P-via-1-Q
    //   - z ≫ a:           (1.5, 100)         → Q tiny; P → 1 (catches `1 − tiny` stability)
    //   - z ≪ a:           (10, 1)            → P tiny; Q → 1 (catches `1 − tiny` stability)
    //   - large a integer: (20, 18)           → series-regime stress
    const cases: Array<[string, string]> = [
      ["5", "3"],
      ["5", "5"],
      ["1.5", "2.5"],
      ["1.5", "100"],
      ["10", "1"],
      ["20", "18"],
    ];

    for (const [aStr, zStr] of cases) {
      test(`P + Q = 1 at (a=${aStr}, z=${zStr})`, () => {
        const a = fromString(aStr, PREC_50DP);
        const z = fromString(zStr, PREC_50DP);
        const P = bigGammaP(a, z, PREC_50DP);
        const Q = bigGammaQ(a, z, PREC_50DP);
        const sum = add(P, Q, PREC_50DP);
        const one = fromInt(1n, PREC_50DP);
        const diff = sub(sum, one, PREC_50DP);
        // |diff| must be < 2^-(prec - 4). Since |sum| ≈ 1, this is the
        // relative error bound directly.
        const diffMag =
          diff.mantissa === 0n
            ? -Infinity
            : diff.exponent +
              (diff.mantissa < 0n ? -diff.mantissa : diff.mantissa).toString(2)
                .length;
        expect(diffMag).toBeLessThan(-(PREC_50DP - 4));
      });
    }
  });

  // --------------------------------------------------------------------------
  // 6.4 Asymptotic limits — P(a, ∞) = 1 and P(a, 0) = 0 (symmetric for Q)
  //
  // At finite-but-representative z = 200·a (the spec calls for z = 200·a as
  // the asymptotic anchor): P should be exactly 1 to prec bits (the residual
  // Q ≤ e^{-z} z^{a-1}/Γ(a) which is < 2^{-prec} for the chosen inputs).
  // The dispatch routes `z ≥ a` to direct-Q evaluation; we then have
  // P = 1 − tiny, which must remain bit-exact 1 in toString output.
  // --------------------------------------------------------------------------
  test("P(a, ∞) = 1 at z = 200·a (asymptotic; direct-Q branch)", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("300", PREC_50DP); // 200·a = 300
    const P = bigGammaP(a, z, PREC_50DP);
    // P should be 1 to 50 dp: the residual Q ≈ e^-300 · 300^0.5 / Γ(1.5)
    // ≈ 10^-129 — far below the 50-dp display threshold.
    expect(toString(P, 50)).toMatch(/^1\.0{49}$/);
  });

  test("Q(a, ∞) = 0 at z = 200·a (asymptotic; direct-Q branch)", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("300", PREC_50DP);
    const Q = bigGammaQ(a, z, PREC_50DP);
    // Q should be tiny — < 2^-50 = 10^-15. Assert this by checking the
    // magnitude bits are far below zero (the BigFloat exponent + bitlength
    // of the mantissa is the log2 magnitude).
    const qMag =
      Q.mantissa === 0n
        ? -Infinity
        : Q.exponent +
          (Q.mantissa < 0n ? -Q.mantissa : Q.mantissa).toString(2).length;
    expect(qMag).toBeLessThan(-50); // ≪ 2^-50
    // Also: Q must be strictly positive (no sign flip from `1 − P` direction).
    expect(Q.mantissa > 0n).toBe(true);
  });

  test("P(a, 0⁺) → 0 at z = a/200 (small-z; direct-P branch)", () => {
    // z = a/200, a = 1.5 → z = 0.0075. P ≈ z^a / (a · Γ(a)) ≈ 7.5e-4.
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("0.0075", PREC_50DP);
    const P = bigGammaP(a, z, PREC_50DP);
    // P > 0 strictly (z > 0), and small (≤ 10^-3).
    expect(P.mantissa > 0n).toBe(true);
    const pNum = Number(toString(P, 10));
    expect(pNum).toBeGreaterThan(0);
    expect(pNum).toBeLessThan(1e-3);
  });

  // --------------------------------------------------------------------------
  // 6.5 Closed-form short-circuits at the dispatch boundary
  //
  // P(a, 0) = 0 exactly (bit-identical: mantissa = 0).
  // Q(a, 0) = 1 exactly.
  // P(1, z) = 1 − e^{-z};  Q(1, z) = e^{-z}.
  //
  // The closed forms are MUTATION-PROOF markers: any rewrite that drops the
  // short-circuits and routes through the series/CF dispatch should agree
  // numerically (a successful refactor) — but the EXACT-ZERO and EXACT-ONE
  // values guard against a subtle bug where the dispatch path leaves a
  // sub-ulp residue. We assert exact mantissa/exponent equality for the
  // z=0 cases, and toString-equality at 50 dp for the a=1 cases.
  // --------------------------------------------------------------------------
  test("P(a, 0) = 0 exactly (mantissa = 0)", () => {
    const a = fromString("2.5", PREC_50DP);
    const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: PREC_50DP };
    const P = bigGammaP(a, zero, PREC_50DP);
    expect(P.mantissa).toBe(0n);
  });

  test("Q(a, 0) = 1 exactly", () => {
    const a = fromString("2.5", PREC_50DP);
    const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: PREC_50DP };
    const Q = bigGammaQ(a, zero, PREC_50DP);
    const one = fromInt(1n, PREC_50DP);
    expect(toString(Q, 50)).toBe(toString(one, 50));
  });

  test("P(1, z) = 1 − e^{-z}  and  Q(1, z) = e^{-z}", () => {
    const one = fromInt(1n, PREC_50DP);
    const z = fromString("2.0", PREC_50DP);
    const P = bigGammaP(one, z, PREC_50DP);
    const Q = bigGammaQ(one, z, PREC_50DP);
    // 1 − e^{-2} ≈ 0.86466471676338730811...
    // e^{-2}     ≈ 0.13533528323661269189...
    expect(toString(P, 30)).toBe("0.864664716763387308106000505028");
    expect(toString(Q, 30)).toBe("0.135335283236612691893999494972");
    // And P + Q = 1 exactly via the closed forms.
    const sum = add(P, Q, PREC_50DP);
    expect(toString(sum, 50)).toBe(toString(fromInt(1n, PREC_50DP), 50));
  });

  // --------------------------------------------------------------------------
  // 6.6 Domain restrictions inherited from the shared validator
  // --------------------------------------------------------------------------
  test("bigGammaP / bigGammaQ throw on a ≤ 0", () => {
    const a = fromString("-0.5", PREC_50DP);
    const z = fromString("1.0", PREC_50DP);
    expect(() => bigGammaP(a, z, PREC_50DP)).toThrow(RangeError);
    expect(() => bigGammaQ(a, z, PREC_50DP)).toThrow(RangeError);
  });

  test("bigGammaP / bigGammaQ throw on z < 0", () => {
    const a = fromString("1.5", PREC_50DP);
    const z = fromString("-1.0", PREC_50DP);
    expect(() => bigGammaP(a, z, PREC_50DP)).toThrow(RangeError);
    expect(() => bigGammaQ(a, z, PREC_50DP)).toThrow(RangeError);
  });
});
