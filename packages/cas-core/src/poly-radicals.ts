// =============================================================================
// poly-radicals.ts — closed-form radical roots for univariate polys of degree ≤ 4
// =============================================================================
//
// What this module exposes
// ------------------------
//   • `linearRoot(a, b)`        — solves `a x + b = 0`,  one root.
//   • `quadraticRoots(a, b, c)` — solves `a x² + b x + c = 0`, two roots.
//   • `cubicRoots(a, b, c, d)`  — solves `a x³ + b x² + c x + d = 0`, three
//     roots, via Cardano (1545). Faithful complex form per bead
//     `scientist-workbench-1yu`: the casus-irreducibilis branch (three
//     real roots, Δ > 0) emits expressions that traverse complex
//     numbers — `sqrt(-x)` and `^(_, 1/3)` of complex values — rather
//     than switching to the trigonometric formula. A consumer can
//     `ToReal`-simplify post-hoc.
//   • `quarticRoots(a, b, c, d, e)` — solves `a x⁴ + b x³ + c x² + d x + e = 0`,
//     four roots, via Ferrari (1540) on top of Cardano for the
//     resolvent cubic.
//
// All inputs are `Rat` (the cas-core rational type). All outputs are
// expression Values over the closed numerical vocabulary
// (`+ - * / ^ neg sqrt`) — the same vocabulary `cas-diff`,
// `integrate-1d`, `optimize-lbfgs-projected`, and (now) `tools/poly-
// roots` consume. No new heads.
//
// Why expressions, not numbers
// ----------------------------
// `tools/poly-roots`'s contract is symbolic-radical, not float64. The
// downstream consumer (a planner running over a tagged result) wants
// to keep the answer exact: `(-1 + sqrt(5)) / 2` rather than
// `0.6180339887...`. cas-simplify can canonicalise the rational
// pieces; cas-diff can differentiate the result in another variable;
// integrate-1d can use it as a bound. Rolling to float would lose
// every one of those compositions.
//
// Why faithful complex Cardano (not trig) for casus irreducibilis
// ----------------------------------------------------------------
// Cubic with three real roots and `Δ_c > 0`: Cardano's nested cube
// roots range over complex numbers even though the answer ends real
// (the imaginary parts cancel in the sum `u + v`). The trigonometric
// formula sidesteps complex by using `cos((1/3) acos(...))` directly,
// but it changes the *shape* of the answer. The bead pins this
// decision: keep Cardano. The consumer that wants real-only
// expressions can apply a follow-up `ToReal` simplifier; the
// expressions emitted here are syntactically valid over our
// vocabulary even though `evalNumericExpr` will produce NaN on the
// `sqrt(negative)` subterms.
//
// References
// ----------
// • Cardano, *Ars Magna* (1545) — original cubic.
// • Ferrari (in Cardano's *Ars Magna*) — quartic.
// • Galois 1832 — proof that quintic and higher have no general
//   radical solution; the reason this module caps at degree 4.
// • Cox, *Galois Theory*, ch. 1-2.

import { type Rat, makeRat } from "./rat.js";
import { expr, int, sym, type Value, rat as protocolRat } from "@workbench/protocol";

function ratToValue(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return protocolRat(r.n, r.d);
}

// -----------------------------------------------------------------------------
// Symbolic helpers — build expression Values with a shape-aware API
// -----------------------------------------------------------------------------
//
// The expressions emitted here are dense; we deliberately do *not*
// perform smart-constructor reduction (e.g., 0+x → x, 1·x → x) at this
// layer. cas-simplify is the canonicaliser. Keeping the radicals
// builders dumb means: (a) the unit tests can compare structural
// shapes precisely, (b) cas-simplify's role stays singular, and (c)
// emitting `0 + x` instead of `x` is a transparent no-op for
// downstream tools.

