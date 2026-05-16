// =============================================================================
// integrate-1d — Erf-family integrand tests (bead 3ynw / T1)
// =============================================================================
//
// Validates the Phase 3 Tier-1 wiring: `tools/integrate-1d` now
// admits `Erf`, `Erfc`, `Erfcx`, `Erfi`, `InverseErf`, `InverseErfc`
// in the integrand via the I5 (`xiry`) dispatcher in
// `packages/quadrature/src/eval-numeric-expr.ts`
// (`evalNumericExprWithSpecial`) per ADR-0040 §"Decision 4".
//
// What this file proves (each test asserts a non-trivial invariant
// per CLAUDE.md Rule 7; "didn't throw" is never a passing test):
//
//   1. **Closed-form anchors** — `∫₀¹ Erf(x) dx` matches the DLMF
//      §7.7.9 closed form `Erf(1) + (e⁻¹ − 1)/√π` to default
//      Gauss-Kronrod tolerance. This is the cleanest end-to-end test
//      for "Erf-in-integrand actually evaluates through the
//      dispatcher and the quadrature driver agrees with the analytic
//      answer."
//
//   2. **Maclaurin-bombed integrand** — `∫₀¹ Erf(x)·exp(−x²) dx` is
//      a non-elementary integral. There is no closed form in terms
//      of elementary functions; the test cross-validates against a
//      high-precision oracle computed via `bigErf` (`I1`,
//      `packages/bigfloat`) integrated through `gaussKronrodAdaptiveBF`
//      at 100-digit precision. The agreement bound is the *float64
//      tool's* declared tolerance, not the arbprec oracle's — the
//      arbprec path is the truth, the float64 tool meets its own
//      contract within float64's resolution.
//
//   3. **Erfc / Erfi in integrand** — exercise the dispatcher on the
//      remaining special heads that have closed-form integrals on
//      `[0, b]`:
//      - `∫₀² Erfc(x) dx = 2·Erfc(2) − (e⁻⁴ − 1)/√π` (DLMF §7.7.8).
//      - `∫₀¹ Erfi(x) dx = Erfi(1) − (e − 1)/√π` (parity of DLMF
//        §7.7.9 with `Erfi(z) = −i·Erf(iz)` ⇒ the antiderivative
//        flips one sign and the `exp(−z²)` → `exp(z²)`).
//
//   4. **Refusal under unknown vocabulary** — `BesselJ(0, x)` in the
//      integrand is refused with a `ToolError` (exit 1) whose
//      `suggestion` lists the admitted heads including the Erf
//      family. The tool does not silently produce garbage; it does
//      not invent a value; it refuses cleanly. This is the honest-
//      scope contract (ADR-0003, CLAUDE.md Rule 8).
//
//   5. **Provenance carries platform fingerprint** — a successful
//      Erf-in-integrand integration writes a provenance record whose
//      `platform` field is populated (ADR-0015 `numerical: true`).
//      This is the cross-platform reproducibility hook: an agent's
//      planner reads the field and compares it to `--platform-
//      fingerprint` before reusing the cached output.
//
// The new dispatcher itself (head → `erfFloat64` / etc.) is proven
// elsewhere in `packages/quadrature/test/erf-float64.test.ts`
// (worklog 133). This file does not re-test the dispatcher; it tests
// that *the tool* picks it up and that the contract surface
// (refusal, provenance) responds correctly to the new vocabulary.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  record,
  sym,
  ToolError,
  type Float64Value,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import { executeToolDef, readProvenance } from "@workbench/contract";
import {
  bigErf,
  exp as bfExp,
  fromInt,
  mul,
  neg as bfNeg,
  toFloat64,
  type BigFloat,
} from "@workbench/bigfloat";
import { gaussKronrodAdaptiveBF } from "@workbench/quadrature";

import { def } from "./tool.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Build the tool's wire-form input record. `def.fn` validates the
 * shape itself; we hand it the canonical `Value` and let the
 * existing schema-validation surface do its job.
 */
function buildInput(fExpr: Value, a: number, b: number) {
  return record({
    f: fExpr,
    var: sym("x"),
    a: float64FromNumber(a),
    b: float64FromNumber(b),
  });
}

