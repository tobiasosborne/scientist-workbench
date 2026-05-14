// HSDE LP solver on brandy from NETLIB. The legacy `solveLp` path
// hits `numerical-error` around iter 18 on this case (worklog 095;
// bead j1gd tracks the underlying Schur-row collapse). HSDE
// dissolves the issue structurally: τ absorbs the boundary
// approach that triggers the legacy path's `αP → 0` stall. Per
// HANDOFF §2 Phase 1 acceptance: "brandy resolved or returns clean
// tagged refusal". This is the "resolved" branch.

import { describe, expect, test } from "bun:test";
import { solveHsdeLp, lpFromCanonical, type CanonicalLp } from "../src/index.js";
import { loadSuite } from "./corpus.js";

const suite = loadSuite<CanonicalLp>("lp-netlib");

// Corpus-missing handling follows the `corpus.ts` convention (skip with a
// clear reason), matching `netlib.test.ts` / `lp-small.test.ts`.
if (suite === null) {
  describe.skip("brandy NETLIB LP via HSDE (corpus not found)", () => {
    test("set WORKBENCH_CORPUS or place scientist-workbench-corpus alongside the workbench", () => {});
  });
} else {
  const brandy = suite.cases.find((c) => c.id === "brandy");

  describe("brandy NETLIB LP via HSDE", () => {
    test("solves to optimality near 1518.5099 (legacy path numerical-errors here)", () => {
      expect(brandy).toBeDefined();
      const res = solveHsdeLp(lpFromCanonical(brandy!.input), {
        params: { iterLimit: 300 },
      });
      expect(res.status).toBe("optimal");
      expect(Math.abs(res.primalObj - 1518.5098964881047)).toBeLessThan(1e-3);
      expect(res.achievedPrecision).toBeLessThanOrEqual(1);
      expect(res.tau).toBeGreaterThan(1e-6);
      // κ → 0 confirms optimal branch (not certificate)
      expect(res.kappa / res.tau).toBeLessThan(1e-6);
    });
  });
}
