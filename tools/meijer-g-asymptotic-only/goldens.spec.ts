// =============================================================================
// Goldens — meijer-g-asymptotic-only
// =============================================================================
//
// Each entry exercises one v0.1 code-path branch:
//   * principal-sector success at modest precision (entire-function regime
//     where Slater Series 2 also converges; agreement is the load-bearing
//     witness);
//   * principal-sector success in the genuinely-asymptotic (p > q) regime;
//   * each refusal class (`coverage-gap`, `small-z`, `no-pole-residues`,
//     `input-error`).
//
// Post-worklog-125 (the egf retraction): the `stokes-band-refused` tag
// was removed from the kernel and from the wire schema. The κ-aware
// classifier emits only `principal` / `stokes` / `secondary` /
// `out-of-coverage`; inputs that previously refused with
// `stokes-band-refused` now run the algebraic per-pole path and emit
// `method: braaksma-stokes, sector: stokes` (the wire tag is retained
// for diagnostic continuity but the numerical value is the same
// algebraic series as the principal path).
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

  // κ=1 shape at arg z = π/2 (exactly on the boundary). Post-worklog-125
  // retraction (the egf Stokes-band refusal is gone), the boundary case
  // is admitted as principal — the classifier treats `|arg z| ≤ θ_S` as
  // principal — so this exercises the algebraic per-pole path at the
  // upper-half-plane edge. The numerical value matches the closed-form
  // identity `G^{1,1}_{1,1}([1/2];_;[0];_|z) = √π · (1+z)^{-1/2}` at
  // z=100i to working precision.
  {
    description: "z = 100i (arg z = π/2), κ=1 ⇒ principal (boundary admitted)",
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

  // Golden 17 — `degenerate-principal-sector` refusal (ADR-0039 §D6,
  // bead `atip`, 2026-05-16). Same shape as the deleted pre-`atip`
  // golden 17: κ=3 `G^{1,1}_{1,3}([1/3]; _ ; [1/2]; [2/3], [3/4] | 50)`
  // with `δ = m + n − (p+q)/2 = 1 + 1 − (1+3)/2 = 0`. The κ ≥ 3 inner
  // pFq is formally divergent (q > p−1 lower); with δ ≤ 0 the
  // Paris-Kaminski algebraic envelope `|arg z| < δπ` is empty and the
  // right-closing Slater residue series does not converge to G.
  //
  // Pre-`atip` the kernel routed this input through `assembleAlgebraic`
  // and emitted `+4.4×10⁻³` at 50 dps — wrong by ~125× AND wrong sign
  // vs the mpmath truth `−0.5549…` (math-research probe, worklog 125).
  // Post-`atip` the kernel refuses with the new tag rather than emit a
  // silent wrong value. The dominant-E Braaksma formula that would
  // lift the refusal is substantial new mathematics (distinct from the
  // multiplier-table assembly `ulze` retracted) and deferred. Callers
  // wanting a numerical answer in this regime should route to
  // `meijergContour`.
  {
    description:
      "κ=3 δ=0 G^{1,1}_{1,3}([1/3]; _ ; [1/2]; [2/3], [3/4] | z=2+0.1i) ⇒ degenerate-principal-sector (bead atip)",
    input: gParams(
      [
        bigcomplexToValue(
          cfromStrings(
            "0.333333333333333333333333333333333333333333333333333",
            "0",
            PREC,
          ),
        ),
      ],
      [],
      [bigcomplexToValue(cfromStrings("0.5", "0", PREC))],
      [
        bigcomplexToValue(
          cfromStrings(
            "0.666666666666666666666666666666666666666666666666667",
            "0",
            PREC,
          ),
        ),
        bigcomplexToValue(cfromStrings("0.75", "0", PREC)),
      ],
      bigcomplexToValue(cfromStrings("2", "0.1", PREC)),
    ),
  },

  // κ=1 small-|z| input just past the Stokes line at π/2 (arg z ≈
  // π/2 + 0.1, |z|=5). Post-worklog-125 retraction the Stokes-band
  // refusal is gone; this input now runs the algebraic per-pole path
  // and emits `method: braaksma-stokes, sector: stokes`. The
  // optimal-truncation finder will likely report a small per-pole
  // index (the asymptotic regime is marginal at |z|=5); the kernel's
  // value approximates `G^{1,1}_{1,1}([1/2];_;[0];_|z) = √π·(1+z)^{-1/2}`
  // to a few digits less than user precision (the error_estimate field
  // surfaces the remaining uncertainty).
  {
    description:
      "κ=1 small-|z| past upper Stokes line (arg z ≈ π/2 + 0.1, |z|=5) — algebraic series at the stokes-tagged boundary",
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

  // κ=1 past Stokes line, very large |z|=10000. Post-worklog-125
  // retraction, this exercises the algebraic per-pole path tagged
  // `method: braaksma-stokes, sector: stokes`. The shape is
  // G^{1,1}_{1,1}([1/3]; _ ; [1/2]; _ ) with `δ = 1`, so the empirical
  // result is `H_workbench = G` directly on the principal Riemann sheet
  // to working precision.
  //
  // Wolfram truth at this point:
  //   wolframscript -code 'N[MeijerG[{{1/3},{}}, {{1/2},{}},
  //     10000*Exp[I*(Pi/2 + 1/10)]], 30]'
  // → 0.000882043712222769957659541416702 - 0.001793582009581174856623389038653 i
  // The kernel's value agrees with this to 25+ dps (no compound-
  // asymptotic correction is needed; H equals G directly).
  {
    description:
      "κ=1 past upper Stokes line (arg z ≈ π/2 + 0.1, |z|=10000) — algebraic series, stokes-tagged",
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

  // κ=1 past *lower* Stokes line, same large |z|=10000. Schwarz
  // reflection of the previous case; the value should be the complex
  // conjugate of golden 19's value (the kernel produces the conjugate
  // by the same algebraic path — there is no Stokes-multiplier branch
  // any more).
  //   wolframscript -code 'N[MeijerG[{{1/3},{}}, {{1/2},{}},
  //     10000*Exp[-I*(Pi/2 + 1/10)]], 30]'
  // → 0.000882043712222769957659541416702 + 0.001793582009581174856623389038653 i
  {
    description:
      "κ=1 past lower Stokes line (arg z ≈ -π/2 - 0.1, |z|=10000) — Schwarz mirror of golden 19",
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

  // ----- Small-|z|, just-past-Stokes-line κ=1 goldens (oracle-checked) -----
  //
  // Three κ=1 goldens at small |z| (5–10) and angular offsets 0.05–0.1
  // rad past the Stokes line at π/2. Pre-worklog-125 these were
  // `stokes-band-refused` regression fixtures — the band machinery
  // capped W at θ_S/2 = π/4 ≈ 0.785 and engulfed the input. Post-
  // retraction the kernel runs the algebraic per-pole path; closed-form
  // truth is `G^{1,1}_{1,1}([a];_;[b];_|z) = Γ(1+b−a)·z^b·(1+z)^{a−b−1}`
  // and the kernel's value agrees with it to user precision (the
  // worklog-125 verification covered exactly this shape across multiple
  // (a, b, |z|, arg z) probes — the `δ = m + n − (p+q)/2 = 1 + 1 −
  // (1+1)/2 = 1 ≥ 1` regime where `H_workbench = G` directly).
  //
  // Oracle truth values (cross-validated against wolframscript and
  // mpmath at 40 dps; the kernel emits `method: braaksma-stokes,
  // sector: stokes` and the numerical value matches to working precision):
  //
  // Golden 21 (a=1/3, b=1/2, z=5·e^{i(π/2+0.1)}):
  //   G = 0.2021093726271575144388633746165519 - 0.2445562321057179630078276733352i
  //
  // Golden 22 (a=1/4, b=3/4, z=10·e^{i(π/2+0.05)}):
  //   G = 0.07628189908699271027808947210055596 - 0.137903543567382886501251688i
  //
  // Golden 23 (a=1/3, b=1/2, z=5·e^{-i(π/2+0.1)}, lower-half mirror of 21):
  //   G = 0.2021093726271575144388633746165519 + 0.2445562321057179630078276733352i

  // Golden 21: κ=1, G^{1,1}_{1,1}([1/3];_;[1/2];_), upper half-plane,
  // just past the upper Stokes line, |z|=5. Numerical via algebraic path.
  {
    description:
      "κ=1 G^{1,1}_{1,1}([1/3];_;[1/2];_) z=5·e^{i(π/2+0.1)} — algebraic at the stokes-tagged boundary, small |z|",
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

  // Golden 22: κ=1, G^{1,1}_{1,1}([1/4];_;[3/4];_), different ν,
  // upper half-plane, just past upper Stokes line, |z|=10.
  {
    description:
      "κ=1 G^{1,1}_{1,1}([1/4];_;[3/4];_) z=10·e^{i(π/2+0.05)} — algebraic at the stokes-tagged boundary, ν=−1/2",
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

  // Golden 23: lower-half-plane mirror of golden 21. The Schwarz
  // reflection of golden 21's value (signOfImZ = −1 path).
  {
    description:
      "κ=1 G^{1,1}_{1,1}([1/3];_;[1/2];_) z=5·e^{-i(π/2+0.1)} — Schwarz mirror of golden 21",
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
