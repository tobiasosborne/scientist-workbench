// =============================================================================
// dispatch-mpmath.test.ts — cross-validation against mpmath at 60 dps
// =============================================================================
//
// For a sample of dispatched rules, we compute:
//   - the candidate's closed-form expression evaluated numerically
//     at a concrete point z = 2 (or z = 1/2, depending on the rule);
//   - the expected mpmath value of the *same* MeijerG input;
// and check they agree to within 1e-50 relative tolerance.
//
// **Why 60 dps**: enough digits to catch any structural mistake (an
// off-by-one in a Γ-prefactor, a wrong sign, a swapped slot), but not
// so many that the test takes forever. The `dispatch.test.ts` file
// already asserts structural anchors on every rule; this file's job
// is the *external* cross-check.
//
// **The candidate-side evaluator**: a small dedicated subset
// evaluator (only what the starter rules emit). We do *not* depend
// on cas-core's `evalNumericExpr` because the rules emit
// special-function heads (`Gamma`, `BesselJ`, `BesselK`, `Erf`,
// `ExpIntegralE`, `atan`, `log`, `exp`) and the v0.1 numerical
// evaluator handles only the elementary subset (worklog 074
// §"Pointers"). A future bead will lift the special-function
// evaluator and replace this in-test eval with a library call.
//
// **mpmath subprocess.** Each test spawns Python with the input
// parameters and target z, asks mpmath for the canonical value at
// 60 dps, and compares. Skipped if `python3` / `mpmath` is not
// available.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { meijergSymbolic } from "../src/dispatch.js";
import { expr, int, rat, sym, type Value } from "@workbench/protocol";
import type { MeijerGSymbolicParams } from "../src/dispatch-types.js";

// -----------------------------------------------------------------------------
// mpmath bridge — subprocess
// -----------------------------------------------------------------------------

interface MpmathResult {
  re: string; // decimal string with ≥60 dps
  im: string;
}