const E_ZERO = int(0n);
const E_ONE = int(1n);
const E_TWO = int(2n);
const E_THREE = int(3n);
const E_FOUR = int(4n);
const E_NEG_ONE = int(-1n);
const E_HALF: Value = protocolRat(1n, 2n);
const E_THIRD: Value = protocolRat(1n, 3n);

const eAdd = (a: Value, b: Value): Value => expr("+", [a, b]);
const eSub = (a: Value, b: Value): Value => expr("-", [a, b]);
const eMul = (a: Value, b: Value): Value => expr("*", [a, b]);
const eDiv = (a: Value, b: Value): Value => expr("/", [a, b]);
const eNeg = (a: Value): Value => expr("neg", [a]);
const eSqrt = (a: Value): Value => expr("sqrt", [a]);
const eCbrt = (a: Value): Value => expr("^", [a, E_THIRD]);
const ePow = (a: Value, n: bigint): Value => expr("^", [a, int(n)]);

// -----------------------------------------------------------------------------
// Linear and quadratic
// -----------------------------------------------------------------------------

/** Solve `a · x + b = 0` over ℚ. Returns the rational root as a Value. */
export function linearRoot(a: Rat, b: Rat): Value {
  if (a.n === 0n) {
    throw new Error("linearRoot: leading coefficient is zero");
  }
  // x = -b / a
  const num = -b.n * a.d;
  const den = b.d * a.n;
  return ratToValue(makeRat(num, den));
}

/**
 * Solve `a · x² + b · x + c = 0` over ℚ. Returns `[root_+, root_-]`,
 * the two roots of the quadratic formula `(-b ± √(b² − 4ac)) / (2a)`.
 *
 * Discriminant sign:
 *   `b² − 4ac > 0`  ⇒  two distinct real roots
 *   `b² − 4ac = 0`  ⇒  repeated real root (formula returns the same
 *                       value twice; caller may dedupe via cas-simplify)
 *   `b² − 4ac < 0`  ⇒  two complex-conjugate roots; the result
 *                       expressions contain `sqrt(negative)` and remain
 *                       symbolically valid (eval-NaN downstream).
 */
export function quadraticRoots(a: Rat, b: Rat, c: Rat): [Value, Value] {
  if (a.n === 0n) {
    throw new Error("quadraticRoots: leading coefficient is zero");
  }
  // Discriminant: D = b² − 4ac (rational).
  const D_num = b.n * b.n * 4n * a.d * c.d - 4n * a.n * c.n * b.d * b.d * 4n;
  // Wait — this needs to be done carefully to avoid losing the rational structure.
  // Let me recompute: b² as Rat, 4ac as Rat, then subtract.
  const bSquared = makeRat(b.n * b.n, b.d * b.d);
  const fourAC = makeRat(4n * a.n * c.n, a.d * c.d);
  const D = makeRat(
    bSquared.n * fourAC.d - fourAC.n * bSquared.d,
    bSquared.d * fourAC.d,
  );
  void D_num;

  const negB = ratToValue(makeRat(-b.n, b.d));
  const twoA = ratToValue(makeRat(2n * a.n, a.d));
  const sqrtD = eSqrt(ratToValue(D));

  const root_plus = eDiv(eAdd(negB, sqrtD), twoA);
  const root_minus = eDiv(eSub(negB, sqrtD), twoA);
  return [root_plus, root_minus];
}

