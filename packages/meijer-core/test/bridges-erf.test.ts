// =============================================================================
// bridges-erf.test.ts — Erf-family bridge round-trip + structural anchors
// =============================================================================
//
// Test layers, scaled per CLAUDE.md Rule 6 (mutation-prove discipline) and
// Rule 7 ("runs without errors" is not passing):
//
//   1. **Forward-bridge structural anchors.** `headToMeijerG` returns the
//      canonical G-form for Erf / Erfc / Erfi (slot tuple + z-substitution
//      shape verified against R4 §1's pinned table); returns `null` for
//      `InverseErf` / `InverseErfc` and for out-of-scope heads.
//
//   2. **Byte-identical round-trip property.** For every bridged head
//      (Erf, Erfc, Erfi) and every representative argument sample:
//      `headToMeijerG(...).zInverse()` returns the original `args`
//      byte-identically (per canonicalize). This IS the bridge's
//      correctness contract per ADR-0040 §"Decision 5".
//
//   3. **Backward standalone bridge.** `meijerGToHead(form)` on the
//      canonical Erf-family G-forms recovers the head + reconstructed
//      args. Erf vs Erfi disambiguation by z-sign verified explicitly.
//
//   4. **Dispatcher-level regression.** The existing `dlmf-16-18-erf`
//      Form B rule still fires on its specific G-form (`an=[1]`,
//      `bm=[1/2]`, `bq=[0]`) — verifies the Erf-family bridge rules
//      did NOT shadow Form B. The new Form A / Erfc / Erfi rules fire
//      on their specific G-forms.
//
//   5. **Numerical agreement.** Skipped with note — pending bead `d6s`
//      (per-head arbprec MeijerG evaluator). Documented placeholder for
//      the cross-check `bigErf(z) ≡ wrap(meijerg(gForm))`.

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  expr,
  int,
  rat,
  sym,
  type Value,
} from "@workbench/protocol";
import { mkNeg, mkPower } from "@workbench/cas-core";
import {
  headToMeijerG,
  meijerGToHead,
  meijergSymbolic,
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

/** Representative argument samples for the round-trip property. */
const ARG_SAMPLES: readonly { label: string; value: Value }[] = [
  { label: "symbolic z", value: sym("z") },
  { label: "symbolic w (different symbol)", value: sym("w") },
  { label: "integer 1", value: I(1) },
  { label: "integer 2", value: I(2) },
  { label: "integer 5", value: I(5) },
  { label: "negative integer -1", value: I(-1) },
  { label: "negative integer -3", value: I(-3) },
  { label: "rational 1/2", value: R(1, 2) },
  { label: "rational 3/4", value: R(3, 4) },
  { label: "rational -2/3", value: R(-2, 3) },
  { label: "expression 2*z", value: expr("*", [I(2), sym("z")]) },
];

// -----------------------------------------------------------------------------
// Layer 1 — forward-bridge structural anchors
// -----------------------------------------------------------------------------

describe("headToMeijerG — forward bridge structural anchors (R4 §1)", () => {
  test("Erf(z): an=[1/2], ap=[], bm=[0], bq=[-1/2], z-slot = mkPower(z, 2)", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erf", [z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm } = fwd;
    expect(gForm.an.length).toBe(1);
    expect(canonicalize(gForm.an[0]!)).toBe(canonicalize(R(1, 2)));
    expect(gForm.ap.length).toBe(0);
    expect(gForm.bm.length).toBe(1);
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(I(0)));
    expect(gForm.bq.length).toBe(1);
    expect(canonicalize(gForm.bq[0]!)).toBe(canonicalize(R(-1, 2)));
    // z-slot is mkPower(z, 2)
    expect(canonicalize(gForm.z)).toBe(canonicalize(mkPower(z, I(2))));
  });

  test("Erfc(z): an=[], ap=[1], bm=[0, 1/2], bq=[], z-slot = mkPower(z, 2)", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erfc", [z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm } = fwd;
    expect(gForm.an.length).toBe(0);
    expect(gForm.ap.length).toBe(1);
    expect(canonicalize(gForm.ap[0]!)).toBe(canonicalize(I(1)));
    expect(gForm.bm.length).toBe(2);
    // The forward bridge emits [0, 1/2] in that order; the dispatcher
    // canonical-sorts before matching, so users who construct Erfc
    // manually with either order both match.
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(I(0)));
    expect(canonicalize(gForm.bm[1]!)).toBe(canonicalize(R(1, 2)));
    expect(gForm.bq.length).toBe(0);
    expect(canonicalize(gForm.z)).toBe(canonicalize(mkPower(z, I(2))));
  });

  test("Erfi(z): SAME slot tuple as Erf, but z-slot = mkNeg(mkPower(z, 2))", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erfi", [z]);
    expect(fwd).not.toBeNull();
    if (!fwd) return;
    const { gForm } = fwd;
    expect(gForm.an.length).toBe(1);
    expect(canonicalize(gForm.an[0]!)).toBe(canonicalize(R(1, 2)));
    expect(gForm.ap.length).toBe(0);
    expect(gForm.bm.length).toBe(1);
    expect(canonicalize(gForm.bm[0]!)).toBe(canonicalize(I(0)));
    expect(gForm.bq.length).toBe(1);
    expect(canonicalize(gForm.bq[0]!)).toBe(canonicalize(R(-1, 2)));
    // z-slot is mkNeg(mkPower(z, 2)) — the ONLY discriminator vs Erf.
    expect(canonicalize(gForm.z)).toBe(canonicalize(mkNeg(mkPower(z, I(2)))));
  });

  test("Erf and Erfi share slot tuple; differ only on z-slot", () => {
    const z = sym("z");
    const erfFwd = headToMeijerG("Erf", [z])!;
    const erfiFwd = headToMeijerG("Erfi", [z])!;
    // Identical (an, ap, bm, bq).
    expect(canonicalize(erfFwd.gForm.an[0]!)).toBe(canonicalize(erfiFwd.gForm.an[0]!));
    expect(canonicalize(erfFwd.gForm.bm[0]!)).toBe(canonicalize(erfiFwd.gForm.bm[0]!));
    expect(canonicalize(erfFwd.gForm.bq[0]!)).toBe(canonicalize(erfiFwd.gForm.bq[0]!));
    // Different z-slot.
    expect(canonicalize(erfFwd.gForm.z)).not.toBe(canonicalize(erfiFwd.gForm.z));
  });

  test("InverseErf refuses: returns null", () => {
    expect(headToMeijerG("InverseErf", [sym("y")])).toBeNull();
  });

  test("InverseErfc refuses: returns null", () => {
    expect(headToMeijerG("InverseErfc", [sym("y")])).toBeNull();
  });

  test("Unknown head returns null (out-of-scope, not error)", () => {
    expect(headToMeijerG("FooBar", [sym("z")])).toBeNull();
    expect(headToMeijerG("BesselJ", [I(0), sym("z")])).toBeNull();
  });

  test("Wrong arity returns null (single-arg heads only)", () => {
    expect(headToMeijerG("Erf", [])).toBeNull();
    expect(headToMeijerG("Erf", [sym("a"), sym("b")])).toBeNull();
    expect(headToMeijerG("Erfc", [])).toBeNull();
    expect(headToMeijerG("Erfi", [sym("a"), sym("b")])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 2 — byte-identical round-trip property (the bridge's correctness contract)
// -----------------------------------------------------------------------------

describe("round-trip: headToMeijerG(...).zInverse() preserves args byte-identically", () => {
  for (const head of ["Erf", "Erfc", "Erfi"] as const) {
    for (const sample of ARG_SAMPLES) {
      test(`${head}(${sample.label})`, () => {
        const fwd = headToMeijerG(head, [sample.value]);
        expect(fwd).not.toBeNull();
        if (!fwd) return;
        const recovered = fwd.zInverse();
        expect(recovered.length).toBe(1);
        // Byte-identical: canonicalize bytes must match exactly.
        expect(canonicalize(recovered[0]!)).toBe(canonicalize(sample.value));
      });
    }
  }

  test("InverseErf round-trip is null (cannot round-trip)", () => {
    expect(headToMeijerG("InverseErf", [sym("y")])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 3 — backward standalone bridge (meijerGToHead)
// -----------------------------------------------------------------------------

describe("meijerGToHead — standalone backward bridge (R4 §2)", () => {
  test("Form A.Erf G-form → Erf head, args = [√(z-slot)]", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erf", [z])!;
    const bwd = meijerGToHead(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("Erf");
    expect(bwd.args.length).toBe(1);
    // Standalone reconstruction emits `√(z²)` — semantically `|z|` but
    // structurally just the literal `mkPower(z², 1/2)`. cas-simplify
    // may or may not reduce further; the bridge does not pretend to.
    expect(canonicalize(bwd.args[0]!)).toBe(canonicalize(mkPower(fwd.gForm.z, R(1, 2))));
  });

  test("Erfc G-form (canonical [0, 1/2] bm) → Erfc head", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erfc", [z])!;
    const bwd = meijerGToHead(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("Erfc");
  });

  test("Erfc G-form (reverse [1/2, 0] bm) ALSO matches (Γ-product symmetric)", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erfc", [z])!;
    // Reverse bm order — the standalone backward bridge accepts both
    // (it doesn't go through the dispatcher's canonical-sort pre-pass).
    const reversed: MeijerGForm = {
      an: fwd.gForm.an,
      ap: fwd.gForm.ap,
      bm: [fwd.gForm.bm[1]!, fwd.gForm.bm[0]!],
      bq: fwd.gForm.bq,
      z: fwd.gForm.z,
    };
    const bwd = meijerGToHead(reversed);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("Erfc");
  });

  test("Erfi G-form (z-slot explicitly negated) → Erfi head", () => {
    const z = sym("z");
    const fwd = headToMeijerG("Erfi", [z])!;
    const bwd = meijerGToHead(fwd.gForm);
    expect(bwd).not.toBeNull();
    if (!bwd) return;
    expect(bwd.head).toBe("Erfi");
  });

  test("Erf vs Erfi disambiguation: same slot tuple, z-sign decides", () => {
    const z = sym("z");
    const positiveZ: MeijerGForm = {
      an: [R(1, 2)],
      ap: [],
      bm: [I(0)],
      bq: [R(-1, 2)],
      z: mkPower(z, I(2)),
    };
    const negativeZ: MeijerGForm = {
      an: [R(1, 2)],
      ap: [],
      bm: [I(0)],
      bq: [R(-1, 2)],
      z: mkNeg(mkPower(z, I(2))),
    };
    const bwdPos = meijerGToHead(positiveZ);
    const bwdNeg = meijerGToHead(negativeZ);
    expect(bwdPos?.head).toBe("Erf");
    expect(bwdNeg?.head).toBe("Erfi");
  });

  test("No-match G-form returns null (honest refusal)", () => {
    // A bog-standard exp-reduction shape that's NOT in the Erf family.
    const form: MeijerGForm = {
      an: [],
      ap: [],
      bm: [I(0)],
      bq: [],
      z: sym("z"),
    };
    expect(meijerGToHead(form)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Layer 4 — dispatcher-level regression + new-rule firing
// -----------------------------------------------------------------------------

describe("dispatcher integration: existing rules + new bridge rules", () => {
  test("existing dlmf-16-18-erf (Form B) rule still fires after I6", () => {
    // Form B: G^{1,1}_{1,2}([1], [], [1/2], [0], z) = √π · Erf(√z)
    // This is the *existing* rule from before this bead; the bridge
    // additions must NOT shadow it.
    const r = meijergSymbolic(
      { an: [I(1)], ap: [], bm: [R(1, 2)], bq: [I(0)] },
      sym("z"),
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.ruleId).toBe("dlmf-16-18-erf");
  });

  test("new erf-bridge-form-a rule fires on Form A G-shape", () => {
    // Form A: G^{1,1}_{1,2}([1/2], [], [0], [-1/2], z)
    const r = meijergSymbolic(
      { an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)] },
      sym("z"),
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.ruleId).toBe("erf-bridge-form-a");
    expect(JSON.stringify(r.expr)).toContain("Erf");
  });

  test("new erfc-bridge rule fires on Erfc G-shape", () => {
    // Erfc: G^{2,0}_{1,2}([], [1], [0, 1/2], [], z)
    const r = meijergSymbolic(
      { an: [], ap: [I(1)], bm: [I(0), R(1, 2)], bq: [] },
      sym("z"),
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.ruleId).toBe("erfc-bridge");
    expect(JSON.stringify(r.expr)).toContain("Erfc");
  });

  test("new erfi-bridge rule fires on Erfi G-shape (z explicitly negated)", () => {
    // Erfi: G^{1,1}_{1,2}([1/2], [], [0], [-1/2], −z)
    const negatedZ = mkNeg(sym("z"));
    const r = meijergSymbolic(
      { an: [R(1, 2)], ap: [], bm: [I(0)], bq: [R(-1, 2)] },
      negatedZ,
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.ruleId).toBe("erfi-bridge");
    // The dispatcher post-processes via `casSimplify`, which applies
    // I4's Erfi-canonicaliser identity (`Erfi(z) → −i · Erf(iz)`,
    // worklog 134). So the output expression contains `Erf` with an
    // `I` (imaginary unit) multiplied into the argument, not a literal
    // `Erfi` head. The rule fired (ruleId is `erfi-bridge`); the
    // canonicalisation is the cas-simplify pipeline's job.
    const json = JSON.stringify(r.expr);
    expect(json).toContain("Erf");
    expect(json).toContain('"name":"I"');
  });

  test("Erf vs Erfi at the dispatcher level: zMatch partitions cleanly", () => {
    // Same slot tuple — different z. The dispatcher's first-match-wins
    // discipline, combined with `zMatch` declining the wrong head,
    // routes each input to its correct rule.
    const erfShape = {
      an: [R(1, 2)],
      ap: [],
      bm: [I(0)],
      bq: [R(-1, 2)],
    };
    const rErf = meijergSymbolic(erfShape, sym("z")); // positive z
    const rErfi = meijergSymbolic(erfShape, mkNeg(sym("z"))); // negated z
    expect(rErf.kind).toBe("matched");
    expect(rErfi.kind).toBe("matched");
    if (rErf.kind !== "matched" || rErfi.kind !== "matched") return;
    expect(rErf.ruleId).toBe("erf-bridge-form-a");
    expect(rErfi.ruleId).toBe("erfi-bridge");
  });
});

// -----------------------------------------------------------------------------
// Layer 5 — numerical agreement (DEFERRED — pending bead `d6s`)
// -----------------------------------------------------------------------------

describe("numerical agreement (bridge ↔ arbprec MeijerG)", () => {
  test.skip("bigErf(z) ≡ wrap(meijergArbprec(gForm)) at 50 dp [pending bead d6s]", () => {
    // Cross-validation: at 50 decimal digits, the bigfloat Erf evaluator
    // and the arbprec MeijerG evaluator (when bead `d6s` ships) must
    // agree on the wrapped bridge output. This is the substrate-level
    // tie between I3 (bigCErf) and the bridge.
    //
    // Skipped today: bead `d6s` (per-head arbprec MeijerG evaluator)
    // has not landed. When it does, this test wires the cross-check.
    // Until then, structural byte-identity (Layer 2) is the bridge's
    // correctness contract; the numerical agreement is the substrate
    // closure, not the bridge's contract.
  });
});

// Suppress lint for sym; kept import-grouped for symmetry with other test files.
void sym;
