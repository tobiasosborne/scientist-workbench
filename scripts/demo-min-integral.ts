// =============================================================================
// demo-min-integral.ts — exercise cas-simplify + integrate-1d + optimize-lbfgs-projected
// =============================================================================
//
// Problem statement (interactive exploration, not a permanent test):
//
//     minimise   I(a) = ∫_{-1}^{1} (1 - a x)(2 + x)(3/7 + a x) / (x² - 49)  dx
//     over       a ∈ [-1, 1]
//
// Key structural observation that makes the chain work:
//
//   The integrand is *quadratic in a* with x-dependent coefficients —
//
//       (1 - a x)(3/7 + a x) = 3/7 + (4/7) a x − a² x²
//
//   so
//
//       p(x, a) = (2 + x)(3/7)/(x²−49)
//               + (2 + x)(4/7) x · a / (x²−49)
//               − (2 + x) x²    · a² / (x²−49)
//               = p₀(x) + p₁(x) · a + p₂(x) · a²
//
//   Therefore I(a) = α + β·a + γ·a², a closed-form 1-D quadratic in a,
//   with α, β, γ the three definite integrals of p₀, p₁, p₂ over [−1, 1].
//
// That decomposition is what lets us compose the three tools cleanly:
//
//   1. `cas-simplify` — canonicalises the original integrand (mostly a
//      sanity demo here; cas-simplify does NOT do GCD-reduction on
//      rational functions, so we still hand-decompose the powers of a).
//   2. `integrate-1d` — three QUADPACK-G7K15 calls compute α, β, γ.
//   3. `optimize-lbfgs-projected` — minimises the resulting closed-form
//      quadratic in a over [−1, 1]. This is overkill for a 1-D quadratic
//      (the analytic minimiser is one line) but the point is to show
//      the optimiser pipes cleanly off the integrate-1d outputs.

import {
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  rat,
  record,
  sym,
  type Value,
} from "@workbench/protocol";
import { loadWorkbench, typed } from "@workbench/compose";

// -----------------------------------------------------------------------------
// Tiny helpers for unwrapping output Values
// -----------------------------------------------------------------------------

function field(rec: Value, name: string): Value {
  if (rec.kind !== "record") throw new Error(`expected record, got ${rec.kind}`);
  const f = rec.fields[name];
  if (f === undefined) throw new Error(`record has no field ${name}`);
  return f;
}

function asFloat64(v: Value): number {
  if (v.kind !== "float64") throw new Error(`expected float64, got ${v.kind}`);
  return float64ToNumber(v);
}

function asString(v: Value): string {
  if (v.kind !== "string") throw new Error(`expected string, got ${v.kind}`);
  return v.value;
}

function asBoolean(v: Value): boolean {
  if (v.kind !== "boolean") throw new Error(`expected boolean, got ${v.kind}`);
  return v.value;
}

// -----------------------------------------------------------------------------
// Build the integrand and its three a-power coefficients as expression Values
// -----------------------------------------------------------------------------

const x = sym("x");
const a = sym("a");

// (1 - a*x)
const oneMinusAx = expr("-", [int(1), expr("*", [a, x])]);
// (2 + x)
const twoPlusX = expr("+", [int(2), x]);
// (3/7 + a*x)
const threeOverSevenPlusAx = expr("+", [rat(3, 7), expr("*", [a, x])]);
// numerator = (1-a*x) * (2+x) * (3/7 + a*x)
const numerator = expr("*", [
  expr("*", [oneMinusAx, twoPlusX]),
  threeOverSevenPlusAx,
]);
// x² − 49
const xSquared = expr("^", [x, int(2)]);
const denominator = expr("-", [xSquared, int(49)]);
// p(x, a)
const p = expr("/", [numerator, denominator]);

// p₀(x) = (3/7)(2+x)/(x²−49)
const p0 = expr("/", [expr("*", [rat(3, 7), twoPlusX]), denominator]);
// p₁(x) = (4/7) x (2+x) / (x²−49)
const p1 = expr("/", [
  expr("*", [expr("*", [rat(4, 7), x]), twoPlusX]),
  denominator,
]);
// p₂(x) = − x² (2+x) / (x²−49)
const p2 = expr("/", [
  expr("neg", [expr("*", [xSquared, twoPlusX])]),
  denominator,
]);

// -----------------------------------------------------------------------------
// Run the chain
// -----------------------------------------------------------------------------

