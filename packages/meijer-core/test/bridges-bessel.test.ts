// =============================================================================
// bridges-bessel.test.ts — Bessel-family bridge round-trip + structural anchors
// =============================================================================
//
// Mirrors the layered shape of `bridges-erf.test.ts`, scaled per CLAUDE.md
// Rule 6 (mutation-prove discipline) and Rule 7 ("runs without errors" is
// not passing):
//
//   1. **Forward-bridge structural anchors.** `headToMeijerGBessel` returns
//      the canonical G-form for BesselJ / BesselY / BesselI / BesselK (slot
//      tuple + z-substitution shape verified against R4 §A.4's pinned
//      table); returns `null` for the wrong arity and for out-of-scope
//      heads. Each head's `(m,n,p,q)` shape uniquely identifies it (no
//      Erf-style z-sign disambiguation needed).
//
//   2. **Byte-identical round-trip property (2-arg argsInverse).** For
//      every bridged head and every representative `(ν, z)` sample pair:
//      `headToMeijerGBessel(...).argsInverse()` returns the original args
//      byte-identically. This IS the bridge's correctness contract per
//      ADR-0041 §"Decision 5" — the first 2-arg verification of the
//      arity-agnostic closure trick.
//
//   3. **Backward standalone bridge.** `meijerGToHeadBessel(form)` on the
//      canonical G-forms recovers the head + reconstructed `[ν, z]` args.
//      The slot-shape switch is structural — each `(m,n,p,q)` tuple
//      uniquely maps to one head.
//
//   4. **Prefactor checks.** The `wrap` closure on each head emits the
//      documented prefactor: BesselJ / BesselY → identity, BesselI → `π·g`,
//      BesselK → `(1/2)·g`. These are the load-bearing scaling factors —
//      a missing or swapped prefactor is a silent numerical bug.

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  expr,
  int,
  rat,
  sym,
  type Value,
} from "@workbench/protocol";
import { mkDiv, mkNeg, mkPlus, mkPower, mkTimes } from "@workbench/cas-core";
import {
  headToMeijerGBessel,
  meijerGToHeadBessel,
} from "../src/index.js";
import type { MeijerGForm } from "../src/index.js";

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function I(n: number | bigint): Value {
  return int(typeof n === "bigint" ? n : BigInt(n));
}

function R(n: number, d: number): Value {
  return rat(BigInt(n), BigInt(d));
}

const PI: Value = sym("pi");
const TWO_INT: Value = I(2);
const FOUR_INT: Value = I(4);
const HALF: Value = R(1, 2);
const ONE_INT: Value = I(1);

/** Canonical `ν/2`, `-ν/2`, `(ν+1)/2`, `-(ν+1)/2`, `z²/4` encodings. */
function nuOver2(nu: Value): Value {
  return mkDiv(nu, TWO_INT);
}
function negNuOver2(nu: Value): Value {
  return mkNeg(nuOver2(nu));
}
function nuPlusOneOver2(nu: Value): Value {
  return mkDiv(mkPlus([nu, ONE_INT]), TWO_INT);
}
function negNuPlusOneOver2(nu: Value): Value {
  return mkNeg(nuPlusOneOver2(nu));
}
function zSqOver4(z: Value): Value {
  return mkDiv(mkPower(z, TWO_INT), FOUR_INT);
}

/** Representative (ν, z) sample pairs for the round-trip property. */
const SAMPLES: readonly { label: string; nu: Value; z: Value }[] = [
  { label: "integer ν=0, symbolic z", nu: I(0), z: sym("z") },
  { label: "integer ν=1, symbolic z", nu: I(1), z: sym("z") },
  { label: "integer ν=3, integer z=2", nu: I(3), z: I(2) },
  { label: "half-integer ν=1/2, symbolic z", nu: R(1, 2), z: sym("z") },
  { label: "negative integer ν=-2, integer z=5", nu: I(-2), z: I(5) },
  { label: "rational ν=3/4, rational z=-2/3", nu: R(3, 4), z: R(-2, 3) },
  { label: "symbolic ν, symbolic z", nu: sym("nu"), z: sym("z") },
  { label: "symbolic ν, expression z", nu: sym("nu"), z: expr("*", [I(2), sym("z")]) },
];

// -----------------------------------------------------------------------------
// Layer 1 — forward-bridge structural anchors (R4 §A.4)
// -----------------------------------------------------------------------------

