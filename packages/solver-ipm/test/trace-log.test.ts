// Unit tests for the external-solver log parsers in `src/solver/TraceLog.ts`.
//
// Scope discipline: these tests assert the *parser's documented behaviour* —
// column mapping, the contiguous-iteration guard, the empty-input contract,
// and the `TraceLine` shape it produces. They do NOT claim the COPT / Mosek
// row formats are correct: that is a ground-truth question about real solver
// output. The COPT format is verified against a real log (see `TraceLog.ts`);
// the Mosek format is not yet (bead `scientist-workbench-yyme`). A parser can
// be behaviourally correct against its spec and still have the wrong spec —
// these tests cover the former, `yyme` covers the latter.

import { describe, expect, test } from "bun:test";
import { parseCoptLog, parseMosekLog, type TraceLine } from "../src/index.js";

// A representative COPT iter-line section, framed by banner lines that must
// be skipped. Format per `TraceLog.ts` (verified against COPT 8.0.4).
const COPT_LOG = `Cardinal Optimizer v8.0.4
Setting parameter 'Logging' to 2
    Iter       Primal.Obj         Dual.Obj      Compl  Primal.Inf  Dual.Inf    Time
       0  -4.75000000e+00  +0.00000000e+00   5.00e+00    8.12e+00  2.00e+00   0.02s
       1  -4.60000000e+02  -4.70000000e+02   1.00e+01    3.00e-01  1.00e-02   0.04s
       2  -4.64753140e+02  -4.64753150e+02   1.00e-06    1.00e-09  1.00e-11   0.05s
Optimal solution found.
`;

describe("parseCoptLog", () => {
  test("extracts the iter rows, skipping banner/status lines", () => {
    const lines = parseCoptLog(COPT_LOG);
    expect(lines.length).toBe(3);
    expect(lines.map((l) => l.iter)).toEqual([0, 1, 2]);
  });

  test("maps the seven core columns and tags kind=copt", () => {
    const [first] = parseCoptLog(COPT_LOG);
    expect(first).toBeDefined();
    const l = first as TraceLine;
    expect(l.kind).toBe("copt");
    expect(l.primalObj).toBe(-4.75);
    expect(l.dualObj).toBe(0);
    expect(l.compl).toBe(5);
    expect(l.primalInf).toBe(8.12);
    expect(l.dualInf).toBe(2);
    expect(l.timeSec).toBe(0.02);
  });

  test("solver-internal fields are null — COPT does not expose them", () => {
    const [first] = parseCoptLog(COPT_LOG);
    const l = first as TraceLine;
    // COPT's default path is non-HSDE; HSDE + NT-internal fields are absent.
    expect(l.tau).toBeNull();
    expect(l.kappa).toBeNull();
    expect(l.gfeas).toBeNull();
    expect(l.prstatus).toBeNull();
    expect(l.sigma).toBeNull();
    expect(l.eigMinX).toBeNull();
    expect(l.nitref1).toBeNull();
  });

  test("stops at the first non-contiguous iteration index", () => {
    // A stray tabular line that parses as a row but jumps the iter index:
    // the contiguity guard must cut the trace before it.
    const withStray = `    Iter       Primal.Obj         Dual.Obj      Compl  Primal.Inf  Dual.Inf    Time
       0  -1.00000000e+00  +0.00000000e+00   1.00e+00    1.00e+00  1.00e+00   0.01s
       1  -2.00000000e+00  +0.00000000e+00   1.00e-01    1.00e-01  1.00e-01   0.02s
      99  -9.90000000e+01  +0.00000000e+00   1.00e-09    1.00e-09  1.00e-09   0.03s
`;
    const lines = parseCoptLog(withStray);
    expect(lines.map((l) => l.iter)).toEqual([0, 1]);
  });

  test("returns [] when no iter rows are present", () => {
    expect(parseCoptLog("Cardinal Optimizer v8.0.4\nOptimal solution found.\n")).toEqual([]);
  });
});

// A representative Mosek HSDE IPM iteration table. Format per `TraceLog.ts`
// (NOT yet verified against a real Mosek log — bead `yyme`).
const MOSEK_LOG = `Interior-point optimizer started.
ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME
0 1.0e+00 2.0e+00 3.0e+00 0.00 -1.0e+00 +0.0e+00 1.0e+00 0.01
1 1.0e-03 2.0e-03 3.0e-03 0.95 -4.6e+02 -4.7e+02 1.0e-03 0.02s
Interior-point optimizer terminated.
`;

describe("parseMosekLog", () => {
  test("extracts the iter rows, skipping banner/status lines", () => {
    const lines = parseMosekLog(MOSEK_LOG);
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.iter)).toEqual([0, 1]);
  });

  test("maps core columns, tags kind=mosek, accepts time with or without 's'", () => {
    const lines = parseMosekLog(MOSEK_LOG);
    const l0 = lines[0] as TraceLine;
    const l1 = lines[1] as TraceLine;
    expect(l0.kind).toBe("mosek");
    expect(l0.primalObj).toBe(-1);
    expect(l0.dualObj).toBe(0);
    expect(l0.compl).toBe(1); // MU
    expect(l0.primalInf).toBe(1); // PFEAS
    expect(l0.dualInf).toBe(2); // DFEAS
    expect(l0.timeSec).toBe(0.01);
    expect(l1.timeSec).toBe(0.02); // trailing 's' accepted
  });

  test("populates the HSDE columns Mosek exposes (gfeas, prstatus)", () => {
    const [first] = parseMosekLog(MOSEK_LOG);
    const l = first as TraceLine;
    expect(l.gfeas).toBe(3); // GFEAS
    expect(l.prstatus).toBe(0); // PRSTATUS
    // tau/kappa are NOT inferred — Mosek does not print them.
    expect(l.tau).toBeNull();
    expect(l.kappa).toBeNull();
    // TS-internal fields stay null.
    expect(l.sigma).toBeNull();
    expect(l.nitref1).toBeNull();
  });

  test("stops at the first non-contiguous iteration index", () => {
    const withStray = `ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME
0 1.0e+00 2.0e+00 3.0e+00 0.00 -1.0e+00 +0.0e+00 1.0e+00 0.01
1 1.0e-01 2.0e-01 3.0e-01 0.50 -2.0e+00 +0.0e+00 1.0e-01 0.02
9 1.0e-09 2.0e-09 3.0e-09 1.00 -4.6e+02 -4.6e+02 1.0e-09 0.03
`;
    const lines = parseMosekLog(withStray);
    expect(lines.map((l) => l.iter)).toEqual([0, 1]);
  });

  test("returns [] when no iter rows are present", () => {
    expect(parseMosekLog("Interior-point optimizer started.\nterminated.\n")).toEqual([]);
  });
});