// -----------------------------------------------------------------------------
// Cubic — Cardano 1545
// -----------------------------------------------------------------------------
//
// Strategy:
//   1. Normalise to monic by dividing by leading coefficient.
//      a x³ + b x² + c x + d = 0
//      ⟺ x³ + (b/a) x² + (c/a) x + (d/a) = 0
//   2. Depress: substitute x = t − b/(3a) ⟹ t³ + p t + q = 0 where
//      p = (3ac − b²) / (3a²)
//      q = (2b³ − 9abc + 27a²d) / (27a³)
//   3. Cardano discriminant inner: D_c = (q/2)² + (p/3)³ ∈ ℚ.
//   4. u = ∛(−q/2 + √D_c)
//      v = ∛(−q/2 − √D_c)
//   5. The three roots of the depressed cubic are
//      t₁ = u + v
//      t₂ = ω u + ω² v   where ω = (−1 + √−3) / 2
//      t₃ = ω² u + ω v
//   6. Un-shift: x_i = t_i − b/(3a).
//
// We emit the three roots as expressions in `+ − * / ^ neg sqrt` over
// integer/rational leaves. ω and ω² are written out in the closed
// vocabulary (no first-class `i`).

/** Solve `a x³ + b x² + c x + d = 0` over ℚ. Returns the three roots. */
export function cubicRoots(
  a: Rat, b: Rat, c: Rat, d: Rat,
): [Value, Value, Value] {
  if (a.n === 0n) {
    throw new Error("cubicRoots: leading coefficient is zero");
  }
  // Normalise to monic by dividing through by `a` (rational division).
  const A = a, B = b, C = c, D_ = d;
  const ratDiv = (x: Rat, y: Rat): Rat =>
    makeRat(x.n * y.d, x.d * y.n);
  const ratMul = (x: Rat, y: Rat): Rat =>
    makeRat(x.n * y.n, x.d * y.d);
  const ratSub = (x: Rat, y: Rat): Rat =>
    makeRat(x.n * y.d - y.n * x.d, x.d * y.d);
  const ratAdd = (x: Rat, y: Rat): Rat =>
    makeRat(x.n * y.d + y.n * x.d, x.d * y.d);
  const r = (n: bigint, dd: bigint = 1n): Rat => makeRat(n, dd);

  // p = (3ac − b²) / (3a²)
  const num_p = ratSub(ratMul(r(3n), ratMul(A, C)), ratMul(B, B));
  const den_p = ratMul(r(3n), ratMul(A, A));
  const p_q = ratDiv(num_p, den_p);

  // q = (2b³ − 9abc + 27a²d) / (27a³)
  const term1 = ratMul(r(2n), ratMul(B, ratMul(B, B)));
  const term2 = ratMul(r(9n), ratMul(A, ratMul(B, C)));
  const term3 = ratMul(r(27n), ratMul(ratMul(A, A), D_));
  const num_q = ratAdd(ratSub(term1, term2), term3);
  const den_q = ratMul(r(27n), ratMul(A, ratMul(A, A)));
  const q_q = ratDiv(num_q, den_q);

  // shift = -b / (3a)
  const shift_q = ratDiv(makeRat(-B.n, B.d), ratMul(r(3n), A));

  // D_c = (q/2)² + (p/3)³
  const half_q = ratMul(q_q, r(1n, 2n));
  const third_p = ratMul(p_q, r(1n, 3n));
  const D_c_q = ratAdd(
    ratMul(half_q, half_q),
    ratMul(third_p, ratMul(third_p, third_p)),
  );

  // -q/2
  const negHalfQ_q = makeRat(-q_q.n, q_q.d * 2n);

  // Build u = ∛(-q/2 + √D_c)
  const sqrtDc = eSqrt(ratToValue(D_c_q));
  const u_inner_plus = eAdd(ratToValue(negHalfQ_q), sqrtDc);
  const u_inner_minus = eSub(ratToValue(negHalfQ_q), sqrtDc);
  const u_expr = eCbrt(u_inner_plus);
  const v_expr = eCbrt(u_inner_minus);

  // ω = (-1 + sqrt(-3)) / 2; ω² = (-1 - sqrt(-3)) / 2.
  const sqrtNeg3 = eSqrt(int(-3n));
  const omega = eDiv(eAdd(E_NEG_ONE, sqrtNeg3), E_TWO);
  const omegaSq = eDiv(eSub(E_NEG_ONE, sqrtNeg3), E_TWO);

  const shiftExpr = ratToValue(shift_q);

  // Three roots, un-shifted by `shift`.
  const t1 = eAdd(u_expr, v_expr);
  const t2 = eAdd(eMul(omega, u_expr), eMul(omegaSq, v_expr));
  const t3 = eAdd(eMul(omegaSq, u_expr), eMul(omega, v_expr));

  return [
    eAdd(t1, shiftExpr),
    eAdd(t2, shiftExpr),
    eAdd(t3, shiftExpr),
  ];
}

