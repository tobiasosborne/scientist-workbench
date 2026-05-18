// HSDE LP solver on AFIRO from NETLIB — Phase 1 acceptance per
// HANDOFF §2 Phase 1. AFIRO is a small (m=27, n=32) LP that all
// modern IPM solvers (Mosek, COPT, the legacy `solveLp`) handle
// cleanly. If the HSDE LP path doesn't converge on AFIRO,
// something is fundamentally broken.

import { describe, expect, test } from "bun:test";
import { solveHsdeLp, lpFromCanonical, type CanonicalLp } from "../src/index.js";
import { loadSuite } from "./corpus.js";

const suite = loadSuite<CanonicalLp>("lp-netlib");

// Corpus-missing handling follows the `corpus.ts` convention (skip with a
// clear reason), matching `netlib.test.ts` / `lp-small.test.ts`.
if (suite === null) {
  describe.skip("afiro NETLIB LP via HSDE (corpus not found)", () => {
    test("set WORKBENCH_CORPUS or place scientist-workbench-corpus alongside the workbench", () => {});
  });
} else {
  const afiro = suite.cases.find((c) => c.id === "afiro");

  describe("afiro NETLIB LP via HSDE", () => {
    test("solves to optimality near -464.75314", () => {
      expect(afiro).toBeDefined();
      const res = solveHsdeLp(lpFromCanonical(afiro!.input));
      expect(res.status).toBe("optimal");
      expect(Math.abs(res.primalObj - -464.7531428571429)).toBeLessThan(1e-4);
      expect(res.tau).toBeGreaterThan(1e-6);
      expect(res.kappa / res.tau).toBeLessThan(1e-3);
    });
  });
}
