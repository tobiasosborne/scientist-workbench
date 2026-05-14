import { describe, expect, test } from "bun:test";
import {
  solveLp,
  lpFromCanonical,
  formatIterHeader,
  formatIterLine,
  type CanonicalLp,
} from "../src/index.js";
import { loadSuite } from "./corpus.js";

const suite = loadSuite<CanonicalLp>("lp-netlib");

// Corpus-missing handling follows the convention codified in `corpus.ts`
// and used by `netlib.test.ts` / `lp-small.test.ts`: skip with a clear
// reason, never silently green and never red — a missing optional corpus
// is not a regression.
if (suite === null) {
  describe.skip("afiro NETLIB LP (corpus not found)", () => {
    test("set WORKBENCH_CORPUS or place scientist-workbench-corpus alongside the workbench", () => {});
  });
} else {
  const afiro = suite.cases.find((c) => c.id === "afiro");

  describe("afiro NETLIB LP", () => {
    test("solves to optimality near -464.75314", () => {
      expect(afiro).toBeDefined();
      const log: string[] = [];
      log.push(formatIterHeader());
      const res = solveLp(lpFromCanonical(afiro!.input), {
        log: (line) => log.push(formatIterLine(line)),
      });
      console.log("\n" + log.join("\n"));
      console.log("\nFinal status:", res.status);
      console.log("Final primal obj:", res.iterate.primalObj);
      console.log("Final dual obj:", res.iterate.dualObj);
      console.log("Final mu:", res.iterate.mu);
      expect(res.status).toBe("optimal");
      expect(Math.abs(res.iterate.primalObj - -464.7531428571429)).toBeLessThan(1e-4);
    });
  });
}
