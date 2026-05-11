import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { solveLp, lpFromCanonical, type CanonicalLp } from "../src/index.js";

const corpus = JSON.parse(
  readFileSync(
    "/home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-small/golden/inputs.json",
    "utf-8",
  ),
);
const expected = JSON.parse(
  readFileSync(
    "/home/tobias/Projects/scientist-workbench-corpus/benchmarks/lp-small/golden/expected.json",
    "utf-8",
  ),
);

const expByCase: Record<string, { status: string; objective?: number }> = {};
for (const c of expected.cases ?? []) expByCase[c.id] = c.expected;

const cases: { id: string; input: CanonicalLp }[] = corpus.cases;

describe("lp-small pathological sweep", () => {
  for (const c of cases) {
    test(c.id, () => {
      let res: ReturnType<typeof solveLp> | { status: string; iterate: { iter: number; primalObj: number } };
      try {
        res = solveLp(lpFromCanonical(c.input as CanonicalLp));
      } catch (e) {
        res = { status: `error:${(e as Error).message.slice(0, 30)}`, iterate: { iter: 0, primalObj: NaN } };
      }
      const exp = expByCase[c.id];
      const objExp = exp?.objective;
      const objGot = res.iterate.primalObj;
      const relErr =
        typeof objExp === "number" && Number.isFinite(objExp)
          ? Math.abs(objGot - objExp) / Math.max(1, Math.abs(objExp))
          : NaN;
      console.log(
        `${c.id.padEnd(36)} got=${res.status.padEnd(22)} exp=${(exp?.status ?? "?").padEnd(10)} iters=${String(res.iterate.iter).padStart(3)} obj=${objGot.toExponential(4)} exp=${objExp?.toExponential(4) ?? "?"} relErr=${relErr.toExponential(2)}`,
      );
    });
  }
});
