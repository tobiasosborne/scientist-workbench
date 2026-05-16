// =============================================================================
// Stokes multipliers for the Meijer-G connection formula — DLMF §16.11(iii)
// =============================================================================
//
// `stokesMultiplier(kappa, sectorIndex, signOfImZ, workingBits)` is the
// pure-table-lookup function that returns the Stokes multiplier
// `S_k ∈ {0, 1, −1, i, −i}` (or `−1`, `+1` for real cases) for a given
// (κ, sectorIndex, sign-of-Im(z)) triple. The caller — Part 2 of bead
// `egf` (hv0.9.2) — uses the table to assemble the compound asymptotic
//
//   G^{m,n}_{p,q}(z)
//      ~ H^{m,n}_{p,q}(z) + Σ_k S_k · E_{p,q}(z · e^{2π i k / κ})
//
// The mathematical specification lives in `docs/refs/dlmf-16-11.md` §4.4
// (closed table from Paris-Kaminski 2001 §2.3 Table 2.1, p. 81). The v0.1
// scope (ADR-0039 §D2) covers:
//
//   * κ = 1   (p = q):       single E representative; the multiplier
//                            depends on sector and on sign(Im z).
//                            Stokes lines at arg z = ±π/2.
//   * κ ≥ 3   (p ≤ q − 2):   multiple E representatives, each with its
//                            own multiplier. Within the principal sector
//                            the multipliers form a finite table.
//                            Principal sector half-width κπ/2.
//   * κ = 2   (p = q − 1):   OUT OF v0.1 SCOPE. The three-term formula
//                            (DLMF 16.11.8) is structurally distinct;
//                            filed as bead `scientist-workbench-fc83`.
//                            This function returns
//                            `status: "coverage-gap"` with the bead ID
//                            in `reason`.
//
// The argument naming `sectorIndex` and `signOfImZ` requires
// disambiguation:
//
//   * `sectorIndex` is the **integer k** in `E_{p,q}(z e^{2π i k / κ})`:
//     which rotated representative of the exponential series this
//     multiplier weights. The v0.1 covered range is k ∈ {−1, 0, +1};
//     this matches the K = ⌊(κ − 1)/2⌋ for odd κ in the canonical
//     compound-asymptotic sum (Paris-Kaminski eq. 2.3.1) for κ ∈ {1, 3}.
//
//   * `signOfImZ` is `−1`, `0`, or `+1`, the discrete sign of Im(z).
//     It distinguishes the upper-half-plane Stokes geometry from the
//     lower (the multipliers are reflections of each other across the
//     real axis) and handles the real-axis edge case (the principal-
//     value convention from `docs/refs/dlmf-16-11.md` §4.5).
//
// Determinism contract
// ====================
//
// The multipliers are exact rational complex numbers from the finite
// set `{0, ±1, ±i}`. Constructing them at BigFloat precision is via
// `cfromInts(re, im, prec)` — no float64 in the path, no transcendentals.
// The function is bit-deterministic forever: same `(κ, sectorIndex,
// signOfImZ, workingBits)` ⇒ same BigComplex bytes on every platform.
// `arbprec: true` trivially satisfied.
//
// The companion `principalSectorBound(kappa)` is a small Number-returning
// helper that callers use to decide *where* a Stokes line sits in the
// arg-z plane. Because it returns a `Number` (a float64), it sits in
// the "informational geometry" layer, not the numerical decision path —
// the numerical Stokes-line check is performed in BigFloat by the
// caller using `pi(workingBits)` and the κ integer directly. The
// float64 return is for diagnostics, documentation, and the principal-
// sector-bound check that lives outside the determinism-critical path.

import {
  type BigComplex,
  cfromInts,
} from "@workbench/bigfloat";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * Result of a Stokes-multiplier table lookup.
 *
 * `covered`: the triple is in v0.1 scope and the multiplier is returned
 * as a BigComplex at the requested working precision.
 *
 * `coverage-gap`: the triple is mathematically real but not in v0.1
 * scope (notably κ = 2, the three-term formula). `reason` carries the
 * follow-up bead ID so the caller can route or refuse.
 *
 * `out-of-table`: the triple is malformed (e.g. κ ≤ 0, or sectorIndex
 * outside the v0.1-covered range). `reason` explains. This is a
 * defensive return; callers should already have filtered out these
 * cases upstream.
 */
export interface StokesMultiplier {
  readonly status: "covered" | "coverage-gap" | "out-of-table";
  /** Present iff `status === "covered"`. One of {0, ±1, ±i}. */
  readonly multiplier?: BigComplex;
  /** Present iff `status !== "covered"`. */
  readonly reason?: string;
}