async function main() {
  const wb = typed(await loadWorkbench());

  // ---- Step 1: cas-simplify the original integrand ------------------------
  console.log("=== Step 1: cas-simplify(p(x, a)) ===");
  const pSimp = await wb.casSimplify(p);
  console.log("Canonical-form integrand:");
  console.log(JSON.stringify(pSimp));
  console.log();

  // ---- Step 2: integrate-1d on each a-power coefficient -------------------
  async function integrate(piece: Value, label: string): Promise<number> {
    const out = await wb.integrate1d(record({
      f: piece,
      var: x,
      a: float64FromNumber(-1),
      b: float64FromNumber(1),
    }));
    if (out.kind === "tagged") {
      throw new Error(`integrate-1d refused on ${label}: ${out.tag}`);
    }
    const value = asFloat64(field(out, "value"));
    const errEst = asFloat64(field(out, "error_estimate"));
    const nEvals = field(out, "n_evals");
    const converged = asBoolean(field(out, "converged"));
    console.log(
      `  ∫ ${label}  =  ${value.toExponential(15)}  ` +
      `(±${errEst.toExponential(2)}, n_evals=${nEvals.kind === "integer" ? nEvals.value : "?"}, ` +
      `converged=${converged})`,
    );
    return value;
  }

  console.log("=== Step 2: integrate-1d on the three a-power pieces ===");
  const alpha = await integrate(p0, "p₀(x)            (a⁰ coeff)");
  const beta  = await integrate(p1, "p₁(x)            (a¹ coeff)");
  const gamma = await integrate(p2, "p₂(x)            (a² coeff)");
  console.log();
  console.log(`I(a) = α + β·a + γ·a²`);
  console.log(`     α = ${alpha}`);
  console.log(`     β = ${beta}`);
  console.log(`     γ = ${gamma}`);
  console.log();

  // Analytic prediction for the 1-D quadratic (sanity check before the
  // optimiser runs): if γ > 0, vertex a* = −β/(2γ), check it lies in
  // [−1, 1]; otherwise the minimum is at a boundary.
  const vertex = -beta / (2 * gamma);
  const vertexInside = vertex >= -1 && vertex <= 1;
  console.log(`Analytic vertex of the quadratic: a* = ${vertex} (inside [-1,1]: ${vertexInside})`);
  if (gamma > 0 && vertexInside) {
    const fAtVertex = alpha + beta * vertex + gamma * vertex * vertex;
    console.log(`f(a*) at vertex = ${fAtVertex}`);
  }
  const fAtMinusOne = alpha + beta * (-1) + gamma * 1;
  const fAtPlusOne  = alpha + beta * (+1) + gamma * 1;
  console.log(`f(-1) = ${fAtMinusOne}`);
  console.log(`f(+1) = ${fAtPlusOne}`);
  console.log();

  // ---- Step 3: optimize-lbfgs-projected on f(a) = α + β·a + γ·a² ----------
  // f(a) = α + β·a + γ·a²        →   expression
  // f'(a) = β + 2γ·a              →   gradient component
  const alphaLeaf = float64FromNumber(alpha);
  const betaLeaf  = float64FromNumber(beta);
  const gammaLeaf = float64FromNumber(gamma);
  const twoGammaLeaf = float64FromNumber(2 * gamma);

  const fA = expr("+", [
    expr("+", [
      alphaLeaf,
      expr("*", [betaLeaf, a]),
    ]),
    expr("*", [gammaLeaf, expr("^", [a, int(2)])]),
  ]);
  const dfA = expr("+", [betaLeaf, expr("*", [twoGammaLeaf, a])]);

  console.log("=== Step 3: optimize-lbfgs-projected on f(a) = α + β·a + γ·a² ===");
  const optInput = record({
    f: fA,
    grad: list([dfA]),
    vars: list([a]),
    x0: list([float64FromNumber(0)]),
    bounds: list([list([float64FromNumber(-1), float64FromNumber(1)])]),
  });
  const optOut = await wb.optimizeLbfgsProjected(optInput);
  if (optOut.kind === "tagged") {
    throw new Error(`optimize refused: ${optOut.tag}`);
  }

  const xList = field(optOut, "x");
  if (xList.kind !== "list") throw new Error("expected x to be a list");
  const aStar = asFloat64(xList.items[0] as Value);
  const fStar = asFloat64(field(optOut, "fun"));
  const gradInfNorm = asFloat64(field(optOut, "grad_inf_norm"));
  const success = asBoolean(field(optOut, "success"));
  const statusMessage = asString(field(optOut, "status_message"));
  const iterations = field(optOut, "iterations");
  const itStr = iterations.kind === "integer" ? iterations.value : "?";

  console.log(`  a*           = ${aStar}`);
  console.log(`  f(a*)        = ${fStar}`);
  console.log(`  |∇f|_∞       = ${gradInfNorm}`);
  console.log(`  iterations   = ${itStr}`);
  console.log(`  status       = ${statusMessage} (success=${success})`);
  console.log();
  console.log("Cross-check: optimiser a* vs analytic vertex −β/(2γ):");
  console.log(`  optimiser:  ${aStar}`);
  console.log(`  analytic :  ${vertex}`);
  console.log(`  Δ        :  ${Math.abs(aStar - vertex).toExponential(3)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
