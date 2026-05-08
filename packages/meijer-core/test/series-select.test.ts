// =============================================================================
// series-selection rule tests
// =============================================================================
//
// Pure dispatcher; we exhaustively enumerate the (p, q, m, n) shapes
// near the decision boundaries and check the selector lands on the
// expected series (or quarantine flag).

import { describe, expect, test } from "bun:test";
import { cfromInts, cfromStrings } from "@workbench/bigfloat";
import { selectSeries } from "../src/series-select.js";
import type { MeijerGParameters } from "../src/types.js";

function P(
  an: bigint[],
  ap: bigint[],
  bm: bigint[],
  bq: bigint[],
): MeijerGParameters {
  const prec = 50;
  return {
    an: an.map((x) => cfromInts(x, 0n, prec)),
    ap: ap.map((x) => cfromInts(x, 0n, prec)),
    bm: bm.map((x) => cfromInts(x, 0n, prec)),
    bq: bq.map((x) => cfromInts(x, 0n, prec)),
  };
}

describe("selectSeries", () => {
  test("p < q ⟹ series 1", () => {
    // G^{1,0}_{0,1}: m=1, n=0, p=0, q=1.
    const sel = selectSeries(P([], [], [1n], []), cfromInts(2n, 0n, 50));
    expect(sel.series).toBe(1);
    expect(sel.quarantine).toBe(false);
  });

  test("p > q ⟹ series 2", () => {
    // G^{0,1}_{1,0}: m=0, n=1, p=1, q=0.
    const sel = selectSeries(P([1n], [], [], []), cfromInts(2n, 0n, 50));
    expect(sel.series).toBe(2);
  });

  test("p == q == m+n with |z| > 1 ⟹ series 2", () => {
    // G^{1,1}_{1,1}: m=1, n=1, p=1, q=1, m+n=2≠p=1. Hmm not this shape.
    // Use G^{1,1}_{2,2}: an=[a1], ap=[a2], bm=[b1], bq=[b2]. m=1, n=1, p=2, q=2, m+n=p.
    const sel = selectSeries(
      P([1n], [2n], [3n], [4n]),
      cfromInts(2n, 0n, 50),
    );
    expect(sel.series).toBe(2);
  });

  test("p == q == m+n with |z| < 1 ⟹ series 1", () => {
    const sel = selectSeries(
      P([1n], [2n], [3n], [4n]),
      cfromStrings("0.5", "0", 50),
    );
    expect(sel.series).toBe(1);
    expect(sel.quarantine).toBe(false);
  });

  test("p == q == m+n with |z| ≈ 1 ⟹ quarantine flagged", () => {
    const sel = selectSeries(
      P([1n], [2n], [3n], [4n]),
      cfromStrings("1.0", "0", 50),
    );
    expect(sel.quarantine).toBe(true);
  });

  test("p == q == m+n with |z| just outside default band ⟹ no quarantine", () => {
    // |z| = 1.02 is outside the default [0.99, 1.01] band.
    const sel = selectSeries(
      P([1n], [2n], [3n], [4n]),
      cfromStrings("1.02", "0", 50),
    );
    expect(sel.quarantine).toBe(false);
    expect(sel.series).toBe(2);
  });

  test("force_series=2 honoured even when rule says 1", () => {
    const sel = selectSeries(
      P([1n], [], [3n], []),
      cfromStrings("0.5", "0", 50),
      { forceSeries: 2 },
    );
    expect(sel.series).toBe(2);
    expect(sel.quarantine).toBe(false);
  });

  test("custom quarantine band tightens the trigger", () => {
    const sel = selectSeries(
      P([1n], [2n], [3n], [4n]),
      cfromStrings("0.95", "0", 50),
      { quarantineBand: [0.9, 1.1] },
    );
    expect(sel.quarantine).toBe(true);
  });

  test("m=0 ⟹ series 2 (no Series-1 poles to close around)", () => {
    const sel = selectSeries(P([1n], [], [], [3n]), cfromInts(2n, 0n, 50));
    expect(sel.series).toBe(2);
  });

  test("n=0 ⟹ series 1 (no Series-2 poles to close around)", () => {
    const sel = selectSeries(P([], [2n], [3n], []), cfromInts(2n, 0n, 50));
    expect(sel.series).toBe(1);
  });
});
