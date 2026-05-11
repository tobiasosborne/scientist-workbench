import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { solveLp, lpFromCanonical, type CanonicalLp } from "../src/index.js";

const corpus = JSON.parse(
  readFileSync(
    "/home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-netlib/golden/inputs.json",
    "utf-8",
  ),
);

const expected = JSON.parse(
  readFileSync(
    "/home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-netlib/golden/expected.json",
    "utf-8",
  ),
);

const expByCase: Record<string, { status: string; objective?: number }> = {};
for (const c of expected.cases ?? []) expByCase[c.id] = c.expected;

const cases: { id: string; input: CanonicalLp }[] = corpus.cases;

describe("NETLIB LP sweep", () => {
  for (const c of cases) {
    test(c.id, () => {
      const start = performance.now();
      const res = solveLp(lpFromCanonical(c.input));
      const ms = Math.round(performance.now() - start);
      const exp = expByCase[c.id];
      const objExp = exp?.objective;
      const objGot = res.iterate.primalObj;
      const relErr =
        typeof objExp === "number" && Number.isFinite(objExp)
          ? Math.abs(objGot - objExp) / Math.max(1, Math.abs(objExp))
          : NaN;
      console.log(
        `${c.id.padEnd(12)} status=${res.status.padEnd(20)} iters=${String(res.iterate.iter).padStart(3)} ` +
          `obj=${objGot.toExponential(6)} exp=${objExp?.toExponential(6) ?? "?"} relErr=${relErr.toExponential(2)} t=${ms}ms`,
      );
    });
  }
});