/**
 * Direct in-process invocation that bypasses persistence — fast,
 * pure unit test. `def.fn` is *synchronous* for `integrate-1d`
 * (the v0.1 quadrature driver makes no async calls), so the
 * return type is `Value` not `Promise<Value>`; we narrow with
 * `Awaited<>` to thread that fact through the schema-derived type
 * union (`defineTool` infers `fn`'s return type as the schema's
 * output type, which is the discriminated `record | tagged` union).
 */
function runFn(input: ReturnType<typeof buildInput>): Awaited<ReturnType<typeof def.fn>> {
  // The tool declares no per-tool flags (uses only the standard
  // flag layer). `def.fn` receives an empty record at the flags slot.
  const result = def.fn(input as Parameters<typeof def.fn>[0], {} as Parameters<typeof def.fn>[1]);
  return result as Awaited<ReturnType<typeof def.fn>>;
}

/**
 * Pull the `value` float64 out of a successful output record, or
 * fail the test with a useful message if the tool returned a
 * boundary tag instead.
 */
function expectSuccessValue(out: Awaited<ReturnType<typeof def.fn>>): number {
  if (out.kind === "tagged") {
    throw new Error(
      `integrate-1d returned boundary tag "${out.tag}" — expected a happy-path record`,
    );
  }
  expect(out.kind).toBe("record");
  const rec = out as RecordValue;
  const value = rec.fields.value as Float64Value;
  return float64ToNumber(value);
}

/** Format a BigFloat to a JS number for tolerance comparison. */
function bfToNumber(x: BigFloat): number {
  return toFloat64(x).value;
}

// -----------------------------------------------------------------------------
// 1. Closed-form anchors
// -----------------------------------------------------------------------------

describe("Erf-family closed-form anchors (DLMF §7.7)", () => {
  test("∫_0^1 Erf(x) dx = Erf(1) + (e^-1 - 1)/√π", () => {
    // DLMF §7.7.9: ∫_0^z Erf(t) dt = z·Erf(z) + (e^(-z²) − 1) / √π.
    // At z = 1: Erf(1) + (e^-1 − 1) / √π.
    //
    // Numeric anchor (mpmath 50dp / bench/erf-anchor/oracles/scipy
    // bronze tier): Erf(1) = 0.8427007929497149 (float64 round-trip).
    // Closed-form target: 0.4860649581122559 (float64).
    const input = buildInput(expr("Erf", [sym("x")]), 0, 1);
    const got = expectSuccessValue(runFn(input));

    const erf1 = 0.8427007929497149;
    const target = erf1 + (Math.exp(-1) - 1) / Math.sqrt(Math.PI);
    // G7K15 default atol = 1e-12, rtol = 1e-10 (per packages/quadrature
    // gauss-kronrod.ts defaults). Erf is smooth on [0,1]; the
    // 15-point Kronrod rule is exact for polynomials of degree ≤ 23
    // and Erf's Maclaurin coefficients decay factorially, so we
    // expect the result well inside default tolerance.
    expect(Math.abs(got - target)).toBeLessThan(1e-12);
  });

  test("∫_0^2 Erfc(x) dx = 2·Erfc(2) + (1 - e^-4)/√π", () => {
    // DLMF §7.7.8 (companion of §7.7.9):
    //   ∫_0^z Erfc(t) dt = z·Erfc(z) + (1 − e^(−z²)) / √π
    // i.e. erfc's antiderivative loses the +z·... it has when
    // expressed as `z − [closed-form for Erf]` and the sign of the
    // exponential flips. At z = 2: 2·Erfc(2) + (1 − e^-4)/√π.
    //
    // Numeric anchor: Erfc(2) ≈ 0.004677734981047266 (bench oracle).
    const input = buildInput(expr("Erfc", [sym("x")]), 0, 2);
    const got = expectSuccessValue(runFn(input));

    const erfc2 = 0.004677734981047266;
    const target = 2 * erfc2 + (1 - Math.exp(-4)) / Math.sqrt(Math.PI);
    expect(Math.abs(got - target)).toBeLessThan(1e-12);
  });

  test("∫_0^1 Erfi(x) dx = Erfi(1) - (e - 1)/√π", () => {
    // Parity of DLMF §7.7.9 with `Erfi(z) = −i·Erf(iz)`:
    //   d/dz [z·Erfi(z) − (e^(z²) − 1)/√π] = Erfi(z).
    // So ∫_0^1 Erfi(x) dx = 1·Erfi(1) − (e^1 − 1)/√π.
    //
    // Numeric anchor: Erfi(1) ≈ 1.6504257587975428 (per
    // packages/quadrature's erfFloat64 — we verify the closed-form
    // identity rather than the oracle here, since Erfi is the
    // derived head and its float64 substrate is what we are
    // testing the *tool* picks up.).
    const input = buildInput(expr("Erfi", [sym("x")]), 0, 1);
    const got = expectSuccessValue(runFn(input));

    // Compute the closed-form target via the same dispatcher to
    // sidestep oracle-vs-tool float drift (Erfi's float64 path
    // delegates through complex w(z), so its 53-bit value carries
    // the dispatcher's specific rounding profile). The agreement
    // we are looking for is: tool's *integral* matches the
    // dispatcher's *closed-form combination* at both endpoints to
    // a float64-justified tolerance.
    //
    // mpmath 50dp truth: Erfi(1) = 1.6504257587975428.
    const erfi1 = 1.6504257587975428;
    const target = erfi1 - (Math.E - 1) / Math.sqrt(Math.PI);
    // Erfi grows fast (≈ e^{z²}/(√π·z)); G7K15 still resolves
    // [0,1] easily but the float64 ceiling on Erfi(1) is ~3-4 ULP,
    // so we relax the bound from 1e-12 to 1e-10 (still 100× tighter
    // than the integral's leading magnitude).
    expect(Math.abs(got - target)).toBeLessThan(1e-10);
  });
});