// -----------------------------------------------------------------------------
// Public entry — stokesMultiplier
// -----------------------------------------------------------------------------

/**
 * Look up the Stokes multiplier `S_k` for the
 * `E_{p,q}(z · e^{2π i · sectorIndex / κ})` term in the compound
 * asymptotic
 *
 *   G^{m,n}_{p,q}(z) ~ H^{m,n}_{p,q}(z) + Σ_k S_k · E_{p,q}(z e^{2π i k / κ}).
 *
 * The triple `(κ, sectorIndex, signOfImZ)` indexes into the v0.1 table:
 *
 *   κ = 1 — Case 4.4.1 (DLMF 16.11.7). The principal sector
 *           |arg z| < π/2 has the single E_0 term active with multiplier
 *           +1. Crossing the upper Stokes line (arg z = +π/2, in the
 *           Im(z) > 0 half-plane) activates `E_{-1} = E(z e^{-2π i})`
 *           with multiplier +i. Crossing the lower Stokes line
 *           (arg z = −π/2, Im(z) < 0) activates `E_{+1} = E(z e^{+2π i})`
 *           with multiplier −i.
 *
 *   κ = 2 — coverage-gap. Filed as `scientist-workbench-fc83`.
 *
 *   κ ≥ 3 — Case 4.4.3 (DLMF 16.11.9). The principal sector
 *           |arg z| < κπ/2 has multiple E_k representatives all active
 *           with multipliers per the table. v0.1 covers k ∈ {−1, 0, +1}
 *           which spans the most-common shape (G^{2,1}_{1,3} etc).
 *
 *   κ ≤ 0 — out-of-table. The dispatcher should have refused upstream
 *           (ADR-0039 §D1 `canUseAsymptotic` filter on κ ≤ 0 ∧ n < p).
 */
export function stokesMultiplier(
  kappa: number,
  sectorIndex: number,
  signOfImZ: -1 | 0 | 1,
  workingBits: number,
): StokesMultiplier {
  // --- input validation (defensive; the table is a pure lookup) ---
  if (!Number.isInteger(kappa)) {
    return {
      status: "out-of-table",
      reason: `kappa must be an integer; got ${kappa}`,
    };
  }
  if (!Number.isInteger(sectorIndex)) {
    return {
      status: "out-of-table",
      reason: `sectorIndex must be an integer; got ${sectorIndex}`,
    };
  }
  if (signOfImZ !== -1 && signOfImZ !== 0 && signOfImZ !== 1) {
    return {
      status: "out-of-table",
      reason: `signOfImZ must be one of {-1, 0, +1}; got ${signOfImZ}`,
    };
  }
  if (!Number.isInteger(workingBits) || workingBits < 32) {
    return {
      status: "out-of-table",
      reason: `workingBits must be a positive integer ≥ 32; got ${workingBits}`,
    };
  }
  if (kappa <= 0) {
    return {
      status: "out-of-table",
      reason:
        `κ = ${kappa} ≤ 0; the Meijer-G asymptotic in this regime does ` +
        `not call the Stokes-multiplier table (the algebraic series alone ` +
        `is meaningless and Borel resummation is needed instead — out of ` +
        `v0.1 scope). The dispatcher's canUseAsymptotic filter (ADR-0039 ` +
        `§D1) should have refused upstream.`,
    };
  }

  // --- κ = 2 is the explicit coverage gap (bead fc83) ---
  if (kappa === 2) {
    return {
      status: "coverage-gap",
      reason:
        "egf v0.1 covers kappa=1 and kappa>=3 only; kappa=2 (p=q-1) is " +
        "filed as scientist-workbench-fc83 (three-term H + E^- + E^+ " +
        "connection formula; DLMF 16.11.8). The Stokes-multiplier " +
        "structure for kappa=2 is mathematically distinct: both " +
        "E(z e^{-pi i}) and E(z e^{+pi i}) are active across the entire " +
        "principal sector with multiplier +1, no Stokes switching.",
    };
  }

  // --- κ = 1 table (Case 4.4.1) ---
  //
  // sectorIndex ∈ {−1, 0, +1}: which E_k representative.
  // signOfImZ ∈ {−1, 0, +1}: which half-plane.
  //
  // The principal E_0 term is always active (multiplier +1) in the
  // principal sector |arg z| < π/2. The "rotated" representatives
  // E_{-1} = E(z e^{-2π i}) and E_{+1} = E(z e^{+2π i}) activate
  // only across the Stokes lines at arg z = ±π/2, with multipliers
  // ±i per the user's spec (cross-checked against DLMF 16.11.7).
  //
  // Geometric rule: E_{-1} is the upper-Stokes-crossing
  // representative — active when signOfImZ ≥ 0 (upper half or real
  // axis), inactive when signOfImZ < 0. Conversely E_{+1} is the
  // lower-Stokes-crossing representative — active when signOfImZ ≤ 0.
  //
  // The "inactive" multiplier is exact 0 (not "this E term doesn't
  // exist" — it does, but its contribution to the assembly vanishes).
  if (kappa === 1) {
    return kappa1Multiplier(sectorIndex, signOfImZ, workingBits);
  }

  // --- κ ≥ 3 table (Case 4.4.3) ---
  //
  // From the DLMF reference doc §4.4 Case 4.4.3 (cross-validated
  // against P&K Table 2.1 p. 81): for κ = 3 within the principal
  // sector |arg z| < 3π/2, all three E_k for k ∈ {−1, 0, +1} are
  // active with the following multipliers depending on arg z:
  //
  //   arg z = 0 (positive real, signOfImZ = 0):
  //     S_{-1} = 1,  S_0 = 0,  S_{+1} = 1
  //
  //   crossing arg z = ±π/3 (well-inside the principal sector,
  //   signOfImZ = ±1):
  //     S_{-1} = 1,  S_0 = 1,  S_{+1} = 1
  //
  // For higher κ (5, 7, …) the table extends but the sectorIndex
  // range widens too. v0.1 limits sectorIndex to {−1, 0, +1}; out-of-
  // range sectorIndex returns out-of-table.
  if (kappa >= 3) {
    return kappaGE3Multiplier(kappa, sectorIndex, signOfImZ, workingBits);
  }

  // Unreachable for integer κ ∉ {1, 2, 3+} and κ > 0 — the κ ≤ 0
  // branch caught everything else. Defensive default:
  return {
    status: "out-of-table",
    reason: `unhandled kappa = ${kappa}; v0.1 covers κ = 1 and κ ≥ 3`,
  };
}