describe("headToMeijerGBessel — forward bridge structural anchors (R4 §A.4)", () => {
  test("BesselJ(ν,z): an=[], ap=[], bm=[ν/2], bq=[-ν/2], z-slot = z²/4, prefactor 1", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselJ", [nu, z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm, wrap } = fwd;
    expect(gForm.an.length).toBe(0);
    expect(gForm.ap.length).toBe(0);
    expect(gForm.bm.length).toBe(1);
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(nuOver2(nu)));
    expect(gForm.bq.length).toBe(1);
    expect(canonicalize(gForm.bq[0]!)).toBe(canonicalize(negNuOver2(nu)));
    expect(canonicalize(gForm.z)).toBe(canonicalize(zSqOver4(z)));
    // Prefactor 1: wrap(g) === g.
    const g = sym("g_dummy");
    expect(canonicalize(wrap(g))).toBe(canonicalize(g));
  });

  test("BesselY(ν,z): an=[], ap=[-(ν+1)/2], bm=[ν/2,-ν/2], bq=[-(ν+1)/2], z²/4, prefactor 1", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselY", [nu, z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm, wrap } = fwd;
    expect(gForm.an.length).toBe(0);
    expect(gForm.ap.length).toBe(1);
    expect(canonicalize(gForm.ap[0]!)).toBe(canonicalize(negNuPlusOneOver2(nu)));
    expect(gForm.bm.length).toBe(2);
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(nuOver2(nu)));
    expect(canonicalize(gForm.bm[1]!)).toBe(canonicalize(negNuOver2(nu)));
    expect(gForm.bq.length).toBe(1);
    expect(canonicalize(gForm.bq[0]!)).toBe(canonicalize(negNuPlusOneOver2(nu)));
    expect(canonicalize(gForm.z)).toBe(canonicalize(zSqOver4(z)));
    const g = sym("g_dummy");
    expect(canonicalize(wrap(g))).toBe(canonicalize(g));
  });

  test("BesselI(ν,z): an=[], ap=[(ν+1)/2], bm=[ν/2], bq=[-ν/2,(ν+1)/2], z²/4, prefactor π", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselI", [nu, z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm, wrap } = fwd;
    expect(gForm.an.length).toBe(0);
    expect(gForm.ap.length).toBe(1);
    expect(canonicalize(gForm.ap[0]!)).toBe(canonicalize(nuPlusOneOver2(nu)));
    expect(gForm.bm.length).toBe(1);
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(nuOver2(nu)));
    expect(gForm.bq.length).toBe(2);
    expect(canonicalize(gForm.bq[0]!)).toBe(canonicalize(negNuOver2(nu)));
    expect(canonicalize(gForm.bq[1]!)).toBe(canonicalize(nuPlusOneOver2(nu)));
    expect(canonicalize(gForm.z)).toBe(canonicalize(zSqOver4(z)));
    // Prefactor π: wrap(g) === π·g.
    const g = sym("g_dummy");
    expect(canonicalize(wrap(g))).toBe(canonicalize(mkTimes(PI, g)));
  });

  test("BesselK(ν,z): an=[], ap=[], bm=[ν/2,-ν/2], bq=[], z²/4, prefactor 1/2", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselK", [nu, z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm, wrap } = fwd;
    expect(gForm.an.length).toBe(0);
    expect(gForm.ap.length).toBe(0);
    expect(gForm.bm.length).toBe(2);
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(nuOver2(nu)));
    expect(canonicalize(gForm.bm[1]!)).toBe(canonicalize(negNuOver2(nu)));
    expect(gForm.bq.length).toBe(0);
    expect(canonicalize(gForm.z)).toBe(canonicalize(zSqOver4(z)));
    // Prefactor 1/2: wrap(g) === (1/2)·g.
    const g = sym("g_dummy");
    expect(canonicalize(wrap(g))).toBe(canonicalize(mkTimes(HALF, g)));
  });

  test("All 4 heads share z²/4 substitution (uniform in ν, no class branching)", () => {
    const nu = sym("nu");
    const z = sym("z");
    const zSub = canonicalize(zSqOver4(z));
    for (const head of ["BesselJ", "BesselY", "BesselI", "BesselK"]) {
      const fwd = headToMeijerGBessel(head, [nu, z])!;
      expect(canonicalize(fwd.gForm.z)).toBe(zSub);
    }
  });

  test("Each head has a unique (m,n,p,q) shape (no Erf-style disambiguation needed)", () => {
    const nu = sym("nu");
    const z = sym("z");
    const shapes = new Set<string>();
    for (const head of ["BesselJ", "BesselY", "BesselI", "BesselK"]) {
      const fwd = headToMeijerGBessel(head, [nu, z])!;
      const m = fwd.gForm.bm.length;
      const n = fwd.gForm.an.length;
      const p = fwd.gForm.an.length + fwd.gForm.ap.length;
      const q = fwd.gForm.bm.length + fwd.gForm.bq.length;
      const key = `(${m},${n},${p},${q})`;
      expect(shapes.has(key)).toBe(false);
      shapes.add(key);
    }
    expect(shapes.size).toBe(4);
    // Spot-check the four pinned shapes against R4 §A.4.
    expect(shapes.has("(1,0,0,2)")).toBe(true); // BesselJ
    expect(shapes.has("(2,0,1,3)")).toBe(true); // BesselY
    expect(shapes.has("(1,0,1,3)")).toBe(true); // BesselI
    expect(shapes.has("(2,0,0,2)")).toBe(true); // BesselK
  });

  test("Unknown head returns null (out-of-scope, not error)", () => {
    expect(headToMeijerGBessel("FooBar", [sym("nu"), sym("z")])).toBeNull();
    expect(headToMeijerGBessel("Erf", [sym("z")])).toBeNull();
    // Bessel-adjacent heads we haven't bridged are also out-of-scope.
    expect(headToMeijerGBessel("HankelH1", [sym("nu"), sym("z")])).toBeNull();
    expect(headToMeijerGBessel("SphericalBesselJ", [sym("nu"), sym("z")])).toBeNull();
  });

  test("Wrong arity returns null (2-arg heads only)", () => {
    expect(headToMeijerGBessel("BesselJ", [])).toBeNull();
    expect(headToMeijerGBessel("BesselJ", [sym("z")])).toBeNull();
    expect(headToMeijerGBessel("BesselJ", [sym("a"), sym("b"), sym("c")])).toBeNull();
    expect(headToMeijerGBessel("BesselY", [sym("z")])).toBeNull();
    expect(headToMeijerGBessel("BesselI", [])).toBeNull();
    expect(headToMeijerGBessel("BesselK", [sym("z")])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 2 — byte-identical round-trip property (the 2-arg argsInverse contract)
// -----------------------------------------------------------------------------

describe("round-trip: headToMeijerGBessel(...).argsInverse() preserves [ν,z] byte-identically", () => {
  for (const head of ["BesselJ", "BesselY", "BesselI", "BesselK"] as const) {
    for (const sample of SAMPLES) {
      test(`${head}(${sample.label})`, () => {
        const fwd = headToMeijerGBessel(head, [sample.nu, sample.z]);
        expect(fwd).not.toBeNull();
        if (!fwd) return;
        const recovered = fwd.argsInverse();
        // Critical 2-arg verification — Erf returned a 1-element list;
        // Bessel returns 2 elements. Order is [nu, z] (NOT [z, nu]).
        expect(recovered.length).toBe(2);
        expect(canonicalize(recovered[0]!)).toBe(canonicalize(sample.nu));
        expect(canonicalize(recovered[1]!)).toBe(canonicalize(sample.z));
      });
    }
  }

  test("Order is [nu, z], not [z, nu] — fixed regression sentinel", () => {
    // If a refactor swapped the closure body to [z, nu], this test fires.
    const fwd = headToMeijerGBessel("BesselJ", [I(3), I(7)])!;
    const args = fwd.argsInverse();
    // args[0] must be ν=3 (an integer 3), NOT z=7.
    expect(canonicalize(args[0]!)).toBe(canonicalize(I(3)));
    expect(canonicalize(args[1]!)).toBe(canonicalize(I(7)));
    // Asymmetry guarantee: swapping would make args[0]=7, which differs.
    expect(canonicalize(args[0]!)).not.toBe(canonicalize(I(7)));
  });
});

// -----------------------------------------------------------------------------
// Layer 3 — backward standalone bridge (meijerGToHeadBessel)
// -----------------------------------------------------------------------------

describe("meijerGToHeadBessel — standalone backward bridge (R4 §A.4 + slot-recovery)", () => {
  test("BesselJ G-form → BesselJ head; ν recovered from bm[0], z from z-slot", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselJ", [nu, z])!;
    const bwd = meijerGToHeadBessel(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("BesselJ");
    expect(bwd.args.length).toBe(2);
    // For literal ν/2 slot (the forward bridge's emission), the unwrap
    // returns ν directly; for literal z²/4 slot the unwrap returns z.
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(nu));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("BesselY G-form → BesselY head", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselY", [nu, z])!;
    const bwd = meijerGToHeadBessel(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("BesselY");
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(nu));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("BesselI G-form → BesselI head", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselI", [nu, z])!;
    const bwd = meijerGToHeadBessel(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("BesselI");
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(nu));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("BesselK G-form → BesselK head", () => {
    const nu = sym("nu");
    const z = sym("z");
    const fwd = headToMeijerGBessel("BesselK", [nu, z])!;
    const bwd = meijerGToHeadBessel(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("BesselK");
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(nu));
    expect(canonicalize(bwd.args[1]!)).toBe(canonicalize(z));
  });

  test("Non-literal slot shapes fall back to 2·slot / √(4·slot) emission", () => {
    // A hand-built G-form whose bm[0] is NOT shaped as `mkDiv(nu, 2)` —
    // the recoverer emits `2·slot` literally rather than unwrapping.
    const oddBm: Value = sym("X"); // an opaque slot value
    const oddZ: Value = sym("Y");
    const form: MeijerGForm = {
      an: [],
      ap: [],
      bm: [oddBm],
      bq: [mkNeg(oddBm)],
      z: oddZ,
    };
    const bwd = meijerGToHeadBessel(form);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("BesselJ");
    // ν recovered as 2·oddBm (the literal slot didn't have the
    // `mkDiv(?, 2)` shape).
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(mkTimes(TWO_INT, oddBm)));
    // z recovered as √(4·oddZ) (the literal z-slot didn't have the
    // `mkDiv(mkPower(?, 2), 4)` shape).
    expect(canonicalize(bwd.args[1]!)).toBe(
      canonicalize(mkPower(mkTimes(FOUR_INT, oddZ), HALF)),
    );
  });

  test("No-match G-form returns null (honest refusal)", () => {
    // (m,n,p,q) = (1,0,0,1) — too few slots for any Bessel head.
    const form: MeijerGForm = {
      an: [],
      ap: [],
      bm: [I(0)],
      bq: [],
      z: sym("z"),
    };
    expect(meijerGToHeadBessel(form)).toBeNull();
  });

  test("Erf-shaped G-form returns null (cross-bridge isolation)", () => {
    // Erf is (1,1,1,2): an=[1/2], bm=[0], bq=[-1/2]. The Bessel matcher
    // must return null on this — otherwise a top-level dispatcher
    // iterating over bridges would route Erf forms to Bessel by mistake.
    const erfShape: MeijerGForm = {
      an: [R(1, 2)],
      ap: [],
      bm: [I(0)],
      bq: [R(-1, 2)],
      z: mkPower(sym("z"), TWO_INT),
    };
    expect(meijerGToHeadBessel(erfShape)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 4 — prefactor checks (the load-bearing scaling factors)
// -----------------------------------------------------------------------------

describe("prefactor checks: wrap(g) emits the documented scaling", () => {
  const nu = sym("nu");
  const z = sym("z");
  const dummyG = sym("g_dummy");

  test("BesselJ.wrap(g) === g (identity prefactor)", () => {
    const fwd = headToMeijerGBessel("BesselJ", [nu, z])!;
    expect(canonicalize(fwd.wrap(dummyG))).toBe(canonicalize(dummyG));
  });

  test("BesselY.wrap(g) === g (identity prefactor)", () => {
    const fwd = headToMeijerGBessel("BesselY", [nu, z])!;
    expect(canonicalize(fwd.wrap(dummyG))).toBe(canonicalize(dummyG));
  });

  test("BesselI.wrap(g) === π · g", () => {
    const fwd = headToMeijerGBessel("BesselI", [nu, z])!;
    expect(canonicalize(fwd.wrap(dummyG))).toBe(canonicalize(mkTimes(PI, dummyG)));
  });

  test("BesselK.wrap(g) === (1/2) · g", () => {
    const fwd = headToMeijerGBessel("BesselK", [nu, z])!;
    expect(canonicalize(fwd.wrap(dummyG))).toBe(canonicalize(mkTimes(HALF, dummyG)));
  });

  test("J/Y vs I/K prefactor distinction (mutation sentinel)", () => {
    // If a refactor accidentally swapped J's prefactor to π or K's to 1,
    // these tests fire.
    const j = headToMeijerGBessel("BesselJ", [nu, z])!;
    const k = headToMeijerGBessel("BesselK", [nu, z])!;
    // BesselJ.wrap(g) must NOT equal π·g.
    expect(canonicalize(j.wrap(dummyG))).not.toBe(canonicalize(mkTimes(PI, dummyG)));
    // BesselK.wrap(g) must NOT equal g (identity).
    expect(canonicalize(k.wrap(dummyG))).not.toBe(canonicalize(dummyG));
  });
});
