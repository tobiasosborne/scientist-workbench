import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  solveLp,
  lpFromCanonical,
  formatIterHeader,
  formatIterLine,
  type CanonicalLp,
} from "../src/index.js";

const corpus = JSON.parse(
  readFileSync(
    "/home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-netlib/golden/inputs.json",
    "utf-8",
  ),
);

const cases: { id: string; input: CanonicalLp }[] = corpus.cases;
const afiro = cases.find((c) => c.id === "afiro")!;

describe("afiro NETLIB LP", () => {
  test("solves to optimality near -464.75314", () => {
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