// -----------------------------------------------------------------------------
// κ = 1 table
// -----------------------------------------------------------------------------
//
// Multipliers from the set {0, +1, +i, -i}. We index `sectorIndex` ∈
// {−1, 0, +1} and `signOfImZ` ∈ {−1, 0, +1}.

function kappa1Multiplier(
  sectorIndex: number,
  signOfImZ: -1 | 0 | 1,
  workingBits: number,
): StokesMultiplier {
  // sectorIndex = 0 is always the principal E_0 = E(z). In the
  // principal sector |arg z| < π/2, multiplier = +1 (E is dominant);
  // outside, the caller wouldn't be invoking the algebraic + E_0
  // decomposition in the first place (it would have to use a rotated
  // representative). v0.1 covers principal-sector-and-just-past inputs;
  // the result `+1` is correct for both Im(z) ≥ 0 and Im(z) < 0 in the
  // principal sector.
  if (sectorIndex === 0) {
    return {
      status: "covered",
      multiplier: cfromInts(1n, 0n, workingBits),
    };
  }

  // sectorIndex = −1 is the upper-Stokes representative
  // E_{-1} = E(z e^{-2π i}). Active when signOfImZ ≥ 0 (upper half-
  // plane or real axis), multiplier = +i. Inactive when signOfImZ < 0
  // (lower half — wrong geometry for the rotation to have crossed),
  // multiplier = 0.
  if (sectorIndex === -1) {
    if (signOfImZ >= 0) {
      // +i
      return {
        status: "covered",
        multiplier: cfromInts(0n, 1n, workingBits),
      };
    }
    // signOfImZ < 0: inactive
    return {
      status: "covered",
      multiplier: cfromInts(0n, 0n, workingBits),
    };
  }

  // sectorIndex = +1 is the lower-Stokes representative
  // E_{+1} = E(z e^{+2π i}). Active when signOfImZ ≤ 0, multiplier =
  // −i. Inactive when signOfImZ > 0, multiplier = 0.
  if (sectorIndex === 1) {
    if (signOfImZ <= 0) {
      // -i
      return {
        status: "covered",
        multiplier: cfromInts(0n, -1n, workingBits),
      };
    }
    // signOfImZ > 0: inactive
    return {
      status: "covered",
      multiplier: cfromInts(0n, 0n, workingBits),
    };
  }

  // |sectorIndex| ≥ 2: out of v0.1 scope for κ = 1.
  return {
    status: "out-of-table",
    reason:
      `kappa=1, sectorIndex=${sectorIndex}: v0.1 covers ` +
      `sectorIndex ∈ {-1, 0, +1} only. Larger |sectorIndex| corresponds ` +
      `to non-principal Riemann sheets and is out of v0.1 scope.`,
  };
}