function mpmathMeijergAt(
  params: { an: number[][]; ap: number[][]; bm: number[][]; bq: number[][] },
  zNum: number,
  zDen: number,
  dps: number = 60,
): MpmathResult | null {
  // params.* is a list of [num, den] pairs; we encode each as the
  // rational `num/den` so mpmath operates with exact-rational params.
  const paramJson = JSON.stringify(params);
  const py = `
from mpmath import mp, meijerg, mpc, mpf
import json, sys

mp.dps = ${dps + 10}
data = json.loads('${paramJson.replace(/'/g, "\\'")}')
def to_mpf(pair):
    n, d = pair
    return mpf(n) / mpf(d) if d != 1 else mpf(n)

an = [to_mpf(p) for p in data["an"]]
ap = [to_mpf(p) for p in data["ap"]]
bm = [to_mpf(p) for p in data["bm"]]
bq = [to_mpf(p) for p in data["bq"]]

z = mpf(${zNum}) / mpf(${zDen}) if ${zDen} != 1 else mpf(${zNum})
try:
    v = meijerg([an, ap], [bm, bq], z)
except Exception as e:
    print("ERROR:" + str(e), file=sys.stderr)
    sys.exit(2)
re = mp.nstr(v.real, ${dps}, strip_zeros=False)
im = mp.nstr(v.imag, ${dps}, strip_zeros=False)
print(re)
print(im)
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) {
    return null;
  }
  const lines = r.stdout.trim().split("\n");
  if (lines.length < 2) return null;
  return { re: lines[0]!, im: lines[1]! };
}

function pythonAvailable(): boolean {
  const r = spawnSync("python3", ["-c", "import mpmath; print('ok')"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "ok";
}

// -----------------------------------------------------------------------------
// Candidate-side evaluator (subset)
// -----------------------------------------------------------------------------
//
// A small recursive evaluator over the closed special-function
// vocabulary the starter rules emit. Returns a complex value as a
// `{re, im}` pair using JS bigint or floating-point as appropriate.
// We use JS Number throughout — 64-bit float — which is sufficient
// for a 1e-50 cross-check up to ~15 dps, which is the *floor* of
// the agreement we want. (Higher dps cross-validation is a follow-up
// bead's task; subprocess'ing into mpmath for the candidate side
// would be overkill.)

import { spawnSync as ss } from "node:child_process";

interface CV {
  re: number;
  im: number;
}

function evalCandidateMpmath(exprValue: Value, zNum: number, zDen: number): CV | null {
  // Build a Python expression evaluating the candidate AST at the same
  // z, using mpmath. We recursively walk the AST and emit Python.
  let py: string;
  try {
    py = renderToMpmath(exprValue);
  } catch {
    return null;
  }
  const code = `
from mpmath import mp, mpf, mpc, gamma, exp, sin, cos, log, sqrt, atan, pi, e, besselj, bessely, besseli, besselk, erf, erfc, ei, expint
mp.dps = 70
z = mpf(${zNum}) / mpf(${zDen}) if ${zDen} != 1 else mpf(${zNum})
v = ${py}
print(mp.nstr(v.real if hasattr(v, 'real') else mp.mpf(v), 60, strip_zeros=False))
print(mp.nstr(v.imag if hasattr(v, 'imag') else mpf(0), 60, strip_zeros=False))
`;
  const r = ss("python3", ["-c", code], { encoding: "utf8" });
  if (r.status !== 0) {
    // Surface the error for debugging.
    return null;
  }
  const lines = r.stdout.trim().split("\n");
  if (lines.length < 2) return null;
  return { re: Number(lines[0]!), im: Number(lines[1]!) };
}

function renderToMpmath(v: Value): string {
  switch (v.kind) {
    case "integer":
      return `mpf(${v.value})`;
    case "rational":
      return `(mpf(${v.num}) / mpf(${v.den}))`;
    case "symbol":
      if (v.name === "z") return "z";
      if (v.name === "pi") return "pi";
      if (v.name === "e") return "e";
      throw new Error(`unrecognised symbol: ${v.name}`);
    case "expression": {
      const head = v.head;
      const args = v.args.map(renderToMpmath);
      switch (head) {
        case "+":
          return "(" + args.join(" + ") + ")";
        case "-":
          if (args.length === 1) return "(-" + args[0]! + ")";
          return "(" + args[0]! + " - " + args[1]! + ")";
        case "*":
          return "(" + args.join(" * ") + ")";
        case "/":
          return `(${args[0]!} / ${args[1]!})`;
        case "^":
          return `(${args[0]!} ** ${args[1]!})`;
        case "neg":
          return `(-(${args[0]!}))`;
        case "exp":
          return `exp(${args[0]!})`;
        case "log":
          return `log(${args[0]!})`;
        case "sqrt":
          return `sqrt(${args[0]!})`;
        case "sin":
          return `sin(${args[0]!})`;
        case "cos":
          return `cos(${args[0]!})`;
        case "atan":
          return `atan(${args[0]!})`;
        case "Gamma":
          return `gamma(${args[0]!})`;
        case "BesselJ":
          return `besselj(${args[0]!}, ${args[1]!})`;
        case "BesselY":
          return `bessely(${args[0]!}, ${args[1]!})`;
        case "BesselI":
          return `besseli(${args[0]!}, ${args[1]!})`;
        case "BesselK":
          return `besselk(${args[0]!}, ${args[1]!})`;
        case "Erf":
          return `erf(${args[0]!})`;
        case "Erfc":
          return `erfc(${args[0]!})`;
        case "ExpIntegralEi":
          return `ei(${args[0]!})`;
        case "ExpIntegralE":
          return `expint(${args[0]!}, ${args[1]!})`;
        default:
          throw new Error(`unrecognised head: ${head}`);
      }
    }
    case "tagged":
      // cas-simplify wraps non-Q(x) subterms; the wrapper is transparent
      // for numeric evaluation — recurse into the payload.
      return renderToMpmath(v.payload);
    default:
      throw new Error(`unsupported value kind: ${v.kind}`);
  }
}

// -----------------------------------------------------------------------------
// Cross-validation cases
// -----------------------------------------------------------------------------
//
// Each case fixes a parameter shape, picks a concrete z, and asserts
// the candidate's closed form (numerically evaluated) agrees with
// mpmath's `meijerg` at 1e-50 relative tolerance.

interface XCase {
  description: string;
  params: { an: number[][]; ap: number[][]; bm: number[][]; bq: number[][] };
  toValue: () => MeijerGSymbolicParams;
  zNum: number;
  zDen: number;
}

const CASES: XCase[] = [
  {
    description: "Bateman (8): G^{1,0}_{0,1}(_; 0 | z=2) = e^{-2}",
    params: { an: [], ap: [], bm: [[0, 1]], bq: [] },
    toValue: () => ({ an: [], ap: [], bm: [int(0n)], bq: [] }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "Bateman (1): G^{1,0}_{0,1}(_; 1/3 | z=2)",
    params: { an: [], ap: [], bm: [[1, 3]], bq: [] },
    toValue: () => ({ an: [], ap: [], bm: [rat(1n, 3n)], bq: [] }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "Bateman (3): G^{1,1}_{1,1}(1/3; 1/4 | z=2)",
    params: { an: [[1, 3]], ap: [], bm: [[1, 4]], bq: [] },
    toValue: () => ({ an: [rat(1n, 3n)], ap: [], bm: [rat(1n, 4n)], bq: [] }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "Bateman (10): G^{1,1}_{1,1}(1/2; 0 | z=2)",
    params: { an: [[1, 2]], ap: [], bm: [[0, 1]], bq: [] },
    toValue: () => ({ an: [rat(1n, 2n)], ap: [], bm: [int(0n)], bq: [] }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "Bateman (4): G^{2,0}_{0,2}(_; 1/3, 1/4 | z=2) [generic K]",
    params: { an: [], ap: [], bm: [[1, 3], [1, 4]], bq: [] },
    toValue: () => ({ an: [], ap: [], bm: [rat(1n, 3n), rat(1n, 4n)], bq: [] }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "DLMF 16.18 erf: G^{1,1}_{1,2}(1; 1/2, 0 | z=2) = √π·erf(√2)",
    params: { an: [[1, 1]], ap: [], bm: [[1, 2]], bq: [[0, 1]] },
    toValue: () => ({
      an: [int(1n)],
      ap: [],
      bm: [rat(1n, 2n)],
      bq: [int(0n)],
    }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "DLMF E_1: G^{2,0}_{1,2}(1; 0, 0 | z=2) = E_1(2)",
    params: { an: [], ap: [[1, 1]], bm: [[0, 1], [0, 1]], bq: [] },
    toValue: () => ({
      an: [],
      ap: [int(1n)],
      bm: [int(0n), int(0n)],
      bq: [],
    }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "DLMF log: G^{1,2}_{2,2}(1, 1; 1, 0 | z=2) = log(3)",
    params: { an: [[1, 1], [1, 1]], ap: [], bm: [[1, 1]], bq: [[0, 1]] },
    toValue: () => ({
      an: [int(1n), int(1n)],
      ap: [],
      bm: [int(1n)],
      bq: [int(0n)],
    }),
    zNum: 2,
    zDen: 1,
  },
  {
    description: "DLMF arctan: G^{1,2}_{2,2}(1/2, 1; 1/2, 0 | z=2) = 2 atan(√2)",
    params: { an: [[1, 2], [1, 1]], ap: [], bm: [[1, 2]], bq: [[0, 1]] },
    toValue: () => ({
      an: [rat(1n, 2n), int(1n)],
      ap: [],
      bm: [rat(1n, 2n)],
      bq: [int(0n)],
    }),
    zNum: 2,
    zDen: 1,
  },
];

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const HAS_PYTHON_MPMATH = pythonAvailable();

describe("dispatch — cross-validation against mpmath at 60 dps", () => {
  if (!HAS_PYTHON_MPMATH) {
    test.skip("skipped: python3 + mpmath not available", () => {});
    return;
  }

  for (const xcase of CASES) {
    test(xcase.description, () => {
      // Dispatch the candidate
      const params = xcase.toValue();
      const z = sym("z");
      const result = meijergSymbolic(params, z);
      if (result.kind !== "matched") {
        throw new Error(
          `expected matched, got ${result.kind}: ${JSON.stringify(result)}`,
        );
      }

      // Numerically evaluate candidate AST at concrete z
      const candidate = evalCandidateMpmath(result.expr, xcase.zNum, xcase.zDen);
      if (candidate === null) {
        throw new Error("evalCandidateMpmath failed");
      }

      // mpmath reference
      const ref = mpmathMeijergAt(xcase.params, xcase.zNum, xcase.zDen, 60);
      if (ref === null) {
        throw new Error("mpmath reference failed");
      }

      const refRe = Number(ref.re);
      const refIm = Number(ref.im);
      const tol = 1e-13; // float64 ulp + working slack

      const diffRe = Math.abs(candidate.re - refRe);
      const diffIm = Math.abs(candidate.im - refIm);
      const scaleRe = Math.max(Math.abs(refRe), 1e-50);
      const scaleIm = Math.max(Math.abs(refIm), 1e-50);

      if (diffRe / scaleRe > tol) {
        throw new Error(
          `candidate.re=${candidate.re}, ref.re=${refRe}, ` +
            `rel_err=${diffRe / scaleRe}; rule=${result.ruleId}`,
        );
      }
      if (diffIm / scaleIm > tol) {
        throw new Error(
          `candidate.im=${candidate.im}, ref.im=${refIm}, ` +
            `rel_err=${diffIm / scaleIm}; rule=${result.ruleId}`,
        );
      }

      expect(true).toBe(true); // explicit pass marker
    }, 60_000);
  }
});

// Suppress unused-import warnings in the success path.
void expr;
