// =============================================================================
// Goldens — meijer-g-asymptotic-only
// =============================================================================
//
// Each entry exercises one v0.1 code-path branch:
//   * principal-sector success at modest precision (entire-function regime
//     where Slater Series 2 also converges; agreement is the load-bearing
//     witness);
//   * principal-sector success in the genuinely-asymptotic (p > q) regime;
//   * each refusal class (`stokes-line`, `secondary-sector`, `small-z`,
//     `no-pole-residues`, `input-error`).
//
// Goldens are regenerated via
// `bun scripts/generate-goldens.ts --tool meijer-g-asymptotic-only`. The
// generated files in `goldens/` are byte-deterministic given
// `arbprec: true`.

import { bigcomplexToValue, cfromInts, cfromStrings } from "@workbench/bigfloat";
import { list, record, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

const PREC = 256;

const cZero = bigcomplexToValue(cfromInts(0n, 0n, PREC));
const cHalf = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const cOne = bigcomplexToValue(cfromInts(1n, 0n, PREC));
const c100 = bigcomplexToValue(cfromInts(100n, 0n, PREC));
const c1000 = bigcomplexToValue(cfromInts(1000n, 0n, PREC));
const cNeg100 = bigcomplexToValue(cfromInts(-100n, 0n, PREC));
const c0_5 = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const c100i = bigcomplexToValue(cfromStrings("0", "100", PREC));

// Bead 43i (ADR-0039 §D1): the `n < p, κ ≥ 1` regime. The
// Paris–Kaminski analytical truncation `N* = ⌊|κ z^{1/κ}|⌋` is
// exercised here at `|z| ≥ 20`, where the per-pole truncation
// index is large enough for the partial sum to converge to the
// true G-value (cross-checked against `wolframscript` and `mpmath`
// at 30 dps; agreement to 30+ dps for every case below).
//
// The shape constraint `m + n = p` is upheld in every case — this
// is the structural condition under which the principal-sector
// exponential `E^{m,n}_{p,p}` contribution has vanishing Stokes
// multiplier and the algebraic series alone reproduces the true
// G-function. The complementary `m + n > p` regime is `egf` scope
// (ADR-0039 §D2).
const c30 = bigcomplexToValue(cfromInts(30n, 0n, PREC));
const c50 = bigcomplexToValue(cfromInts(50n, 0n, PREC));
const c20 = bigcomplexToValue(cfromInts(20n, 0n, PREC));
const c40 = bigcomplexToValue(cfromInts(40n, 0n, PREC));
const c20p5i = bigcomplexToValue(cfromStrings("20", "5", PREC));
const c30p15i = bigcomplexToValue(cfromStrings("30", "15", PREC));

const cP1_3 = bigcomplexToValue(cfromStrings("0.3", "0", PREC));
const cP1_6 = bigcomplexToValue(cfromStrings("0.6", "0", PREC));
const cP1_1 = bigcomplexToValue(cfromStrings("0.1", "0", PREC));
const cN1_2 = bigcomplexToValue(cfromStrings("-0.2", "0", PREC));
const cP0_75 = bigcomplexToValue(cfromStrings("0.75", "0", PREC));
const cN0_25 = bigcomplexToValue(cfromStrings("-0.25", "0", PREC));
const cP0_4 = bigcomplexToValue(cfromStrings("0.4", "0", PREC));
const cP0_7 = bigcomplexToValue(cfromStrings("0.7", "0", PREC));
const cN0_1 = bigcomplexToValue(cfromStrings("-0.1", "0", PREC));
const cP0_25 = bigcomplexToValue(cfromStrings("0.25", "0", PREC));
const cP0_5 = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const cP0_6 = bigcomplexToValue(cfromStrings("0.6", "0", PREC));
const cP0_8 = bigcomplexToValue(cfromStrings("0.8", "0", PREC));
const cP0_2 = bigcomplexToValue(cfromStrings("0.2", "0", PREC));
const cP0_3 = bigcomplexToValue(cfromStrings("0.3", "0", PREC));
const cP0_4b = bigcomplexToValue(cfromStrings("0.4", "0", PREC));

function gParams(
  an: Value[],
  ap: Value[],
  bm: Value[],
  bq: Value[],
  z: Value,
): Value {
  return record({
    an: list(an),
    ap: list(ap),
    bm: list(bm),
    bq: list(bq),
    z,
  });
}

export const goldens: GoldenSpec[] = [
  // All cases below run at the default precision = 50 dps. Goldens omit
  // the per-case `flags` field because the asymptotic lane's tier
  // behaviour (entire-function, optimal-truncation, divergent inner pFq,
  // sector boundary) is exercised meaningfully at default precision;
  // precision-dial sweeps live in `tool.test.ts`. After the lc1 / rn2
  // fixes (worklog 083) the runner threads `--precision=N` correctly
  // through to `flags.precision` — adding `flags: { precision: "..." }`
  // here would now produce different bytes (correctly so), but the
  // existing default-50 corpus stays byte-identical.

  // Principal-sector success: G^{0,1}_{1,0}(1; |100) = e^{-1/100}.
  // Inner pFq is 0F0 (entire); converges everywhere. Asymptotic
  // hits the per-pole cap (no turnaround) but the partial sum is the
  // correct value to ~50 dps.
  {
    description: "G^{0,1}_{1,0}(1; _ | 100) — entire-function asymptotic",
    input: gParams([cOne], [], [], [], c100),
  },

  // G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 100) was the previous κ=2
  // optimal-truncation example. ADR-0039 §D2 refuses the entire κ=2
  // regime with `coverage-gap` (bead fc83), so this entry now
  // exercises the new refusal class on the *same* shape — providing
  // a golden for the wire-schema's `coverage-gap` tag.
  {
    description:
      "G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 100) ⇒ coverage-gap (κ=2, bead fc83)",
    input: gParams([cHalf], [], [cZero], [cOne], c100),
  },

  // G^{0,1}_{2,0}([1, 1/2]; |100) — genuinely divergent inner pFq
  // (p_inner=2, q_inner=0). Covered by Braaksma but Slater diverges.
  {
    description: "G^{0,1}_{2,0}([1, 1/2]; _ | 100) — divergent-asymptotic",
    input: gParams([cOne, cHalf], [], [], [], c100),
  },

  // G^{1,1}_{1,1}([1/2]; _ ; [0]; _ | 1000) — κ=1 principal-sector
  // success at larger |z|. Replaces the previous κ=2 entry which now
  // refuses with coverage-gap.
  {
    description:
      "G^{1,1}_{1,1}([1/2]; _ ; [0]; _ | 1000) — κ=1 deep asymptotic",
    input: gParams([cHalf], [], [cZero], [], c1000),
  },

  // Refusal: κ=2 (coverage-gap). The previous golden at this slot
  // was the same shape at z = -100 expecting secondary-sector; under
  // ADR-0039 §D2 the κ=2 classifier refuses upstream with
  // coverage-gap regardless of arg z.
  {
    description: "z = -100, κ=2 shape ⇒ coverage-gap (bead fc83)",
    input: gParams([cHalf], [], [cZero], [cOne], cNeg100),
  },

  // Refusal: stokes-band-refused. κ=1 shape with z at arg ≈ π/2; the
  // Stokes-band Option C (ADR-0039 §D5) refuses because the band
  // exceeds the sub-precision threshold at this |z|.
  {
    description: "z = 100i (arg z = π/2), κ=1 ⇒ stokes-band-refused or stokes",
    input: gParams([cHalf], [], [cZero], [], c100i),
  },

  // Refusal: small-z. |z| = 0.5 < 1. κ=1 shape per the rest of the
  // refusal-class coverage.
  {
    description: "|z| = 0.5, κ=1 ⇒ small-z",
    input: gParams([cHalf], [], [cZero], [], c0_5),
  },

  // Refusal: no-pole-residues. n = 0 (an empty).
  {
    description: "n = 0 ⇒ no-pole-residues",
    input: gParams([], [], [cZero], [], c100),
  },

  // ----- Bead 43i — n < p, κ ≥ 1 regime (ADR-0039 §D1) -----
  //
  // Each entry below exercises the Paris–Kaminski analytical
  // truncation index `N* = ⌊|κ z^{1/κ}|⌋`. The values were cross-
  // validated at 30 dps against `wolframscript` and `mpmath` and
  // agree to 30+ dps. The shape constraint `m + n = p` is upheld;
  // `m + n > p` is `egf` scope and out of scope for `43i`.

  // G^{1,1}_{2,2}([3/10],[6/10],[1/10],[-2/10] | 30) — κ=1, n=1<p=2,
  // real z, pure-real result. Verified:
  // wolframscript: 0.0683877861434372189170233513017043894031...
  {
    description: "G^{1,1}_{2,2}([3/10],[6/10],[1/10],[-2/10] | 30) — 43i n<p κ=1 real",
    input: gParams([cP1_3], [cP1_6], [cP1_1], [cN1_2], c30),
  },

  // G^{1,1}_{2,2}([1/2],[3/4],[0],[-1/4] | 50) — κ=1, n=1<p=2,
  // real z, the canonical example shape from ADR-0039.
  // wolframscript: 0.2261309903384084605007442938576602041949...
  {
    description: "G^{1,1}_{2,2}([1/2],[3/4],[0],[-1/4] | 50) — 43i κ=1 n<p",
    input: gParams([cP0_5], [cP0_75], [cZero], [cN0_25], c50),
  },

  // G^{1,1}_{2,2}([1/2],[3/4],[0],[-1/4] | 20+5i) — κ=1, n<p,
  // complex z, complex result. The user's specified example shape
  // (`G^{1,1}_{2,2}(... | 0, -1/4)`) at a `|z|` large enough for
  // the algebraic series to converge to tier-A precision.
  // wolframscript: 0.3504440767930616217381493253860953144081...
  //              - 0.04357525411809995201557269306774729374961... i
  {
    description: "G^{1,1}_{2,2}([1/2],[3/4],[0],[-1/4] | 20+5i) — 43i κ=1 n<p complex",
    input: gParams([cP0_5], [cP0_75], [cZero], [cN0_25], c20p5i),
  },

  // G^{1,1}_{2,2}([4/10],[7/10],[1/10],[-1/10] | 100) — κ=1, n<p,
  // deep asymptotic (large |z|).
  // wolframscript: 0.0516264406656088822788259210175257531080...
  {
    description: "G^{1,1}_{2,2}([4/10],[7/10],[1/10],[-1/10] | 100) — 43i κ=1 n<p deep",
    input: gParams([cP0_4], [cP0_7], [cP1_1], [cN0_1], c100),
  },

  // G^{1,1}_{2,2}([1/2],[3/4],[1/4],[0] | 30+15i) — κ=1, n<p,
  // complex z with non-zero `bm`.
  // wolframscript: 0.129093566153040416095577858088117694782...
  //              - 0.0310334398561267118947746866829376775431... i
  {
    description: "G^{1,1}_{2,2}([1/2],[3/4],[1/4],[0] | 30+15i) — 43i κ=1 n<p alt bm",
    input: gParams([cP0_5], [cP0_75], [cP0_25], [cZero], c30p15i),
  },

  // G^{1,2}_{3,3}([1/2,3/5],[3/4],[0],[1/4,2/5] | 20) — κ=1, n=2,
  // p=3, multi-pole, real z. Exercises the multi-pole sum (two
  // `B_h z^{a_h-1} S_h(z)` contributions).
  // wolframscript: 0.4526160713031417399693210235023597052133...
  {
    description: "G^{1,2}_{3,3}([1/2,3/5],[3/4],[0],[1/4,2/5] | 20) — 43i n=2 multi-pole",
    input: gParams([cP0_5, cP0_6], [cP0_75], [cZero], [cP0_25, cP0_4b], c20),
  },

  // G^{1,3}_{4,4}([1/2,3/5,7/10],[4/5],[0],[1/10,1/5,3/10] | 40) —
  // κ=1, n=3, p=4, three poles. Larger shape; tests the per-pole
  // loop's accumulation logic at the upper end of typical `(m,n,p,q)`.
  // wolframscript: 3.6211844381071254503163143990052414063738...
  {
    description: "G^{1,3}_{4,4}([1/2,3/5,7/10],[4/5],[0],[1/10,1/5,3/10] | 40) — 43i n=3",
    input: gParams([cP0_5, cP0_6, cP0_7], [cP0_8], [cZero], [cP1_1, cP0_2, cP0_3], c40),
  },

  // Note: the new `κ ≤ 0 AND n < p` refusal lives in the
  // dispatcher's `canUseAsymptotic` pre-filter (ADR-0039 §D1, bead
  // 43i, `dispatcher.ts`); the asymptotic-only tool does not go
  // through that pre-filter and so cannot exercise the refusal at
  // the tool level. Coverage for the refusal lives in
  // `packages/meijer-core/test/asymptotic.test.ts` (the new
  // `canUseAsymptotic: bead 43i — κ ≤ 0 AND n < p refusal`
  // describe block).

  // ----- Bead egf — Stokes-connection-formula goldens (ADR-0039) -----
  //
  // The egf v0.1 layer assembles `G(z) ~ H(z e^{∓πi}) + Σ_k S_k · E(z e^{2πi k/κ})`
  // for inputs past the κ=1 Stokes lines at `arg z = ±π/2` and for
  // certain κ ≥ 3 regimes. Each golden below exercises one of the new
  // refusal or success paths.
  //
  // IMPORTANT (cross-validation status): the Stokes-multiplier signs
  // and the κ=1 connection-formula assembly have NOT been fully
  // validated end-to-end against `wolframscript` / `mpmath` at 30 dps
  // as of egf v0.1 landing. The investigation discovered that a
  // direct numerical comparison `G_wolfram(z) − H_truncated(z e^{∓πi})`
  // does not cleanly factor into the {0, ±1, ±i} multiplier table
  // values for an arbitrary κ=1 test point — the relative-error
  // analysis hits ~10^{-1} disagreement at modest |z|, consistent with
  // either (a) a sign error in `stokes.ts`'s multiplier table, or (b)
  // the per-pole H-rotation branch-sheet selection being off by one
  // factor of `e^{iπ(a_h − 1)}`, or (c) a Berry-smoothing transition
  // band that's wider in practice than ADR-0039 §D5 Option C's
  // sharp-switch model accommodates. The investigation is documented
  // in the egf bead's final report; for v0.1 the goldens below are
  // *regression* fixtures — they lock in whatever the kernel produces
  // so future work can detect drift. They are **not** claimed to be
  // numerically correct against an oracle.

  // κ=2 coverage-gap golden (ADR-0039 §D2; bead fc83). Confirms the
  // wire-schema's `coverage-gap` tag is emitted with the bead ID in
  // the reason field.
  {
    description:
      "κ=2 G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 50) ⇒ coverage-gap (bead fc83)",
    input: gParams([cHalf], [], [cZero], [cOne], c50),
  },

  // κ=3 G^{1,1}_{1,3} deep in principal sector. Tests that the κ-aware
  // classifier widens the principal-sector cap from `π/2 − π/64`
  // (ADR-0026 default) to `κπ/2 = 3π/2` for κ=3. Input arg z = 0
  // (positive real), well inside. Method `braaksma-algebraic`,
  // sector `principal`. Regression test of the widening.
  {
    description:
      "κ=3 G^{1,1}_{1,3}([1/3]; _ ; [1/2]; [2/3], [3/4] | 50) — deep principal, widened cap",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.333333333333333333", "0", PREC))],
      [],
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [
        bigcomplexToValue(cfromStrings("0.6666666666666666666", "0", PREC)),
        bigcomplexToValue(cfromStrings("0.75", "0", PREC)),
      ],
      c50,
    ),
  },

  // Small-|z| in-band κ=1 input ⇒ stokes-band-refused (ADR-0039 §D5
  // Option C). Band W at |z|=5, κ=1 is `5·5^{-1/2} ≈ 2.236`, capped
  // by `θ_S/2 = π/4 ≈ 0.785`; the input arg z ≈ π/2 + 0.1 has
  // `|absArg − θ_S| ≈ 0.1 < 0.785`, inside the band. Sub-precision
  // threshold at 50 dps is `2^{-98} ≈ 3·10^{-30}`, band is far above ⇒
  // refuse honestly.
  {
    description:
      "κ=1 small-|z| in-band (arg z ≈ π/2 + 0.1, |z|=5) ⇒ stokes-band-refused",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [],
      [cZero],
      [],
      bigcomplexToValue(
        cfromStrings("-0.4991671106784", "4.9750208403262", PREC),
      ),
    ),
  },

  // κ=1 past Stokes line, very large |z|. Band shrinks as |z|^{-1/(2κ)},
  // so at |z|=10000 the band is small (W = 5/sqrt(10000) = 0.05, capped
  // at π/4 — so effective W = 0.05) and the input at arg z = π/2 + 0.1
  // sits outside the band ⇒ connection-formula assembly fires
  // (`braaksma-stokes`). The numerical value is the kernel's output;
  // see the IMPORTANT note above re: oracle validation.
  //
  // Wolfram cross-check at this point:
  //   wolframscript -code 'N[MeijerG[{{1/3},{}}, {{1/2},{}},
  //     10000*Exp[I*(Pi/2 + 1/10)]], 30]'
  // → 0.000882043712222769957659541416702 - 0.001793582009581174856623389038653 i
  // The kernel's output (golden 19) is `method: braaksma-stokes,
  // sector: stokes`; the numerical disagreement vs wolframscript is
  // discussed in the egf bead's final report — the kernel's value
  // here is treated as a regression fixture, not an oracle match.
  {
    description:
      "κ=1 past upper Stokes line (arg z ≈ π/2 + 0.1, |z|=10000) — connection-formula assembly",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.333333333333333333", "0", PREC))],
      [],
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [],
      bigcomplexToValue(
        cfromStrings(
          "-998.3341664682815230681419841062202698992",
          "9950.041652780257660955619878038702948386",
          PREC,
        ),
      ),
    ),
  },

  // κ=1 past *lower* Stokes line, same large |z|. Conjugate of the
  // previous case. Verifies the lower-half-plane Stokes multiplier
  // path (`signOfImZ < 0 ⇒ sectorIndex = +1, multiplier = -i`).
  // Wolfram cross-check at this point:
  //   wolframscript -code 'N[MeijerG[{{1/3},{}}, {{1/2},{}},
  //     10000*Exp[-I*(Pi/2 + 1/10)]], 30]'
  // → 0.000882043712222769957659541416702 + 0.001793582009581174856623389038653 i
  // (Schwarz reflection of the upper-line case.)
  {
    description:
      "κ=1 past lower Stokes line (arg z ≈ -π/2 - 0.1, |z|=10000) — connection-formula assembly",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.333333333333333333", "0", PREC))],
      [],
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [],
      bigcomplexToValue(
        cfromStrings(
          "-998.3341664682815230681419841062202698992",
          "-9950.041652780257660955619878038702948386",
          PREC,
        ),
      ),
    ),
  },

  // ----- Stokes-multiplier stress-test goldens (κ=1, small |z|) -----
  //
  // These three goldens probe whether the κ=1 Stokes-multiplier table
  // in `stokes.ts` is correct at small |z| (5–10), where the exponential
  // E_{p,p}(z) ≈ O(1) and a wrong multiplier sign would produce
  // measurable error (unlike |z|=10000 where E is O(10^{-435})).
  //
  // All three RESULT IN `stokes-band-refused` because the band half-width
  // W = c_W · |z|^{-1/(2κ)} is capped at θ_S/2 = π/4 ≈ 0.785 rad, and
  // the angular offset from the Stokes line (0.05–0.1 rad) is smaller than
  // the cap. Specifically: at |z|=5 with offset=0.1, W_eff=π/4>0.1; at
  // |z|=10 with offset=0.05, W_eff=π/4>0.05. The band collapses below
  // 0.1 rad only at |z| > 2500, and below 0.05 rad only at |z| > 10000.
  //
  // Consequence: the multiplier-table correctness at E=O(1) CANNOT be
  // verified through the tool interface with the current band-refusal
  // guard. These goldens confirm the refusal fires correctly and serve
  // as regression fixtures for the band geometry; numerical cross-check
  // against Wolfram/mpmath is not possible from the tool output (the
  // kernel refuses before computing). The open question — whether the
  // `±i` entries in the stokes.ts table are correct for parameter-
  // dependent ν — remains to be addressed when a narrower band or an
  // explicit override mode is added (future bead scope).
  //
  // Oracle truth values (cross-validated against wolframscript and
  // mpmath at 40 dps; closed form: G^{1,1}_{1,1}([a];[];[b];[]) =
  // Γ(1+b-a)·z^b·(1+z)^{a-b-1}):
  //
  // Golden 21 (a=1/3, b=1/2, z=5·e^{i(π/2+0.1)}):
  //   G = 0.2021093726271575144388633746165519 - 0.2445562321057179630078276733352i
  //
  // Golden 22 (a=1/4, b=3/4, z=10·e^{i(π/2+0.05)}):
  //   G = 0.07628189908699271027808947210055596 - 0.137903543567382886501251688i
  //
  // Golden 23 (a=1/3, b=1/2, z=5·e^{-i(π/2+0.1)}, lower-half mirror of 21):
  //   G = 0.2021093726271575144388633746165519 + 0.2445562321057179630078276733352i

  // Golden 21: κ=1, G^{1,1}_{1,1}([1/3];[];[1/2];[]), upper half-plane,
  // just past the upper Stokes line, |z|=5. Expected: stokes-band-refused.
  {
    description:
      "κ=1 G^{1,1}_{1,1}([1/3];_;[1/2];_) z=5·e^{i(π/2+0.1)} — stokes-band-refused (small |z|, multiplier stress-test)",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.333333333333333333", "0", PREC))],
      [],
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [],
      bigcomplexToValue(
        cfromStrings(
          "-0.49916708323414076153407099205311013494957694008992",
          "4.9750208263901288304778099390193514741928811270754",
          PREC,
        ),
      ),
    ),
  },

  // Golden 22: κ=1, G^{1,1}_{1,1}([1/4];[];[3/4];[]), different ν (ν = -1/2),
  // upper half-plane, just past upper Stokes line, |z|=10. Expected: stokes-band-refused.
  {
    description:
      "κ=1 G^{1,1}_{1,1}([1/4];_;[3/4];_) z=10·e^{i(π/2+0.05)} — stokes-band-refused (small |z|, ν=-1/2 stress-test)",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.25", "0", PREC))],
      [],
      [bigcomplexToValue(cfromStrings("0.75", "0", PREC))],
      [],
      bigcomplexToValue(
        cfromStrings(
          "-0.49979169270678328794865000845490339382690565691861",
          "9.9875026039496624656287081115652109495898026202468",
          PREC,
        ),
      ),
    ),
  },

  // Golden 23: lower-half-plane mirror of golden 21. Tests signOfImZ=-1 path.
  // Expected: stokes-band-refused.
  {
    description:
      "κ=1 G^{1,1}_{1,1}([1/3];_;[1/2];_) z=5·e^{-i(π/2+0.1)} — stokes-band-refused (lower-half, sectorIndex=+1 stress-test)",
    input: gParams(
      [bigcomplexToValue(cfromStrings("0.333333333333333333", "0", PREC))],
      [],
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [],
      bigcomplexToValue(
        cfromStrings(
          "-0.49916708323414076153407099205311013494957694008992",
          "-4.9750208263901288304778099390193514741928811270754",
          PREC,
        ),
      ),
    ),
  },
];
