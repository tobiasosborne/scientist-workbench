// wellformed.test.ts — graph-shaped invariants that the schema can't catch.
//
// Coverage:
//   • Bell / GHZ are well-formed.
//   • Wire-ID scope: ry on a non-existent wire fails with a path.
//   • prepare collisions fail.
//   • Controls must be quantum and not duplicate the target.
//   • observe rebinding a classical_ref fails.
//   • cases arms cannot change scope (v0.1 restriction).
//   • Output signature wires must be in scope at end.

import { describe, expect, test } from "bun:test";
import { expr, int, rat, sym } from "@workbench/protocol";
import {
  casesOp,
  channel,
  checkWellFormed,
  discardOp,
  observeOp,
  oracleOp,
  prepareOp,
  ryOp,
  wire,
  type Channel,
} from "../src/index.js";

const W0 = wire(0n, "quantum", "qubit");
const W1 = wire(1n, "quantum", "qubit");
const C5 = wire(5n, "classical");

describe("happy paths", () => {
  test("empty channel is well-formed", () => {
    const c = channel([], [], []);
    expect(checkWellFormed(c).ok).toBe(true);
  });

  test("Bell channel is well-formed", () => {
    const c = channel(
      [],
      [W0, W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
        ryOp(1n, sym("π"), [0n]),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(true);
  });

  test("kickback-style channel with observe + discard is well-formed", () => {
    const c = channel(
      [],
      [],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
        observeOp(0n, "result"),
        discardOp(1n),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(true);
  });
});

describe("wire-ID scoping", () => {
  test("ry on an unprepared wire fails with a body path", () => {
    const c = channel(
      [],
      [W0],
      [ryOp(0n, sym("π"), [])] // wire 0 never introduced
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.path).toEqual(["body", "0"]);
      expect(r.failure.message).toContain("not in scope");
    }
  });

  test("prepare collisions fail", () => {
    const c = channel(
      [],
      [W0],
      [prepareOp(rat(0n, 1n), 0n), prepareOp(rat(0n, 1n), 0n)]
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.message).toContain("collides");
    }
  });

  test("inputs declaring a duplicate wire id fail", () => {
    const c = channel([W0, W0], [], []);
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
  });

  test("operating on a discarded wire fails", () => {
    const c = channel(
      [],
      [],
      [
        prepareOp(rat(0n, 1n), 0n),
        discardOp(0n),
        ryOp(0n, sym("π"), []),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });
});

describe("controls must be quantum and well-shaped", () => {
  test("control referencing classical wire fails", () => {
    const c = channel(
      [C5],
      [W0],
      [
        prepareOp(rat(0n, 1n), 0n),
        ryOp(0n, sym("π"), [5n]), // wire 5 is classical
      ]
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.message).toContain("quantum");
  });

  test("control coinciding with target fails", () => {
    const c = channel(
      [],
      [W0],
      [prepareOp(rat(0n, 1n), 0n), ryOp(0n, sym("π"), [0n])]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });

  test("duplicate controls fail", () => {
    const c = channel(
      [],
      [W0],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        ryOp(0n, sym("π"), [1n, 1n]),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });
});

describe("classical-ref scoping", () => {
  test("cases on an unbound ref fails", () => {
    const c = channel(
      [],
      [W0],
      [
        prepareOp(rat(0n, 1n), 0n),
        casesOp("never_observed", [], []),
      ]
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.message).toContain("classical_ref");
  });

  test("observe rebinding a ref fails", () => {
    const c = channel(
      [],
      [],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        observeOp(1n, "r"),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });
});

// `cases` arms are the IR's structural fingerprint of a *controlled
// body* — the recursive analogue of the source-level `when(q) { … }`
// frame. ADR-0038 names this restriction "Layer 4" of the four-layer
// coherent-control closure: no non-unitary op (`prepare`, `observe`,
// `discard`, nested `cases`, scope-changing `oracle`) appears inside
// an arm. Each test below pins one rejection path for one forbidden
// op; the positive `rotation-only arms is OK` case anchors the
// happy path.
describe("cases arms cannot change scope (v0.1) — ADR-0038 Layer 4", () => {
  test("cases with rotation-only arms is OK", () => {
    const c = channel(
      [],
      [W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        casesOp("r", [ryOp(1n, sym("π"), [])], []),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(true);
  });

  test("cases arm with prepare fails", () => {
    const c = channel(
      [],
      [W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        casesOp("r", [prepareOp(rat(0n, 1n), 9n)], []),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });

  test("cases arm with observe fails", () => {
    // Symmetry test against the prepare/discard/nested-cases rejections
    // below; pins the wellformed.ts rejection at line 152-154 that
    // existed without a covering test before ADR-0038 closed the gap.
    const c = channel(
      [],
      [W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r1"),
        casesOp("r1", [observeOp(1n, "r2")], []),
      ]
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.message).toContain("observe");
      // Failure path points inside the true-arm of the cases op at body[3].
      expect(r.failure.path).toEqual(["body", "3", "trueArm", "0"]);
    }
  });

  test("cases arm with discard fails", () => {
    const c = channel(
      [],
      [W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        casesOp("r", [discardOp(1n)], []),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });

  test("nested cases inside a cases arm fails", () => {
    const c = channel(
      [],
      [],
      [
        prepareOp(rat(0n, 1n), 0n),
        observeOp(0n, "r1"),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(1n, "r2"),
        casesOp("r1", [casesOp("r2", [], [])], []),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });

  test("cases arm in falseArm position also catches non-unitary ops", () => {
    // The two arms are symmetric — pin both, lest the recursion only
    // descends into trueArm by accident.
    const c = channel(
      [],
      [W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        casesOp("r", [], [discardOp(1n)]),
      ]
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.path).toEqual(["body", "3", "falseArm", "0"]);
    }
  });
});

describe("oracle handling", () => {
  test("oracle with all in-scope wires is well-formed", () => {
    const c = channel(
      [],
      [W0, W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        oracleOp(sym("placeholder"), [0n, 1n], [1n]),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(true);
  });

  test("oracle introducing fresh outWire is allowed at top level", () => {
    const c = channel(
      [],
      [W0, W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        oracleOp(sym("placeholder"), [0n], [1n]),
      ]
    );
    expect(checkWellFormed(c).ok).toBe(true);
  });

  test("oracle with missing inWire fails", () => {
    const c = channel(
      [],
      [W0],
      [oracleOp(sym("placeholder"), [0n], [0n])] // wire 0 never prepared
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });
});

describe("output signature must be live at end", () => {
  test("missing output wire fails", () => {
    const c = channel(
      [],
      [W0],
      [] // body never introduces wire 0
    );
    const r = checkWellFormed(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.path).toEqual(["outputs", "0"]);
    }
  });

  test("kind/dim mismatch on output fails", () => {
    const c = channel(
      [],
      [wire(0n, "classical")], // body produces it as quantum
      [prepareOp(rat(0n, 1n), 0n)]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });

  test("duplicate IDs in output signature fail", () => {
    const c = channel(
      [],
      [W0, W0],
      [prepareOp(rat(0n, 1n), 0n)]
    );
    expect(checkWellFormed(c).ok).toBe(false);
  });
});
