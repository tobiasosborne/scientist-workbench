// HSDE LP solver on AFIRO from NETLIB — Phase 1 acceptance per
// HANDOFF §2 Phase 1. AFIRO is a small (m=27, n=32) LP that all
// modern IPM solvers (Mosek, COPT, the legacy `solveLp`) handle
// cleanly. If the HSDE LP path doesn't converge on AFIRO,
// something is fundamentally broken.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { solveHsdeLp, lpFromCanonical, type CanonicalLp } from "../src/index.js";

const corpus = JSON.parse(
  readFileSync(
    "/home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-netlib/golden/inputs.json",
    "utf-8",
  ),
);

const cases: { id: string; input: CanonicalLp }[] = corpus.cases;
const afiro = cases.find((c) => c.id === "afiro")!;

describe("afiro NETLIB LP via HSDE", () => {
  test("solves to optimality near -464.75314", () => {
    const res = solveHsdeLp(lpFromCanonical(afiro.input));
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - -464.7531428571429)).toBeLessThan(1e-4);
    expect(res.tau).toBeGreaterThan(1e-6);
    expect(res.kappa / res.tau).toBeLessThan(1e-3);
  });
});
