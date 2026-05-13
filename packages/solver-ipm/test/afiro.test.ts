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
const afiro = suite?.cases.find((c) => c.id === "afiro") ?? null;

describe("afiro NETLIB LP", () => {
  test("solves to optimality near -464.75314", () => {
    if (afiro === null) {
      throw new Error("lp-netlib corpus missing; set WORKBENCH_CORPUS or place scientist-workbench-corpus alongside the workbench");
    }
    const log: string[] = [];
    log.push(formatIterHeader());
    const res = solveLp(lpFromCanonical(afiro.input), {
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