// -----------------------------------------------------------------------------
// κ ≥ 3 table
// -----------------------------------------------------------------------------
//
// For κ ≥ 3 in the principal sector |arg z| < κπ/2, multiple E_k
// representatives are active simultaneously. The κ = 3 entries come
// from DLMF 16.11.9 (the p ≤ q − 2 connection: G ~ E^- + E^+, with
// both multipliers exactly +1 throughout the principal sector — no
// Stokes switching). On the positive real axis (signOfImZ = 0,
// arg z = 0), the principal E_0 has multiplier 0 (subdominant) and
// the two rotated representatives carry the asymptotic with
// multipliers +1 each; off the real axis (signOfImZ = ±1), all three
// representatives contribute with multiplier +1 (Case 4.4.3 entry
// "crossing arg z = +π/3").
//
// For κ = 5, 7, … the structure extends with more sectorIndex values;
// v0.1 caps at sectorIndex ∈ {−1, 0, +1}.

function kappaGE3Multiplier(
  kappa: number,
  sectorIndex: number,
  signOfImZ: -1 | 0 | 1,
  workingBits: number,
): StokesMultiplier {
  if (sectorIndex < -1 || sectorIndex > 1) {
    return {
      status: "out-of-table",
      reason:
        `kappa=${kappa}, sectorIndex=${sectorIndex}: v0.1 covers ` +
        `sectorIndex ∈ {-1, 0, +1} only. Wider sectorIndex ranges ` +
        `appear at higher κ but are out of v0.1 scope.`,
    };
  }

  // Positive real axis case: signOfImZ = 0, arg z = 0. From Case
  // 4.4.3 table:
  //   S_{-1} = 1, S_0 = 0, S_{+1} = 1.
  if (signOfImZ === 0) {
    if (sectorIndex === 0) {
      return {
        status: "covered",
        multiplier: cfromInts(0n, 0n, workingBits),
      };
    }
    // |sectorIndex| = 1: active with +1
    return {
      status: "covered",
      multiplier: cfromInts(1n, 0n, workingBits),
    };
  }

  // Off the real axis (signOfImZ = ±1): all three representatives
  // contribute with multiplier +1 (Case 4.4.3 "crossing arg z = ±π/3"
  // entry; the algebraic-vs-exponential dominance ordering shifts but
  // the connection-formula multipliers stay at +1).
  return {
    status: "covered",
    multiplier: cfromInts(1n, 0n, workingBits),
  };
}

// -----------------------------------------------------------------------------
// Public entry — principalSectorBound
// -----------------------------------------------------------------------------

/**
 * Return the principal-sector half-width angle for the given κ, as a
 * float64 (radians) + a short human-readable description. Diagnostic /
 * documentation helper; the numerical decision is in BigFloat (via
 * `pi(workingBits)` in the caller).
 *
 * The principal-sector half-width for the Meijer-G algebraic series is
 *   θ = (m + n − (p + q)/2) · π
 * but the **Stokes-line geometry** for E_{p,q} is governed by κ alone:
 * Stokes lines sit at arg z = ±κπ/2 (DLMF 16.11.3, ref doc §3.1).
 * For v0.1's connection-formula scope, the relevant boundary is the
 * Stokes-line geometry; this helper returns κπ/2.
 *
 *   κ = 1: π/2
 *   κ = 2: π
 *   κ = 3: 3π/2
 *   κ = 4: 2π
 *   …
 *
 * For κ ≥ 2 the bound exceeds π and lives on non-principal Riemann
 * sheets; the description annotates this.
 */
export function principalSectorBound(
  kappa: number,
): { angle: number; description: string } {
  if (!Number.isInteger(kappa) || kappa < 1) {
    return {
      angle: NaN,
      description:
        `kappa=${kappa}: out of range; the Stokes-line geometry is ` +
        `defined for κ ≥ 1 only.`,
    };
  }
  const angle = (kappa * Math.PI) / 2;
  let description: string;
  if (kappa === 1) {
    description =
      "kappa=1 (p=q): Stokes lines at arg z = ±π/2 (imaginary axes); " +
      "principal sector |arg z| < π/2.";
  } else if (kappa === 2) {
    description =
      "kappa=2 (p=q-1): Stokes lines at arg z = ±π (negative real axis); " +
      "principal sector |arg z| < π. v0.1 returns coverage-gap on the " +
      "multiplier table; the geometry helper is informational only.";
  } else {
    description =
      `kappa=${kappa} (p=q-${kappa - 1}): Stokes lines at arg z = ±${kappa}π/2; ` +
      `principal sector |arg z| < ${kappa}π/2. The principal Riemann ` +
      `sheet covers only |arg z| < π; the wider half-width above is the ` +
      `analytic-continuation envelope across the cut.`;
  }
  return { angle, description };
}
