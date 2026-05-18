// Unit tests for the external-solver log parsers in `src/solver/TraceLog.ts`.
//
// Two layers:
//
//  1. *Documented behaviour* on synthetic input — column mapping, the
//     contiguous-iteration guard, the empty-input contract, the `TraceLine`
//     shape. Synthetic logs let the edge cases (a non-contiguous stray row,
//     a banner-only log) be constructed precisely.
//
//  2. *Format verification* against real solver logs committed under
//     `fixtures/` — `mosek-11.1-adlittle.log` (Mosek 11.1.6),
//     `copt-8.0.4-adlittle.log` (COPT 8.0.4 build Apr 24 2026), and
//     `gurobi-13.0-adlittle.log` (Gurobi 13.0.1), each an interior-point /
//     barrier solve of NETLIB `adlittle`. A parser can be behaviourally
//     correct against its spec and still have the *wrong spec*; layer 1
//     covers the former, layer 2 the latter. This is the discharge of
//     beads `scientist-workbench-yyme` (Mosek/COPT) and `-z799` (Gurobi).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCoptLog, parseMosekLog, parseGurobiLog, type TraceLine } from "../src/index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

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

// A synthetic Mosek IPM iteration table for the edge-case probes below.
// The row format is verified against a real Mosek 11.1.6 log in the layer-2
// `describe` block; this constant exists only to construct the contiguity
// and empty-input cases precisely.
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

// ── Layer 2: format verification against real solver logs ────────────────────
//
// These read the committed `fixtures/*.log` captures and assert the parser
// extracts the iteration table, skips the surrounding solver banner, and maps
// each column to the field the schema documents. The asserted numbers are
// transcribed directly from the raw log rows, so a parser that mis-aligns a
// column fails here. Both fixtures are an interior-point solve of NETLIB
// `adlittle` (objective ≈ 2.254950e+05).