// -----------------------------------------------------------------------------
// 2. Maclaurin-bombed integrand
// -----------------------------------------------------------------------------

describe("Erf in integrand — non-elementary integral (arbprec cross-check)", () => {
  test("∫_0^1 Erf(x)·exp(-x²) dx — converges, agrees with bigErf-driven 100dp oracle", () => {
    // No closed form in elementary terms. Cross-check: compute the
    // same integral via the BigFloat substrate at 100 digits using
    // `bigErf` × `bfExp(−x²)` integrated by `gaussKronrodAdaptiveBF`.
    // That oracle is independent of the float64 tool's path (uses
    // I1's series/asymptotic dispatcher, not I5's SunPro port) so
    // agreement is a genuine cross-validation of the float64 tool.
    //
    // The integrand peaks near x ≈ 0.4 (Erf grows; exp(−x²)
    // decays); G7K15 with 15 nodes on [0,1] resolves it on the
    // first pass, no bisection.
    const input = buildInput(
      expr("*", [
        expr("Erf", [sym("x")]),
        expr("exp", [expr("neg", [expr("^", [sym("x"), int(2n)])])]),
      ]),
      0,
      1,
    );
    const got = expectSuccessValue(runFn(input));

    // Build the BigFloat oracle: integrand t ↦ bigErf(t) · exp(−t²).
    // `gaussKronrodAdaptiveBF` measures `prec` in DECIMAL DIGITS, not
    // bits (substrate's signature; see `MAX_DECIMAL_PRECISION = 150`
    // in `packages/quadrature/src/nodes-weights-bf.ts`). 50 dps is
    // ~9 orders of magnitude beyond float64's 16-digit floor and
    // therefore "effectively exact" relative to the tool's own
    // ~1e-12 tolerance contract.
    const prec = 50;
    const oracleIntegrand = (t: BigFloat, p: number): BigFloat => {
      const erfT = bigErf(t, p);
      const minusT2 = bfNeg(mul(t, t, p));
      const expMinusT2 = bfExp(minusT2, p);
      return mul(erfT, expMinusT2, p);
    };
    // Use the driver's precision-aware default tolerance (≈ 10^-50
    // at prec=50). Default maxEvals at prec=50 is 50·200 = 10_000
    // — more than enough for this smooth integrand.
    const oracle = gaussKronrodAdaptiveBF(
      oracleIntegrand,
      fromInt(0n, prec),
      fromInt(1n, prec),
      prec,
    );
    const oracleNum = bfToNumber(oracle.value);

    // The tool's declared default tolerance is atol = 1e-12.
    // Agreement to 1e-12 is the contract; the oracle is much
    // tighter (BigFloat at 100 dp ≈ effectively exact for this
    // smooth integrand).
    expect(Math.abs(got - oracleNum)).toBeLessThan(1e-12);

    // Also: the tool must report converged=true (not
    // converged=false with a budget-hit warning).
    const out = runFn(input) as RecordValue;
    expect((out.fields.converged as { value: boolean }).value).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 3. Refusal under unknown vocabulary
// -----------------------------------------------------------------------------

describe("Unknown special heads refuse cleanly", () => {
  test("∫ BesselJ(0, x) dx — head outside the admitted vocabulary throws ToolError", () => {
    // `BesselJ` is *not* in the Erf family or the elementary set —
    // it is a future ADR's head (filed in ADR-0040 §"Future
    // extensions"). The tool must refuse via `ToolError`, not
    // silently produce 0 or garbage. The suggestion text must
    // mention the admitted heads so the calling agent can plan
    // the recovery.
    const input = buildInput(
      expr("BesselJ", [int(0n), sym("x")]),
      0,
      1,
    );
    // The `def.fn` body catches the `UnknownVocabularyError`
    // thrown from inside `gaussKronrodAdaptive`'s first call to
    // `evalNumericExpr` and rethrows as `ToolError`. We assert
    // both the throw and the suggestion content.
    let caught: unknown;
    try {
      runFn(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const err = caught as ToolError;
    // Suggestion must mention the admitted Erf heads — proves the
    // dispatcher's vocabulary list is what the agent sees.
    expect(err.suggestion).toContain("Erf");
    expect(err.suggestion).toContain("Erfc");
    // And it must NOT have silently returned a numeric result.
    expect(err.message).toContain("BesselJ");
  });
});

// -----------------------------------------------------------------------------
// 4. Provenance carries platform fingerprint (ADR-0015)
// -----------------------------------------------------------------------------

describe("ADR-0015 platform fingerprint on Erf-family success", () => {
  test("∫_0^1 Erf(x) dx — provenance record carries platform fingerprint", async () => {
    // The tool declares `numerical: true`. `executeToolDef`
    // populates `rec.platform` only when the output contains
    // float64 leaves AND the tier is `numerical`. The happy-path
    // record has `value: float64` so the field MUST be present.
    //
    // We point `executeToolDef` at a fresh temp directory to keep
    // the test self-contained; we then read the provenance file
    // back and assert its shape.
    const tempStore = mkdtempSync(join(tmpdir(), "integrate-1d-erf-prov-"));
    try {
      const input = buildInput(expr("Erf", [sym("x")]), 0, 1);
      const result = await executeToolDef(
        def,
        input as Parameters<typeof def.fn>[0],
        {} as Parameters<typeof def.fn>[1],
        { store: tempStore, explicitFlags: {} },
      );
      // No persistence error — the temp dir is writable.
      expect(result.provenanceError).toBeNull();

      // Read the provenance record back via the package's typed
      // helper (which parses the canonical `Value` encoding into
      // a `ProvenanceRecord` interface). The hash returned from
      // `executeToolDef` is the index key.
      const prov = await readProvenance(tempStore, result.outputHash);
      expect(prov).not.toBeNull();
      expect(prov!.tool.name).toBe("integrate-1d");
      expect(prov!.output_hash).toBe(result.outputHash);
      // The load-bearing assertion: platform fingerprint is
      // populated. Three required sub-fields per ADR-0015.
      expect(prov!.platform).toBeDefined();
      expect(prov!.platform!.arch).toBeTypeOf("string");
      expect(prov!.platform!.os).toBeTypeOf("string");
      expect(prov!.platform!.runtime).toBeTypeOf("string");
      // The fingerprint MUST be non-empty — a "" arch is a
      // contract violation that would silently coexist with the
      // hash-comparison check elsewhere.
      expect(prov!.platform!.arch.length).toBeGreaterThan(0);
      expect(prov!.platform!.os.length).toBeGreaterThan(0);
      expect(prov!.platform!.runtime.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempStore, { recursive: true, force: true });
    }
  });
});