// -----------------------------------------------------------------------------
// Quartic — Ferrari 1540
// -----------------------------------------------------------------------------
//
// Strategy (Ferrari):
//   1. Normalise to monic: x⁴ + B x³ + C x² + D x + E = 0.
//   2. Depress: x = y − B/4 ⟹ y⁴ + p y² + q y + r = 0 where
//        p = C − 3B²/8
//        q = D − BC/2 + B³/8
//        r = E − BD/4 + B²C/16 − 3B⁴/256
//   3. Resolvent cubic: solve `8 m³ + 8p m² + (2p² − 8r) m − q² = 0`
//      via Cardano. Take any root `m₀` (we pick the one with the
//      simplest expression — Ferrari's correctness is invariant in
//      `m₀`, but the result expressions differ in shape).
//   4. From `m₀`, build two factors of the depressed quartic:
//        y² + (√(2m₀)) y + (p/2 + m₀ − q/(2 √(2m₀))) = 0
//        y² − (√(2m₀)) y + (p/2 + m₀ + q/(2 √(2m₀))) = 0
//      and solve each quadratic via `quadraticRoots`. Total: 4 roots.
//   5. Un-shift: x = y − B/4.

/** Solve `a x⁴ + b x³ + c x² + d x + e = 0` over ℚ. Returns four roots. */
export function quarticRoots(
  a: Rat, b: Rat, c: Rat, d: Rat, e: Rat,
): [Value, Value, Value, Value] {
  if (a.n === 0n) {
    throw new Error("quarticRoots: leading coefficient is zero");
  }
  const r = (n: bigint, dd: bigint = 1n): Rat => makeRat(n, dd);
  const ratDiv = (x: Rat, y: Rat): Rat => makeRat(x.n * y.d, x.d * y.n);
  const ratMul = (x: Rat, y: Rat): Rat => makeRat(x.n * y.n, x.d * y.d);
  const ratSub = (x: Rat, y: Rat): Rat =>
    makeRat(x.n * y.d - y.n * x.d, x.d * y.d);
  const ratAdd = (x: Rat, y: Rat): Rat =>
    makeRat(x.n * y.d + y.n * x.d, x.d * y.d);

  // Normalise to monic: B = b/a, C = c/a, D = d/a, E = e/a.
  const Bm = ratDiv(b, a);
  const Cm = ratDiv(c, a);
  const Dm = ratDiv(d, a);
  const Em = ratDiv(e, a);

  // Depressed quartic coefficients:
  //   p = C − 3 B²/8
  //   q = D − B C / 2 + B³ / 8
  //   r = E − B D / 4 + B² C / 16 − 3 B⁴ / 256
  const B2 = ratMul(Bm, Bm);
  const B3 = ratMul(B2, Bm);
  const B4 = ratMul(B2, B2);
  const p_q = ratSub(Cm, ratMul(r(3n, 8n), B2));
  const q_q = ratAdd(
    ratSub(Dm, ratMul(r(1n, 2n), ratMul(Bm, Cm))),
    ratMul(r(1n, 8n), B3),
  );
  const r_q = ratAdd(
    ratSub(
      ratSub(Em, ratMul(r(1n, 4n), ratMul(Bm, Dm))),
      ratMul(r(-1n, 16n), ratMul(B2, Cm)),
    ),
    ratMul(r(-3n, 256n), B4),
  );

  // Biquadratic fast path: when q = 0 in the depressed quartic, the
  // problem reduces to a quadratic in y².  Standard Ferrari produces
  // a m₀ = 0 root in the resolvent cubic, then divides by √(2m₀) — a
  // 0/0 indeterminacy.  Special-case here:
  //
  //     y⁴ + p y² + r = 0    ⟹   y² ∈ roots of  s² + p s + r = 0
  //
  // and then `y = ±√(s)` for each `s`.
  if (q_q.n === 0n) {
    const ratToVal = ratToValue;
    const [sPlus, sMinus] = quadraticRoots(makeRat(1n, 1n), p_q, r_q);
    const yRoots: Value[] = [
      eSqrt(sPlus), eNeg(eSqrt(sPlus)),
      eSqrt(sMinus), eNeg(eSqrt(sMinus)),
    ];
    const shift = ratToVal(makeRat(-Bm.n, Bm.d * 4n));
    return [
      eAdd(yRoots[0]!, shift),
      eAdd(yRoots[1]!, shift),
      eAdd(yRoots[2]!, shift),
      eAdd(yRoots[3]!, shift),
    ];
  }

  // Resolvent cubic: 8 m³ + 8p m² + (2p² − 8r) m − q² = 0
  // Cardano expects (a, b, c, d) for a x³ + b x² + c x + d = 0.
  const res_a = r(8n);
  const res_b = ratMul(r(8n), p_q);
  const res_c = ratSub(ratMul(r(2n), ratMul(p_q, p_q)), ratMul(r(8n), r_q));
  const res_d = ratMul(r(-1n), ratMul(q_q, q_q));

  // Take the first cubic root and use it as m₀.
  const cubic_roots = cubicRoots(res_a, res_b, res_c, res_d);
  const m0 = cubic_roots[0];

  // Build the two quadratic factors of the depressed quartic in y:
  //   y² ± √(2 m₀) y + (p/2 + m₀ ∓ q / (2 √(2 m₀))) = 0
  const sqrt2m0 = eSqrt(eMul(E_TWO, m0));
  const pHalf = ratToValue(ratMul(p_q, r(1n, 2n)));
  const qExpr = ratToValue(q_q);
  // q / (2 · √(2m₀))
  const qOverSqrt = eDiv(qExpr, eMul(E_TWO, sqrt2m0));
  const constPlus = eSub(eAdd(pHalf, m0), qOverSqrt);
  const constMinus = eAdd(eAdd(pHalf, m0), qOverSqrt);

  // Quadratic 1: y² + √(2m₀) y + constPlus = 0  ⟹  use formula directly.
  // We've extended `quadraticRoots` for *rational* coefficients; here
  // the coefficients are *expression* Values, so we apply the formula
  // inline rather than calling `quadraticRoots`.
  const quadFormula = (B: Value, C: Value): [Value, Value] => {
    // y = (−B ± √(B² − 4C)) / 2
    const Bsq = ePow(B, 2n);
    const fourC = eMul(E_FOUR, C);
    const disc = eSub(Bsq, fourC);
    const sqrtDisc = eSqrt(disc);
    const negB = eNeg(B);
    return [
      eDiv(eAdd(negB, sqrtDisc), E_TWO),
      eDiv(eSub(negB, sqrtDisc), E_TWO),
    ];
  };

  const [y1, y2] = quadFormula(sqrt2m0, constPlus);
  const [y3, y4] = quadFormula(eNeg(sqrt2m0), constMinus);

  // Un-shift: x = y − B/4.
  const shift = ratToValue(ratMul(r(-1n, 4n), Bm));
  return [
    eAdd(y1, shift),
    eAdd(y2, shift),
    eAdd(y3, shift),
    eAdd(y4, shift),
  ];
}

// silence unused-import lint
void sym;
void E_ZERO;
void E_ONE;
void E_HALF;
void E_THREE;