describe("parseCoptLog — real COPT 8.0.4 log", () => {
  const lines = parseCoptLog(fixture("copt-8.0.4-adlittle.log"));

  test("extracts the full iteration table (iters 0..12), skipping the banner", () => {
    expect(lines.map((l) => l.iter)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("iter 0 columns map as Iter/Primal.Obj/Dual.Obj/Compl/Primal.Inf/Dual.Inf/Time", () => {
    // raw: 0  +2.91349562e+06  +2.17822850e+05   2.25e+07   8.58e+02  4.86e+03  0.01s
    const l = lines[0] as TraceLine;
    expect(l.kind).toBe("copt");
    expect(l.primalObj).toBe(2913495.62);
    expect(l.dualObj).toBe(217822.85);
    expect(l.compl).toBe(2.25e7);
    expect(l.primalInf).toBe(858);
    expect(l.dualInf).toBe(4860);
    expect(l.timeSec).toBe(0.01);
  });

  test("final iter is at optimality — primal and dual objectives agree", () => {
    // raw: 12  +2.25494963e+05  +2.25494963e+05   2.25e-10   3.24e-11  9.09e-13  0.01s
    const l = lines[lines.length - 1] as TraceLine;
    expect(l.iter).toBe(12);
    expect(l.primalObj).toBe(225494.963);
    expect(l.dualObj).toBe(225494.963);
    expect(l.compl).toBe(2.25e-10);
  });
});

describe("parseMosekLog — real Mosek 11.1.6 log", () => {
  const lines = parseMosekLog(fixture("mosek-11.1-adlittle.log"));

  test("extracts the full iteration table (iters 0..10), skipping the banner", () => {
    expect(lines.map((l) => l.iter)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("iter 0 columns map as ITE/PFEAS/DFEAS/GFEAS/PRSTATUS/POBJ/DOBJ/MU/TIME", () => {
    // raw: 0  5.2e+02  3.3e+03  1.2e+03  0.00e+00  -3.992412481e+03  -5.148399339e+03  1.2e+00  0.01
    const l = lines[0] as TraceLine;
    expect(l.kind).toBe("mosek");
    expect(l.primalInf).toBe(5.2e2); // PFEAS
    expect(l.dualInf).toBe(3.3e3); // DFEAS
    expect(l.gfeas).toBe(1.2e3); // GFEAS — Mosek exposes it directly
    expect(l.prstatus).toBe(0); // PRSTATUS 0.00e+00
    expect(l.primalObj).toBe(-3992.412481); // POBJ
    expect(l.dualObj).toBe(-5148.399339); // DOBJ
    expect(l.compl).toBe(1.2); // MU
    expect(l.timeSec).toBe(0.01); // TIME
  });

  test("PRSTATUS climbs toward +1 on the optimal branch", () => {
    // raw last row: 10  3.8e-10 ... 1.00e+00 ...
    const last = lines[lines.length - 1] as TraceLine;
    expect(last.iter).toBe(10);
    expect(last.prstatus).toBe(1);
    expect(last.compl).toBe(8.6e-13); // MU driven to ~0
  });

  test("tau/kappa stay null — Mosek does not print them", () => {
    for (const l of lines) {
      expect(l.tau).toBeNull();
      expect(l.kappa).toBeNull();
    }
  });
});

// A synthetic Gurobi barrier table for the edge-case probes. Note the
// two-line header — `parseGurobiLog` must skip both. Row format verified
// against a real Gurobi 13.0.1 log in the layer-2 block below.
const GUROBI_LOG = `Optimize a model with 56 rows, 97 columns
                  Objective                Residual
Iter       Primal          Dual         Primal    Dual     Compl     Time
   0  -1.0e+00  2.0e+00  3.0e+00 4.0e+00  5.0e+00     0s
   1  -1.0e-01  2.0e-01  3.0e-01 4.0e-01  5.0e-01     0s
Barrier solved model in 1 iterations
`;

describe("parseGurobiLog", () => {
  test("extracts iter rows, skipping the two-line header and banner", () => {
    const lines = parseGurobiLog(GUROBI_LOG);
    expect(lines.map((l) => l.iter)).toEqual([0, 1]);
  });

  test("maps the seven columns: Primal/Dual obj, Primal/Dual resid, Compl, Time", () => {
    const [first] = parseGurobiLog(GUROBI_LOG);
    const l = first as TraceLine;
    expect(l.kind).toBe("gurobi");
    expect(l.primalObj).toBe(-1); // Primal objective
    expect(l.dualObj).toBe(2); // Dual objective
    expect(l.primalInf).toBe(3); // Primal residual
    expect(l.dualInf).toBe(4); // Dual residual
    expect(l.compl).toBe(5); // Compl
    expect(l.timeSec).toBe(0); // Time
  });

  test("solver-internal and HSDE fields are null — Gurobi barrier is not HSDE", () => {
    const [first] = parseGurobiLog(GUROBI_LOG);
    const l = first as TraceLine;
    expect(l.tau).toBeNull();
    expect(l.gfeas).toBeNull();
    expect(l.sigma).toBeNull();
    expect(l.nitref1).toBeNull();
  });

  test("stops at the first non-contiguous iteration index", () => {
    const withStray = `Iter       Primal          Dual         Primal    Dual     Compl     Time
   0  -1.0e+00  2.0e+00  3.0e+00 4.0e+00  5.0e+00     0s
   1  -1.0e-01  2.0e-01  3.0e-01 4.0e-01  5.0e-01     0s
   9  -1.0e-09  2.0e-09  3.0e-09 4.0e-09  5.0e-09     0s
`;
    expect(parseGurobiLog(withStray).map((l) => l.iter)).toEqual([0, 1]);
  });

  test("returns [] when no iter rows are present", () => {
    expect(parseGurobiLog("Optimize a model\nOptimal objective 1.0e+00\n")).toEqual([]);
  });
});

describe("parseGurobiLog — real Gurobi 13.0.1 log", () => {
  const lines = parseGurobiLog(fixture("gurobi-13.0-adlittle.log"));

  test("extracts the full barrier table (iters 0..12), skipping the banner", () => {
    expect(lines.map((l) => l.iter)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("iter 0 columns map as Iter/Primal/Dual/Primal-resid/Dual-resid/Compl/Time", () => {
    // raw: 0  -1.53974860e+06  3.05335499e+05  9.95e+02 7.58e+02  3.70e+05  0s
    const l = lines[0] as TraceLine;
    expect(l.kind).toBe("gurobi");
    expect(l.primalObj).toBe(-1539748.6);
    expect(l.dualObj).toBe(305335.499);
    expect(l.primalInf).toBe(9.95e2);
    expect(l.dualInf).toBe(7.58e2);
    expect(l.compl).toBe(3.7e5);
    expect(l.timeSec).toBe(0);
  });

  test("final iter is at optimality — primal and dual objectives agree", () => {
    // raw: 12  2.25494963e+05  2.25494963e+05  4.41e-11 4.55e-13  6.91e-10  0s
    const l = lines[lines.length - 1] as TraceLine;
    expect(l.iter).toBe(12);
    expect(l.primalObj).toBe(225494.963);
    expect(l.dualObj).toBe(225494.963);
    expect(l.compl).toBe(6.91e-10);
  });
});
