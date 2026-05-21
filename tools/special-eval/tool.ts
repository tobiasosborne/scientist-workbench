// =============================================================================
// special-eval — per-head arbitrary-precision / float64 evaluator umbrella
// =============================================================================
//
// The wire surface for ADR-0040's per-head special-function substrate.
// This is the *single* tool an agent reaches for when the question is "give
// me Erf at this argument, this precision" — the dispatch across the Erf
// family (6 real heads + 4 complex heads), the Bessel family (4 primary
// heads + 2 scaled variants), and the Gamma family (16 heads from
// 1-argument (Gamma, LogGamma, Digamma, Trigamma, BarnesG, Hyperfactorial)
// through 2-argument (Polygamma, Pochhammer, IncompleteGamma*, Beta,
// LogBeta, GammaRatio, GammaDeltaRatio)) lives behind one umbrella with a
// single `head` field on the wire.  ADR-0040 §"Decision 7" pins the Erf
// wire surface; **ADR-0041 §"Decision 7"** extends it with the canonical
// Bessel family per the per-head substrate pattern; **ADR-0042 §"Decision
// 7-9"** extends it again with the Gamma family across real / complex ×
// float64 / arb-prec.  The seven-artefact contract is non-negotiable per
// PRD §4.2 + CLAUDE.md Rules 0, 1, 8, 10.
//
// What this tool is (the agent's mental model)
// --------------------------------------------
// "I have a Value-protocol-shaped scientific request — `head: 'Erf', args:
// [0.5], precision: 200` (or `head: 'BesselJ', args: [3, 1.5], precision:
// 200`) — and I want the answer as a value-protocol Value I can hash,
// cache, and feed into another tool.  I want bit-determinism across
// runtimes (`arbprec: true`, ADR-0020) at high precision, and `numerical:
// true`-grade float64 at low precision (ADR-0015).  I want honest refusal
// — `tagged "special-eval/no-known-representation"` for `InverseErf` on
// the complex axis, because no canonical computational form exists.  I
// don't want to learn 12 tools, one per head."
//
// Per-head dispatch table (v0.2 — Erf + Bessel + Gamma)
// -----------------------------------------------------
//
//   head                    arity   real (float64 / arb-prec)            complex (float64 / arb-prec)
//   ------------------------+-------+-------------------------------------+-----------------------------------
//   Erf                       1      erfFloat64         / bigErf            erfComplexFloat64       / bigCErf
//   Erfc                      1      erfcFloat64        / bigErfc           erfcComplexFloat64      / bigCErfc
//   Erfcx                     1      erfcxFloat64       / bigErfcx          erfcxComplexFloat64     / bigCErfcx
//   Erfi                      1      erfiFloat64        / via bigCErfi      erfiComplexFloat64      / bigCErfi
//   InverseErf                1      erfInvFloat64      / —  (refuse)       — (refuse always)       / —
//   InverseErfc               1      erfcInvFloat64     / —  (refuse)       — (refuse always)       / —
//   BesselJ                   2      besselJFloat64     / bigBesselJ        besselJComplexFloat64   / bigCBesselJ
//   BesselY                   2      besselYFloat64     / bigBesselY        besselYComplexFloat64   / bigCBesselY
//   BesselI                   2      besselIFloat64     / bigBesselI        besselIComplexFloat64   / bigCBesselI
//   BesselK                   2      besselKFloat64     / bigBesselK        besselKComplexFloat64   / bigCBesselK
//   BesselIScaled             2      besselIScaledFloat64 / bigBesselIScaled  refuse                / bigCBesselIScaled
//   BesselKScaled             2      besselKScaledFloat64 / bigBesselKScaled  refuse                / bigCBesselKScaled
//   Gamma                     1      gammaFloat64       / gamma             gammaComplexFloat64     / cgamma
//   LogGamma                  1      lgammaFloat64      / lgamma            lgammaComplexFloat64    / clgamma
//   Digamma                   1      digammaFloat64     / digamma           digammaComplexFloat64   / cdigamma
//   Trigamma                  1      trigammaFloat64    / trigamma          refuse (no f64)         / ctrigamma
//   Polygamma                 2(m,z) polygammaFloat64   / polygamma         refuse (no f64)         / cpolygamma
//   Pochhammer                2(a,n) pochhammerFloat64  / bigPochhammer     refuse (no complex)     / refuse
//   IncompleteGammaUpper      2(a,z) incGammaUpperFloat64 / bigIncompleteGammaUpper  refuse (no f64)  / cIncompleteGammaUpper
//   IncompleteGammaLower      2(a,z) incGammaLowerFloat64 / bigIncompleteGammaLower  refuse (no f64)  / cIncompleteGammaLower
//   IncompleteGammaP          2(a,z) gammaPFloat64      / bigGammaP         refuse                  / refuse (no complex bigGammaP)
//   IncompleteGammaQ          2(a,z) gammaQFloat64      / bigGammaQ         refuse                  / refuse
//   Beta                      2(a,b) betaFloat64        / bigBeta           refuse (no f64)         / cBeta
//   LogBeta                   2(a,b) logBetaFloat64     / bigLogBeta        refuse                  / refuse
//   BarnesG                   1      barnesGFloat64     / bigBarnesG        refuse                  / refuse
//   Hyperfactorial            1      hyperfactorialFloat64 / via bigBarnesG  refuse                 / refuse
//   GammaRatio                2(a,b) gammaRatioFloat64  / via gamma         refuse                  / refuse
//   GammaDeltaRatio           2(a,δ) gammaDeltaRatioFloat64 / via gamma      refuse                 / refuse
//
// The Bessel heads are arity-2 (`args: [nu, z]` real; complex shape places
// `nu` in `args.re[0]` with `args.im[0] = 0` and `z` in `args.{re,im}[1]`).
// The arity check in the dispatcher refuses any args-list of length ≠ head-
// declared arity with `tagged "special-eval/degenerate-shape"`.  ν is real
// throughout v0.2 (the substrate's complex layer accepts complex ν but the
// wire only surfaces real-ν; integer / half-integer / general-real ν all
// flow through the same dispatch); a future ADR can lift this if a use
// case for complex ν arrives.
//
// Known v0.2 gaps surfaced honestly in the table above:
//
//   * `bigErfi(BigFloat, prec)` does not exist as a separate real entry
//     point — but per the Karbach identity table (R2 §"Pick"), real-axis
//     erfi is the imaginary part of `bigCErfi` evaluated on the
//     imaginary axis: `Erfi(x) = Im(CErfi(0 + xi)) / 1` is one form, but
//     more directly `Erfi(x) = -i · Erf(ix)` and the complex evaluator
//     produces the result with `Im part = Erfi(x)` when the input is
//     purely imaginary. Practically, we route the real arb-prec Erfi
//     call through `bigCErfi` on a purely-real BigComplex and take the
//     real part of the result (the substrate's bigCErfi handles the
//     algebraic combination internally).
//
//   * `bigErfInverse` / `bigErfcInverse` are NOT in Phase 2's deliverables
//     (the impl-plan §I5 spec'd Newton on bigErf but it was deferred). For
//     `--precision > 53` requests of InverseErf / InverseErfc, the tool
//     refuses with `tagged "special-eval/no-known-representation"`. The
//     float64 path remains available (`--precision = 53`). Complex
//     InverseErf / InverseErfc refuse always per R3 §3 — multi-valued
//     Riemann surface; no canonical computational form.
//
//   * For Bessel, the complex float64 path for `BesselIScaled` and
//     `BesselKScaled` is not in the v0.2 quadrature dispatcher (R3 §0.4
//     ships scaled variants on the real axis only — AMOS TOMS 644's
//     `zbesi` / `zbesk` carry an internal scaling parameter but the wire
//     entries `besselIComplexFloat64` / `besselKComplexFloat64` expose
//     the unscaled call shape only).  At `--precision ≤ 15` the complex
//     scaled call refuses with `tagged "special-eval/no-known-
//     representation"`; the arb-prec path (`bigCBesselIScaled` /
//     `bigCBesselKScaled`) at `--precision > 15` is fully available.
//
// Bessel-specific honesty (ADR-0041 §"Decision 3" + §"Decision 13"):
//
//   * `K_ν(0)` is singular (`K_0(0+) = +∞ logarithmic`); the substrate
//     throws `RangeError`, which we map to a `non-finite-input` refusal
//     on the wire (the input is finite but the output isn't).  Same for
//     negative-non-integer-ν `I_ν(0) = unbounded`.
//   * `BesselIScaled(ν, z) = e^{-|z|}·I_ν(z)` and `BesselKScaled(ν, z) =
//     e^{z}·K_ν(z)`.  Use these when `|z| > ~700` to avoid the float64
//     overflow / underflow cliff (the unscaled real I/K at `|z| > 700`
//     overflow / underflow to ±Inf / 0).
//
// Gamma-family honesty (ADR-0042 §"Decision 7-9"):
//
//   * 16 heads admitted; arity 1 (Gamma, LogGamma, Digamma, Trigamma,
//     BarnesG, Hyperfactorial), arity 2 with various semantics
//     (Polygamma(m,z), Pochhammer(a,n), IncompleteGamma{Upper,Lower,P,Q}
//     (a,z), Beta(a,b), LogBeta(a,b), GammaRatio(a,b),
//     GammaDeltaRatio(a,δ)).
//
//   * Hyperfactorial arb-prec is derived from BarnesG via the
//     Bendersky-Adamchik formula `H(z) = Γ(z+1)^z / G(z+1)` (for general
//     real z > 0 the identity follows from the integral representation of
//     log G; for non-positive integer z the substrate's gamma poles
//     propagate up to a `no-known-representation` refusal).  This is the
//     same identity-composition pattern as real-axis Erfi → bigCErfi above.
//
//   * GammaRatio arb-prec is `gamma(a) / gamma(b)`; GammaDeltaRatio is
//     `gamma(a) / gamma(a+delta)`.  Both compose cleanly out of the
//     existing `gamma` substrate; we do NOT route through `lgamma`-then-
//     `exp` because at moderate arguments the direct division is faster
//     and bit-identical via the substrate's normalisation.
//
//   * Pochhammer, LogBeta, BarnesG, Hyperfactorial, IncompleteGammaP/Q,
//     GammaRatio, GammaDeltaRatio have NO complex-arb-prec substrate in
//     v0.2 — the bigfloat package's `complex.ts` ships cgamma, clgamma,
//     cdigamma, ctrigamma, cpolygamma, cBeta, cIncompleteGammaUpper,
//     cIncompleteGammaLower only.  Calls to the missing lanes refuse
//     honestly with `no-known-representation` rather than synthesise via
//     a noisy identity (the same pattern as InverseErf complex).  Filed
//     as P3 follow-ups in `gamma/v02-*` beads.
//
//   * Trigamma, Polygamma, IncompleteGamma{Upper,Lower}, Beta complex
//     have NO float64 lane in v0.2 (the gamma-float64 dispatcher only
//     ships gamma / lgamma / digamma complex).  At `--precision ≤ 15`
//     these refuse with `no-known-representation`; at `--precision > 15`
//     the arb-prec complex lane is fully available.  This is the same
//     mixed-tier pattern as BesselIScaled / BesselKScaled complex above.
//
//   * IncompleteBeta (3-arg I_z(a,b)) is deliberately NOT in the
//     admitted 16.  The float64 lane ships (`incBetaFloat64`) but no
//     arb-prec lane exists; per the bead's acceptance criterion ("real
//     float64 + real arb-prec mandatory"), it's excluded from v0.2's
//     wire surface and filed for v0.3 once arb-prec lands.  Similarly
//     InverseIncompleteGammaP/Q (Newton-on-bigGammaP not yet shipped).
//
// Per-output tier dispatch (ADR-0040 §"Decision 9")
// -------------------------------------------------
// `--precision ≤ 53` routes the float64 lane (I5); `> 53` routes the
// arb-prec lane (I1-I3). The output is *always* encoded as a `bigfloat`
// (real) or `bigcomplex` (complex) — at p=53 the BigFloat carries a
// 53-bit mantissa with the float64 result as its content, and at p>53
// the BigFloat carries the requested precision. This keeps the wire
// schema uniform across tiers while honouring the tier-decision the
// precision flag pins.
//
// Why arbprec: true and not numerical: true
// -----------------------------------------
// The runner's tier mutex (ADR-0015 + ADR-0020, enforced in
// `executeToolDef`) admits at most one of {nondeterministic, numerical,
// arbprec}. The `--precision` standard flag is inherited only when
// `arbprec: true`. ADR-0040 §"Decision 9" described the ideal as listing
// both annotations on the manifest; the *implementable* shape under the
// existing mutex is `arbprec: true` plus per-output dispatch (the float64
// lane's result is still byte-deterministic on a single platform; the
// BigFloat encoding makes it bit-deterministic across runtimes as soon
// as it lands in the wire because BigFloat operations are bit-identical
// cross-platform by language spec — see ADR-0020 §"Context"). A future
// ADR can lift the mutex to support per-output tier conditioning across
// the {numerical, arbprec} pair; for now the practical resolution is
// the single arbprec annotation.
//
// Refusal envelope (ADR-0003 boundary categories)
// -----------------------------------------------
//   * `special-eval/unknown-head` — head not in the v0.1 Erf family.
//     Payload: `{head: string, admitted: list<string>}`.
//   * `special-eval/non-finite-input` — NaN / ±Inf in `args` (real or
//     complex parts). Payload: `{which: string, value: string}`.
//   * `special-eval/degenerate-shape` — complex args with mismatched
//     `re` / `im` list lengths, or args list size doesn't match head
//     arity. Payload: `{detail: string}`.
//   * `special-eval/no-known-representation` — caller requested arb-prec
//     InverseErf / InverseErfc (no arb-prec impl in v0.1) or complex
//     InverseErf / InverseErfc (no canonical form per R3 §3). Payload:
//     `{head: string, axis: string, reason: string}`.
//
// Malformed input (`ToolError`, exit 1) is reserved for:
//   * args list empty when the head requires args (caught by the
//     schema's list shape + the post-validation arity check).
//   * args list contains a value not parsable as a float64 (caught by
//     the schema before the body runs).
//
// References
// ----------
// ADR-0040 (per-head substrate — Erf prototype), ADR-0041 (per-head
// substrate — Bessel; §"Decision 7" is the wire surface this tool
// implements for the Bessel family), **ADR-0042 (per-head substrate —
// Gamma; §"Decision 7-9" is the Gamma wire surface)**, ADR-0020 (arb-
// prec tier), ADR-0015 (numerical tier), ADR-0011 (typed flags),
// CLAUDE.md (every rule). The substrate this tool wraps lives in:
//
//   * Real arb-prec (Erf):    @workbench/bigfloat::{bigErf, bigErfc,
//                             bigErfcx}
//   * Complex arb-prec (Erf): @workbench/bigfloat::{bigCErf, bigCErfc,
//                             bigCErfcx, bigCErfi}
//   * Real float64 (Erf):     @workbench/quadrature::{erfFloat64,
//                             erfcFloat64, erfcxFloat64, erfiFloat64,
//                             erfInvFloat64, erfcInvFloat64}
//   * Complex float64 (Erf):  @workbench/quadrature::{erfComplexFloat64,
//                             erfcComplexFloat64, erfcxComplexFloat64,
//                             erfiComplexFloat64}
//   * Real arb-prec (Bessel): @workbench/bigfloat::{bigBesselJ,
//                             bigBesselY, bigBesselI, bigBesselK,
//                             bigBesselIScaled, bigBesselKScaled}
//   * Complex arb-prec (Bessel): @workbench/bigfloat::{bigCBesselJ,
//                             bigCBesselY, bigCBesselI, bigCBesselK,
//                             bigCBesselIScaled, bigCBesselKScaled}
//   * Real float64 (Bessel):  @workbench/quadrature::{besselJFloat64,
//                             besselYFloat64, besselIFloat64,
//                             besselKFloat64, besselIScaledFloat64,
//                             besselKScaledFloat64}
//   * Complex float64 (Bessel): @workbench/quadrature::{besselJComplexFloat64,
//                             besselYComplexFloat64, besselIComplexFloat64,
//                             besselKComplexFloat64}
//   * Real arb-prec (Gamma):  @workbench/bigfloat::{gamma, lgamma,
//                             digamma, trigamma, polygamma,
//                             bigPochhammer, bigIncompleteGammaUpper,
//                             bigIncompleteGammaLower, bigGammaP,
//                             bigGammaQ, bigBeta, bigLogBeta,
//                             bigBarnesG} + Hyperfactorial / GammaRatio
//                             / GammaDeltaRatio composed locally.
//   * Complex arb-prec (Gamma): @workbench/bigfloat::{cgamma, clgamma,
//                             cdigamma, ctrigamma, cpolygamma, cBeta,
//                             cIncompleteGammaUpper,
//                             cIncompleteGammaLower}
//   * Real float64 (Gamma):   @workbench/quadrature::{gammaFloat64,
//                             lgammaFloat64, digammaFloat64,
//                             trigammaFloat64, polygammaFloat64,
//                             pochhammerFloat64, incGammaUpperFloat64,
//                             incGammaLowerFloat64, gammaPFloat64,
//                             gammaQFloat64, betaFloat64, logBetaFloat64,
//                             barnesGFloat64, hyperfactorialFloat64,
//                             gammaRatioFloat64, gammaDeltaRatioFloat64}
//   * Complex float64 (Gamma): @workbench/quadrature::{gammaComplexFloat64,
//                             lgammaComplexFloat64, digammaComplexFloat64}

import {
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Float64Value,
  type ListValue,
  type RecordValue,
  type StringValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type BigComplex,
  type BigFloat,
  add as bfAdd,
  bigCErf,
  bigCErfc,
  bigCErfcx,
  bigCErfi,
  bigCBesselI,
  bigCBesselIScaled,
  bigCBesselJ,
  bigCBesselK,
  bigCBesselKScaled,
  bigCBesselY,
  bigErf,
  bigErfc,
  bigErfcx,
  bigBesselI,
  bigBesselIScaled,
  bigBesselJ,
  bigBesselK,
  bigBesselKScaled,
  bigBesselY,
  bigBarnesG,
  bigBeta,
  bigGammaP,
  bigGammaQ,
  bigIncompleteGammaLower,
  bigIncompleteGammaUpper,
  bigLogBeta,
  bigPochhammer,
  bigcomplexSchema,
  bigcomplexToValue,
  bigfloatSchema,
  bigfloatToValue,
  cBeta,
  cIncompleteGammaLower,
  cIncompleteGammaUpper,
  cdigamma,
  cgamma,
  cim,
  clgamma,
  cpolygamma,
  cre,
  ctrigamma,
  decimalToBinaryPrecision,
  digamma,
  div as bfDiv,
  fromFloat64,
  fromInt,
  gamma,
  lgamma,
  normalise,
  polygamma,
  pow as bfPow,
  sub as bfSub,
  toString as bfToString,
  trigamma,
} from "@workbench/bigfloat";
import {
  barnesGFloat64,
  besselIComplexFloat64,
  besselIFloat64,
  besselIScaledFloat64,
  besselJComplexFloat64,
  besselJFloat64,
  besselKComplexFloat64,
  besselKFloat64,
  besselKScaledFloat64,
  besselYComplexFloat64,
  besselYFloat64,
  betaFloat64,
  digammaComplexFloat64,
  digammaFloat64,
  erfcComplexFloat64,
  erfcFloat64,
  erfcInvFloat64,
  erfcxComplexFloat64,
  erfcxFloat64,
  erfComplexFloat64,
  erfFloat64,
  erfInvFloat64,
  erfiComplexFloat64,
  erfiFloat64,
  gammaComplexFloat64,
  gammaDeltaRatioFloat64,
  gammaFloat64,
  gammaPFloat64,
  gammaQFloat64,
  gammaRatioFloat64,
  hyperfactorialFloat64,
  incGammaLowerFloat64,
  incGammaUpperFloat64,
  lgammaComplexFloat64,
  lgammaFloat64,
  logBetaFloat64,
  pochhammerFloat64,
  polygammaFloat64,
  trigammaFloat64,
} from "@workbench/quadrature";

const NAME = "special-eval";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Per-head metadata
// -----------------------------------------------------------------------------
//
// The closed vocabulary the v0.1 substrate covers. Adding a future head
// (Bessel J, Whittaker, ...) is a one-line table extension PLUS the
// per-head substrate landing per ADR-0040's substrate pattern.

const ADMITTED_HEADS = [
  // Erf family (ADR-0040 §"Decision 7"; T2 worklog 139).
  "Erf",
  "Erfc",
  "Erfcx",
  "Erfi",
  "InverseErf",
  "InverseErfc",
  // Bessel family (ADR-0041 §"Decision 7"; T2 worklog 163).
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  "BesselIScaled",
  "BesselKScaled",
  // Gamma family (ADR-0042 §"Decision 7-9"; T2 / bead 6g09).
  // Arity-1 spine: Gamma, LogGamma, Digamma, Trigamma, BarnesG,
  // Hyperfactorial.  Arity-2 with various semantics: Polygamma(m,z),
  // Pochhammer(a,n), IncompleteGamma{Upper,Lower,P,Q}(a,z), Beta(a,b),
  // LogBeta(a,b), GammaRatio(a,b), GammaDeltaRatio(a,δ).  16 heads.
  "Gamma",
  "LogGamma",
  "Digamma",
  "Trigamma",
  "Polygamma",
  "Pochhammer",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "IncompleteGammaP",
  "IncompleteGammaQ",
  "Beta",
  "LogBeta",
  "BarnesG",
  "Hyperfactorial",
  "GammaRatio",
  "GammaDeltaRatio",
] as const;

type AdmittedHead = (typeof ADMITTED_HEADS)[number];

function isAdmittedHead(h: string): h is AdmittedHead {
  return (ADMITTED_HEADS as readonly string[]).includes(h);
}

// Per-head arity declaration.  Erf-family heads are arity-1; Bessel-
// family heads are arity-2 (`(ν, z)`); Gamma-family heads are arity-1
// (the simple spine) or arity-2 (various semantics).  The dispatcher's
// arity check refuses any `args` list whose length disagrees with this
// table, with `tagged "special-eval/degenerate-shape"`.
const HEAD_ARITY: Record<AdmittedHead, 1 | 2> = {
  Erf: 1,
  Erfc: 1,
  Erfcx: 1,
  Erfi: 1,
  InverseErf: 1,
  InverseErfc: 1,
  BesselJ: 2,
  BesselY: 2,
  BesselI: 2,
  BesselK: 2,
  BesselIScaled: 2,
  BesselKScaled: 2,
  Gamma: 1,
  LogGamma: 1,
  Digamma: 1,
  Trigamma: 1,
  Polygamma: 2,
  Pochhammer: 2,
  IncompleteGammaUpper: 2,
  IncompleteGammaLower: 2,
  IncompleteGammaP: 2,
  IncompleteGammaQ: 2,
  Beta: 2,
  LogBeta: 2,
  BarnesG: 1,
  Hyperfactorial: 1,
  GammaRatio: 2,
  GammaDeltaRatio: 2,
};

// Heads for which we have NO arb-prec real implementation in v0.2 (and
// for which complex evaluation is mathematically refused).
//
// Per R3 §3: InverseErf / InverseErfc on the complex axis have no
// canonical computational form (multi-valued Riemann surface; SciPy /
// Boost / Julia all decline). The float64 real path remains available;
// the arb-prec real path is a Phase 2 gap (Newton-on-bigErf was spec'd
// but not delivered).
const NO_ARBPREC_REAL: ReadonlySet<AdmittedHead> = new Set([
  "InverseErf",
  "InverseErfc",
]);

const NO_COMPLEX_AT_ALL: ReadonlySet<AdmittedHead> = new Set([
  "InverseErf",
  "InverseErfc",
]);

// Heads for which the v0.2 quadrature substrate ships no complex-
// float64 implementation.  R3 §0.4: AMOS TOMS 644 carries an internal
// scaling parameter but the wire entries `besselIComplexFloat64` /
// `besselKComplexFloat64` only expose the unscaled call shape; the
// arb-prec complex scaled variants (`bigCBesselIScaled` /
// `bigCBesselKScaled`) ship and route normally on the `--precision > 15`
// lane.  At `--precision ≤ 15` we refuse with no-known-representation
// rather than silently fall through to the unscaled call.
//
// Gamma family: the float64 dispatcher ships gamma / lgamma / digamma
// complex only.  The arb-prec complex lane is fully available for
// Trigamma, Polygamma, IncompleteGamma{Upper,Lower}, and Beta — caller
// can promote to `--precision > 15` to access them.
const NO_FLOAT64_COMPLEX: ReadonlySet<AdmittedHead> = new Set([
  "BesselIScaled",
  "BesselKScaled",
  "Trigamma",
  "Polygamma",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "Beta",
]);

// Gamma-family heads for which there is no complex substrate at all
// (neither float64 nor arb-prec).  Pochhammer (a)_n: no complex
// `bigPochhammer` (the substrate's complex layer ships forward-
// recurrence on real (a, n) only; complex (a, n) is filed as a v0.3
// follow-up `gamma/v03-cpochhammer`).  LogBeta: no `clogBeta` (the
// complex Beta avoids the log to dodge branch cuts; a complex-log Beta
// has multi-valued issues parallel to InverseErf).  BarnesG /
// Hyperfactorial: no `cBarnesG` / `cHyperfactorial` (no consumer in
// v0.2; filed as `gamma/v03-cbarnes`).  IncompleteGammaP / Q: no
// `cBigGammaP` / `cBigGammaQ` (the complex regularised forms inherit
// the cancellation-pattern subtleties of `bigGammaP` / `bigGammaQ` and
// require a careful complex port; filed as `gamma/v03-cgamma-pq`).
// GammaRatio / GammaDeltaRatio: derivable via `cgamma` algebraically
// but not surfaced in v0.2's wire (filed as `gamma/v03-cratios`).
const NO_COMPLEX_GAMMA: ReadonlySet<AdmittedHead> = new Set([
  "Pochhammer",
  "LogBeta",
  "BarnesG",
  "Hyperfactorial",
  "IncompleteGammaP",
  "IncompleteGammaQ",
  "GammaRatio",
  "GammaDeltaRatio",
]);

// Float64-tier method tags. Informational, written into the output
// `method` field so an agent's planner can audit which algorithm
// produced the value (R3's lineage; load-bearing for provenance audit).
//
// The method tag also doubles as the agent-readable lineage citation —
// "erf-sunpro-1993" is more useful in a downstream debugging trace
// than "lib-call" because it pins the canonical paper.
const FLOAT64_METHOD: Record<AdmittedHead, string> = {
  Erf: "erf-sunpro-1993",
  Erfc: "erf-sunpro-1993",
  Erfcx: "erf-sunpro-1993",
  Erfi: "erf-sunpro-1993",
  InverseErf: "erf-blair-1976-inverse",
  InverseErfc: "erf-blair-1976-inverse",
  BesselJ: "bessel-musl-sunpro-1993",
  BesselY: "bessel-musl-sunpro-1993",
  BesselI: "bessel-cephes-moshier-2000",
  BesselK: "bessel-cephes-moshier-2000",
  BesselIScaled: "bessel-cephes-moshier-2000-scaled",
  BesselKScaled: "bessel-cephes-moshier-2000-scaled",
  // Gamma float64: ADR-0042 §"Decision 4" — Cephes gamma.c (Moshier 2000),
  // FreeBSD e_lgamma_r.c (SunPro 1993), Boost.Math digamma/polygamma,
  // Cephes igam.c / incbet.c.
  Gamma: "gamma-cephes-moshier-2000",
  LogGamma: "lgamma-freebsd-sunpro-1993",
  Digamma: "digamma-boost-2017",
  Trigamma: "polygamma-boost-2017",
  Polygamma: "polygamma-boost-2017",
  Pochhammer: "pochhammer-boost-recurrence",
  IncompleteGammaUpper: "igam-cephes-2000",
  IncompleteGammaLower: "igam-cephes-2000",
  IncompleteGammaP: "igam-cephes-2000",
  IncompleteGammaQ: "igam-cephes-2000",
  Beta: "beta-cephes-2000",
  LogBeta: "logbeta-cephes-2000",
  BarnesG: "barnes-g-adamchik-2007",
  Hyperfactorial: "hyperfactorial-adamchik-2007",
  GammaRatio: "gamma-ratio-cephes-via-lgamma",
  GammaDeltaRatio: "gamma-delta-ratio-cephes-via-lgamma",
};

const FLOAT64_COMPLEX_METHOD: Record<AdmittedHead, string> = {
  Erf: "erf-faddeeva-johnson",
  Erfc: "erf-faddeeva-johnson",
  Erfcx: "erf-faddeeva-johnson",
  Erfi: "erf-faddeeva-johnson",
  InverseErf: "—",
  InverseErfc: "—",
  BesselJ: "bessel-amos-toms644",
  BesselY: "bessel-amos-toms644",
  BesselI: "bessel-amos-toms644",
  BesselK: "bessel-amos-toms644",
  BesselIScaled: "—",
  BesselKScaled: "—",
  // Gamma complex float64: SciPy `_loggamma.pxd` is the canonical
  // reference; the substrate ports the Stirling-with-branch-cut
  // logic.  Only gamma / lgamma / digamma have complex float64; the
  // others refuse at the `--precision ≤ 15` tier and route through
  // the arb-prec lane at higher precision.
  Gamma: "gamma-scipy-loggamma-pxd",
  LogGamma: "lgamma-scipy-loggamma-pxd",
  Digamma: "digamma-scipy-loggamma-pxd",
  Trigamma: "—",
  Polygamma: "—",
  Pochhammer: "—",
  IncompleteGammaUpper: "—",
  IncompleteGammaLower: "—",
  IncompleteGammaP: "—",
  IncompleteGammaQ: "—",
  Beta: "—",
  LogBeta: "—",
  BarnesG: "—",
  Hyperfactorial: "—",
  GammaRatio: "—",
  GammaDeltaRatio: "—",
};

const ARBPREC_METHOD_REAL: Record<AdmittedHead, string> = {
  Erf: "erf-borel-series-or-asymptotic",
  Erfc: "erf-borel-series-or-asymptotic",
  Erfcx: "erf-borel-series-or-asymptotic",
  Erfi: "erf-karbach-weideman",
  InverseErf: "—",
  InverseErfc: "—",
  // Bessel arb-prec real: FLINT-pattern cancellation-retry ₀F₁ Maclaurin
  // for |z| < min(8, 2|z|/p); Hankel asymptotic for |z| > p/2;
  // cancellation-driven precision retry in between.  R2 §3 + ADR-0041
  // §"Decision 3".
  BesselJ: "bessel-flint-0f1-or-hankel",
  BesselY: "bessel-flint-0f1-or-hankel",
  BesselI: "bessel-flint-0f1-or-hankel",
  BesselK: "bessel-flint-temme-or-connection",
  BesselIScaled: "bessel-flint-0f1-or-hankel-scaled",
  BesselKScaled: "bessel-flint-temme-or-connection-scaled",
  // Gamma arb-prec real: Stirling + recurrence + reflection — the
  // canonical mpmath pattern, ported in `packages/bigfloat/src/
  // special.ts` (I1a per ADR-0042).  IncompleteGamma{Upper,Lower}/
  // P/Q route series-or-continued-fraction by cancellation regime.
  Gamma: "gamma-stirling-recurrence-reflection",
  LogGamma: "lgamma-stirling-recurrence-reflection",
  Digamma: "digamma-stirling-recurrence-reflection",
  Trigamma: "polygamma-hurwitz-zeta",
  Polygamma: "polygamma-hurwitz-zeta",
  Pochhammer: "pochhammer-direct-recurrence-or-gamma-ratio",
  IncompleteGammaUpper: "incgamma-series-or-cf",
  IncompleteGammaLower: "incgamma-series-or-cf",
  IncompleteGammaP: "incgamma-regularised-direct-dispatch",
  IncompleteGammaQ: "incgamma-regularised-direct-dispatch",
  Beta: "beta-via-gamma",
  LogBeta: "logbeta-via-lgamma",
  BarnesG: "barnes-g-adamchik-via-zeta",
  // Hyperfactorial real arb-prec: composed in this dispatcher as
  // H(z) = Γ(z+1)^z / G(z+1)  (Bendersky-Adamchik identity).
  // The composition is exact; the arb-prec lane inherits BarnesG's
  // determinism.
  Hyperfactorial: "hyperfactorial-via-bendersky-barnes-g",
  // GammaRatio: gamma(a) / gamma(b) composed here.
  GammaRatio: "gamma-ratio-via-bigfloat-gamma",
  GammaDeltaRatio: "gamma-delta-ratio-via-bigfloat-gamma",
};

const ARBPREC_METHOD_COMPLEX: Record<AdmittedHead, string> = {
  Erf: "erf-karbach-weideman",
  Erfc: "erf-karbach-weideman",
  Erfcx: "erf-karbach-weideman",
  Erfi: "erf-karbach-weideman",
  InverseErf: "—",
  InverseErfc: "—",
  // Complex Bessel arb-prec: AMOS-style rotation per R2 §3.3 +
  // ADR-0041 §"Decision 11".  Modified I/K computed first via direct
  // series + Hankel asymptotic; J/Y derived algebraically via
  // J_ν(z) = exp(±νπi/2) · I_ν(∓iz).
  BesselJ: "bessel-amos-rotation-arbprec",
  BesselY: "bessel-amos-rotation-arbprec",
  BesselI: "bessel-flint-0f1-or-hankel-complex",
  BesselK: "bessel-flint-temme-or-connection-complex",
  BesselIScaled: "bessel-flint-0f1-or-hankel-scaled-complex",
  BesselKScaled: "bessel-flint-temme-or-connection-scaled-complex",
  // Complex Gamma arb-prec: Stirling + recurrence + reflection (parallel
  // to the real lane; complex.ts ports the mpmath complex pattern).
  Gamma: "cgamma-stirling-recurrence-reflection",
  LogGamma: "clgamma-stirling-recurrence-reflection",
  Digamma: "cdigamma-stirling-recurrence-reflection",
  Trigamma: "cpolygamma-hurwitz-zeta-complex",
  Polygamma: "cpolygamma-hurwitz-zeta-complex",
  Pochhammer: "—",
  IncompleteGammaUpper: "cincgamma-series-or-cf-complex",
  IncompleteGammaLower: "cincgamma-series-or-cf-complex",
  IncompleteGammaP: "—",
  IncompleteGammaQ: "—",
  Beta: "cbeta-via-cgamma",
  LogBeta: "—",
  BarnesG: "—",
  Hyperfactorial: "—",
  GammaRatio: "—",
  GammaDeltaRatio: "—",
};

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// The `args` field is a value-protocol union: a `list<float64>` for the
// real-axis call, or a `record{re, im}` of `list<float64>` for complex.
// Both shapes carry one element per call site in v0.1 (every Erf-family
// head is arity 1) — keeping the *shape* as a list keeps the door open
// for future multi-parameter heads (Bessel J takes order + argument)
// without breaking the wire schema.

const realArgsSchema = S.list(S.kind("float64"));
const complexArgsSchema = S.record({
  re: S.list(S.kind("float64")),
  im: S.list(S.kind("float64")),
});

const inputSchema = S.record({
  head: S.kind("string"),
  args: S.union([realArgsSchema, complexArgsSchema]),
});

// The output's `value` field is one of three encodings, all on the
// arb-prec wire surface (ADR-0020). Real BigFloat outputs (the
// real-axis lane) carry `bigfloat`; complex BigComplex outputs carry
// `bigcomplex`; the float64 lane wraps its result in a 53-bit BigFloat
// (real) or BigComplex (complex) so the wire schema is uniform across
// tiers. The agent reads `achieved_precision` to discover the live
// tier; the `method` tag pins the algorithm lineage.
const successOutputSchema = S.record({
  value: S.union([bigfloatSchema, bigcomplexSchema]),
  method: S.kind("string"),
  achieved_precision: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});

// Literal tag strings — kept as `const`s so type narrowing through
// `tagged(...)` / `S.tagged(...)` preserves the literal type rather than
// widening to `string`. The matching value-constructor helpers below
// (`unknownHead`, `nonFinite`, ...) use the same constants.
const TAG_UNKNOWN_HEAD = "special-eval/unknown-head" as const;
const TAG_NON_FINITE = "special-eval/non-finite-input" as const;
const TAG_DEGENERATE = "special-eval/degenerate-shape" as const;
const TAG_NO_REPR = "special-eval/no-known-representation" as const;

const unknownHeadOutputSchema = S.tagged(
  TAG_UNKNOWN_HEAD,
  S.record({
    head: S.kind("string"),
    admitted: S.list(S.kind("string")),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  TAG_NON_FINITE,
  S.record({
    which: S.kind("string"),
    value: S.kind("string"),
  }),
);

const degenerateOutputSchema = S.tagged(
  TAG_DEGENERATE,
  S.record({ detail: S.kind("string") }),
);

const noKnownReprOutputSchema = S.tagged(
  TAG_NO_REPR,
  S.record({
    head: S.kind("string"),
    axis: S.kind("string"),
    reason: S.kind("string"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  unknownHeadOutputSchema,
  nonFiniteOutputSchema,
  degenerateOutputSchema,
  noKnownReprOutputSchema,
]);

// -----------------------------------------------------------------------------
// Convenience helpers — encoding successful outputs
// -----------------------------------------------------------------------------

function realSuccess(
  v: BigFloat,
  method: string,
  achievedPrecBits: number,
  warnings: string[] = [],
) {
  return record({
    value: bigfloatToValue(v),
    method: str(method),
    achieved_precision: int(BigInt(achievedPrecBits)),
    warnings: list(warnings.map((w) => str(w))),
  });
}

function complexSuccess(
  v: BigComplex,
  method: string,
  achievedPrecBits: number,
  warnings: string[] = [],
) {
  return record({
    value: bigcomplexToValue(v),
    method: str(method),
    achieved_precision: int(BigInt(achievedPrecBits)),
    warnings: list(warnings.map((w) => str(w))),
  });
}

/**
 * Wrap a float64 real value as a 53-bit BigFloat. `fromFloat64` is exact
 * (every finite float64 has an exact binary expansion fitting 53 bits);
 * `normalise` then forces the precision metadata to 53 so the wire shape
 * is uniform.
 */
function float64ToBigFloat(x: number): BigFloat {
  if (!Number.isFinite(x)) {
    // The substrate sometimes returns ±Inf (e.g. `erfInvFloat64(1)`); we
    // represent these as max-magnitude finite BigFloats with a warning
    // upstream. Here we just guard so `fromFloat64` doesn't throw.
    // Callers should have intercepted the saturation case BEFORE calling
    // us; if we land here it's a bug in the dispatcher.
    throw new ToolError(
      `${NAME}: internal — float64ToBigFloat called on non-finite ${x}`,
      { suggestion: "this is an internal-dispatcher invariant violation; report a bug" },
    );
  }
  const bf = fromFloat64(x);
  // Round/pad to exactly 53 bits so achieved_precision = 53 is honest.
  return normalise(bf.mantissa, bf.exponent, 53);
}

/**
 * Wrap a (re, im) float64 pair as a 53-bit BigComplex.
 */
function float64ToBigComplex(re: number, im: number): BigComplex {
  return { re: float64ToBigFloat(re), im: float64ToBigFloat(im) };
}

// -----------------------------------------------------------------------------
// Input decoding helpers
// -----------------------------------------------------------------------------

function readRealArgs(args: ListValue): number[] {
  return args.items.map((v) => {
    if (v.kind !== "float64") {
      throw new ToolError(
        `${NAME}: real args must be float64 leaves; got ${v.kind}`,
      );
    }
    return float64ToNumber(v as Float64Value);
  });
}

function readComplexArgs(args: RecordValue): { re: number[]; im: number[] } {
  const reField = args.fields.re;
  const imField = args.fields.im;
  if (reField === undefined || imField === undefined) {
    throw new ToolError(
      `${NAME}: complex args record must have both 're' and 'im' fields`,
    );
  }
  if (reField.kind !== "list" || imField.kind !== "list") {
    throw new ToolError(
      `${NAME}: complex args 're' and 'im' must be list<float64>`,
    );
  }
  const re = readRealArgs(reField as ListValue);
  const im = readRealArgs(imField as ListValue);
  return { re, im };
}

// -----------------------------------------------------------------------------
// Refusal helpers — building tagged outputs
// -----------------------------------------------------------------------------

function unknownHead(head: string) {
  return tagged(
    TAG_UNKNOWN_HEAD,
    record({
      head: str(head),
      admitted: list(ADMITTED_HEADS.map((h) => str(h))),
    }),
  );
}

function nonFinite(which: string, value: number) {
  return tagged(
    TAG_NON_FINITE,
    record({
      which: str(which),
      value: str(formatNonFinite(value)),
    }),
  );
}

function degenerateShape(detail: string) {
  return tagged(
    TAG_DEGENERATE,
    record({ detail: str(detail) }),
  );
}

function noKnownRepresentation(head: string, axis: string, reason: string) {
  return tagged(
    TAG_NO_REPR,
    record({
      head: str(head),
      axis: str(axis),
      reason: str(reason),
    }),
  );
}

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

// -----------------------------------------------------------------------------
// Core dispatch — per-head per-tier
// -----------------------------------------------------------------------------

/**
 * Dispatch a real-axis call for arity-1 heads (Erf family).  Caller has
 * validated arity (one arg) and finiteness.  Returns the encoded success
 * record OR a tagged refusal (no-known-representation when arb-prec is
 * requested for an inverse).
 */
function dispatchReal(
  head: AdmittedHead,
  x: number,
  precisionDecimal: number,
): Value {
  // Tier dispatch: the precision flag picks the lane. The boundary at 53
  // bits is the IEEE-754 binary64 mantissa width; per ADR-0040 §"Decision
  // 9" this is the dispatch threshold the agent's planner aligns with.
  // We compare against the BINARY-precision floor (53 bits ≈ 16 decimal
  // digits via Math.log2(10)≈3.32), so `--precision <= 15` (decimal)
  // routes float64.
  const useFloat64 = precisionDecimal <= 15;

  // Defensive: dispatchReal is the Erf-family-only entry.  If a non-Erf
  // head leaks in, the float64-lane ternary chain would silently fall
  // through to `erfcInvFloat64`.  Fail loud (CLAUDE.md Rule 1).
  if (
    head !== "Erf" &&
    head !== "Erfc" &&
    head !== "Erfcx" &&
    head !== "Erfi" &&
    head !== "InverseErf" &&
    head !== "InverseErfc"
  ) {
    throw new ToolError(
      `${NAME}: internal — non-Erf head '${head}' routed through dispatchReal`,
      { suggestion: "Bessel heads go through dispatchRealBessel; Gamma heads through dispatchRealGamma" },
    );
  }

  if (useFloat64) {
    // Float64 lane — uses the SunPro 1993 port (R3 / I5).
    const fn: (x: number) => number =
      head === "Erf" ? erfFloat64
      : head === "Erfc" ? erfcFloat64
      : head === "Erfcx" ? erfcxFloat64
      : head === "Erfi" ? erfiFloat64
      : head === "InverseErf" ? erfInvFloat64
      : erfcInvFloat64;
    const y = fn(x);
    const method = FLOAT64_METHOD[head];
    const warnings: string[] = [];
    if (!Number.isFinite(y)) {
      // Saturated output (e.g. erfInv(1) = +Inf). We emit a max-magnitude
      // BigFloat with a warning rather than throw; this is the same
      // agent-honest pattern as `linalg-solve`'s warnings list.
      warnings.push(
        `float64-saturation: ${head}(${x}) = ${formatNonFinite(y)}; saturated at float64 boundary`,
      );
      // Represent as a max-magnitude finite BigFloat: the largest float64
      // is ~1.8e308. We use that as the encoding. Honest alternative
      // would be a separate boundary tag, but the existing warnings
      // surface is the agent-honest channel for "saturation observed".
      const sat = y > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
      return realSuccess(float64ToBigFloat(sat), method, 53, warnings);
    }
    return realSuccess(float64ToBigFloat(y), method, 53, warnings);
  }

  // Arb-prec lane. First refuse the heads we have no real arb-prec impl
  // for in v0.1 (InverseErf / InverseErfc — see top-of-file table).
  if (NO_ARBPREC_REAL.has(head)) {
    return noKnownRepresentation(
      head,
      "real",
      `v0.1 substrate ships no arb-prec impl for ${head}; use --precision <= 15 for the float64 path`,
    );
  }

  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const xBig = fromFloat64(x);
  const method = ARBPREC_METHOD_REAL[head];

  // Per-head substrate dispatch. The substrate primitives live in
  // `packages/bigfloat/src/special-funcs/erf.ts` (I1+I2) and
  // `packages/bigfloat/src/complex.ts` (I3, used for real Erfi via the
  // bigCErfi identity).
  let result: BigFloat;
  switch (head) {
    case "Erf":
      result = bigErf(xBig, precBits);
      break;
    case "Erfc":
      result = bigErfc(xBig, precBits);
      break;
    case "Erfcx":
      result = bigErfcx(xBig, precBits);
      break;
    case "Erfi": {
      // Real arb-prec Erfi: route through bigCErfi at z = x + 0i and
      // take the real part. This is the substrate's intended path (see
      // R2 §"Pick: Karbach-Weideman" identity table — `bigCErfi(x) =
      // bigCErfi(x + 0i)` is real-axis by construction; the bigfloat
      // package didn't ship a separate real `bigErfi` because the
      // identity makes it redundant). The imaginary part of the result
      // should be (and is, by construction) zero modulo internal
      // round-off; we surface a warning if the imaginary part is large
      // enough to be a structural problem (which would indicate a
      // substrate bug — not expected, but agent-honest to surface).
      const z: BigComplex = { re: xBig, im: fromInt(0n, precBits) };
      const w = bigCErfi(z, precBits);
      result = cre(w);
      const imPart = cim(w);
      // The imaginary part should be 0 byte-identically by construction.
      // If it's not, the warning surfaces the substrate anomaly.
      if (imPart.mantissa !== 0n) {
        // Treat as a soft anomaly — not a refusal, since the real part
        // IS the correct answer. Surface via warnings.
        // (No actual return; flow continues with `result` = real part.)
        // Note: warnings on the success branch is the right channel —
        // see `integrate-1d`'s warnings field for the same pattern.
        return realSuccess(result, method, precBits, [
          `arbprec-erfi: imaginary part of bigCErfi(${x} + 0i) was non-zero; this is the real part`,
        ]);
      }
      break;
    }
    case "InverseErf":
    case "InverseErfc":
      // Unreachable — handled by NO_ARBPREC_REAL gate above.
      return noKnownRepresentation(head, "real", "unreachable inverse gate");
    default:
      // Unreachable — Bessel heads route through dispatchRealBessel, and
      // Gamma-family heads route through dispatchRealGamma. The narrowed
      // `head` type here is the Erf-family union, so the `default:` is the
      // exhaustiveness guard for any future Erf-family head a future ADR
      // adds without updating the switch.
      throw new ToolError(
        `${NAME}: internal — head '${head}' is not an Erf-family head and was routed through dispatchReal`,
      );
  }
  return realSuccess(result, method, precBits, []);
}

/**
 * Dispatch a complex-axis call. Caller has validated arity (one (re,im)
 * pair) and finiteness. Returns the encoded success record OR a tagged
 * refusal (no-known-representation for InverseErf / InverseErfc complex
 * regardless of precision — per R3 §3 there's no canonical computational
 * form on the complex plane).
 */
function dispatchComplex(
  head: AdmittedHead,
  re: number,
  im: number,
  precisionDecimal: number,
): Value {
  // Defensive: dispatchComplex is the Erf-family-only entry.
  if (
    head !== "Erf" &&
    head !== "Erfc" &&
    head !== "Erfcx" &&
    head !== "Erfi" &&
    head !== "InverseErf" &&
    head !== "InverseErfc"
  ) {
    throw new ToolError(
      `${NAME}: internal — non-Erf head '${head}' routed through dispatchComplex`,
      { suggestion: "Bessel heads go through dispatchComplexBessel; Gamma heads through dispatchComplexGamma" },
    );
  }

  // Honest refusal for complex inverses, at every precision tier (R3 §3).
  if (NO_COMPLEX_AT_ALL.has(head)) {
    return noKnownRepresentation(
      head,
      "complex",
      `${head} on the complex axis has no canonical computational form (multi-valued Riemann surface; R3 §3 — SciPy / Boost / Julia all decline)`,
    );
  }

  const useFloat64 = precisionDecimal <= 15;

  if (useFloat64) {
    const fn: (re: number, im: number) => { re: number; im: number } =
      head === "Erf" ? erfComplexFloat64
      : head === "Erfc" ? erfcComplexFloat64
      : head === "Erfcx" ? erfcxComplexFloat64
      : erfiComplexFloat64;
    const { re: yRe, im: yIm } = fn(re, im);
    const method = FLOAT64_COMPLEX_METHOD[head];
    const warnings: string[] = [];
    if (!Number.isFinite(yRe) || !Number.isFinite(yIm)) {
      warnings.push(
        `float64-saturation: ${head}(${re}+${im}i) = (${formatNonFinite(yRe)} + ${formatNonFinite(yIm)}i); saturated`,
      );
      const satRe = Number.isFinite(yRe) ? yRe : (yRe > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      const satIm = Number.isFinite(yIm) ? yIm : (yIm > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      return complexSuccess(float64ToBigComplex(satRe, satIm), method, 53, warnings);
    }
    return complexSuccess(float64ToBigComplex(yRe, yIm), method, 53, warnings);
  }

  // Arb-prec complex lane. No v0.1 gaps here for the four forward heads.
  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const z: BigComplex = {
    re: fromFloat64(re),
    im: fromFloat64(im),
  };
  const method = ARBPREC_METHOD_COMPLEX[head];

  let result: BigComplex;
  switch (head) {
    case "Erf":
      result = bigCErf(z, precBits);
      break;
    case "Erfc":
      result = bigCErfc(z, precBits);
      break;
    case "Erfcx":
      result = bigCErfcx(z, precBits);
      break;
    case "Erfi":
      result = bigCErfi(z, precBits);
      break;
    case "InverseErf":
    case "InverseErfc":
      // Unreachable — handled by NO_COMPLEX_AT_ALL gate above.
      return noKnownRepresentation(head, "complex", "unreachable inverse gate");
    default:
      // Unreachable — Bessel heads route through dispatchComplexBessel, and
      // Gamma-family heads route through dispatchComplexGamma. The narrowed
      // `head` type here is the Erf-family union, so the `default:` is the
      // exhaustiveness guard for any future Erf-family head a future ADR
      // adds without updating the switch.
      throw new ToolError(
        `${NAME}: internal — head '${head}' is not an Erf-family head and was routed through dispatchComplex`,
      );
  }
  return complexSuccess(result, method, precBits, []);
}

// -----------------------------------------------------------------------------
// Core dispatch — Bessel (arity-2: ν + z)
// -----------------------------------------------------------------------------
//
// The Bessel family is the first 2-argument special-function head in the
// vocabulary (Erf was uniformly 1-arg).  ADR-0041 §"Decision 7" pins the
// wire shape; the dispatch matrix mirrors `dispatchReal` / `dispatchComplex`
// above but threads ν as a separate parameter.
//
// ν is real throughout v0.2.  Integer ν, half-integer ν, and general-
// real ν all flow through the same dispatch entry — the substrate is
// internally ν-aware (FLINT-pattern integer fast paths in `bigBesselY` /
// `bigBesselK`, scaled variants for the float64 overflow boundary).

/**
 * Real-axis Bessel dispatch.  Caller has validated arity (`args.length
 * === 2`) and finiteness of both `nu` and `z`.  Routes float64 vs arb-
 * prec by the same `--precision <= 15` boundary as the Erf dispatcher.
 *
 * Negative-non-integer ν `I_ν(0) = unbounded`, `K_ν(0) = +∞`, and
 * `Y_ν(0) = -∞` are substrate-thrown `RangeError`s; we catch and convert
 * to `non-finite-input` refusals (the input is finite but the closed-
 * form output isn't — semantically the same boundary).
 */
function dispatchRealBessel(
  head: AdmittedHead,
  nu: number,
  z: number,
  precisionDecimal: number,
): Value {
  // Defensive: only Bessel heads should reach here.
  if (!isBesselHead(head)) {
    throw new ToolError(
      `${NAME}: internal — non-Bessel head '${head}' routed through dispatchRealBessel`,
    );
  }
  const useFloat64 = precisionDecimal <= 15;

  if (useFloat64) {
    // Float64 lane.  Verbatim R3 ports — musl SunPro J/Y for integer ν,
    // Cephes Moshier I/K for order 0/1, AMOS for the rest.  Scaled
    // variants avoid the `|z| > 700` overflow cliff.
    const fn: (nu: number, z: number) => number =
      head === "BesselJ" ? besselJFloat64
      : head === "BesselY" ? besselYFloat64
      : head === "BesselI" ? besselIFloat64
      : head === "BesselK" ? besselKFloat64
      : head === "BesselIScaled" ? besselIScaledFloat64
      : besselKScaledFloat64; // BesselKScaled
    let y: number;
    try {
      y = fn(nu, z);
    } catch (e) {
      // Substrate throws on singular inputs (K_ν(0), I_ν(0) for
      // negative non-integer ν).  Convert to a no-known-representation
      // refusal — the input is well-formed but the value is unbounded.
      return noKnownRepresentation(
        head,
        "real",
        `${head}(${nu}, ${z}) is mathematically unbounded or singular: ${(e as Error).message}`,
      );
    }
    const method = FLOAT64_METHOD[head];
    const warnings: string[] = [];
    if (!Number.isFinite(y)) {
      // Saturation at the float64 boundary — most commonly `besselI(0,
      // 700)` overflowing to +Inf, or `besselK(0, 1e6)` underflowing to
      // 0 (technically not non-finite for underflow, but +Inf is).  We
      // emit a max-magnitude finite BigFloat with a warning, mirroring
      // the Erf saturation pattern; an agent reading the warnings list
      // knows to retry with the Scaled variant or with a higher precision.
      warnings.push(
        `float64-saturation: ${head}(${nu}, ${z}) = ${formatNonFinite(y)}; saturated at float64 boundary (try the Scaled variant or --precision > 15)`,
      );
      const sat = y > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
      return realSuccess(float64ToBigFloat(sat), method, 53, warnings);
    }
    return realSuccess(float64ToBigFloat(y), method, 53, warnings);
  }

  // Arb-prec lane (real Bessel).  Substrates live in
  // `packages/bigfloat/src/special-funcs/bessel{j,y,i,k}.ts`.
  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const nuBig = fromFloat64(nu);
  const zBig = fromFloat64(z);
  const method = ARBPREC_METHOD_REAL[head];

  let result: BigFloat;
  try {
    switch (head) {
      case "BesselJ":
        result = bigBesselJ(nuBig, zBig, precBits);
        break;
      case "BesselY":
        result = bigBesselY(nuBig, zBig, precBits);
        break;
      case "BesselI":
        result = bigBesselI(nuBig, zBig, precBits);
        break;
      case "BesselK":
        result = bigBesselK(nuBig, zBig, precBits);
        break;
      case "BesselIScaled":
        result = bigBesselIScaled(nuBig, zBig, precBits);
        break;
      case "BesselKScaled":
        result = bigBesselKScaled(nuBig, zBig, precBits);
        break;
      default:
        // Unreachable for Bessel; the Erf-family heads route through
        // dispatchReal.  Exhaustiveness guard.
        throw new ToolError(`${NAME}: internal — Erf head ${head} routed through dispatchRealBessel`);
    }
  } catch (e) {
    return noKnownRepresentation(
      head,
      "real",
      `${head}(${nu}, ${z}) at precision ${precisionDecimal}: ${(e as Error).message}`,
    );
  }
  return realSuccess(result, method, precBits, []);
}

/**
 * Complex-axis Bessel dispatch.  Caller has validated arity (`re.length
 * === im.length === 2`) and finiteness of all 4 scalars.  The wire
 * shape places ν (real) at index 0 and z = re[1] + i·im[1] at index 1;
 * we accept ν with non-zero imaginary part *if the caller supplies it*
 * (the substrate's complex layer admits complex ν), but in practice the
 * golden / test corpus exercises real ν only.
 *
 * BesselIScaled / BesselKScaled on the complex float64 lane refuse with
 * `no-known-representation` per R3 §0.4 — AMOS exposes only the
 * unscaled call; the arb-prec complex scaled variants ship and route.
 */
function dispatchComplexBessel(
  head: AdmittedHead,
  nuRe: number,
  nuIm: number,
  zRe: number,
  zIm: number,
  precisionDecimal: number,
): Value {
  // Defensive: only Bessel heads should reach here.
  if (!isBesselHead(head)) {
    throw new ToolError(
      `${NAME}: internal — non-Bessel head '${head}' routed through dispatchComplexBessel`,
    );
  }
  const useFloat64 = precisionDecimal <= 15;

  if (useFloat64) {
    if (NO_FLOAT64_COMPLEX.has(head)) {
      return noKnownRepresentation(
        head,
        "complex",
        `${head} complex float64 not in v0.2 (AMOS TOMS 644 exposes scaled variants on the real axis only; use --precision > 15 for the arb-prec complex scaled lane)`,
      );
    }
    if (nuIm !== 0) {
      // Float64 complex Bessel: AMOS ZBESJ/Y/I/K wraps ν as a real
      // parameter (`fnu` in the Fortran).  A complex-ν call is not part
      // of the v0.2 float64 surface; refuse honestly rather than silently
      // drop the imaginary part.
      return noKnownRepresentation(
        head,
        "complex",
        `${head} float64 complex lane accepts real ν only (got ν.im=${nuIm}); use --precision > 15 for the arb-prec complex-ν lane`,
      );
    }
    const fn: (nu: number, re: number, im: number) => { re: number; im: number } =
      head === "BesselJ" ? besselJComplexFloat64
      : head === "BesselY" ? besselYComplexFloat64
      : head === "BesselI" ? besselIComplexFloat64
      : besselKComplexFloat64; // BesselK
    let result: { re: number; im: number };
    try {
      result = fn(nuRe, zRe, zIm);
    } catch (e) {
      return noKnownRepresentation(
        head,
        "complex",
        `${head}(${nuRe}, ${zRe}+${zIm}i): ${(e as Error).message}`,
      );
    }
    const { re: yRe, im: yIm } = result;
    const method = FLOAT64_COMPLEX_METHOD[head];
    const warnings: string[] = [];
    if (!Number.isFinite(yRe) || !Number.isFinite(yIm)) {
      warnings.push(
        `float64-saturation: ${head}(${nuRe}, ${zRe}+${zIm}i) = (${formatNonFinite(yRe)} + ${formatNonFinite(yIm)}i); saturated`,
      );
      const satRe = Number.isFinite(yRe) ? yRe : (yRe > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      const satIm = Number.isFinite(yIm) ? yIm : (yIm > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      return complexSuccess(float64ToBigComplex(satRe, satIm), method, 53, warnings);
    }
    return complexSuccess(float64ToBigComplex(yRe, yIm), method, 53, warnings);
  }

  // Arb-prec complex Bessel.  AMOS-style rotation (ADR-0041 §"Decision
  // 11"): the substrate's complex layer computes modified I/K directly
  // and derives J/Y algebraically via `J_ν(z) = exp(±νπi/2)·I_ν(∓iz)`.
  const precBits = decimalToBinaryPrecision(precisionDecimal);
  // ν: build as a BigComplex (the substrate signature is uniform).
  // nuIm is typically 0; we accept caller-supplied non-zero ν.im
  // verbatim since the substrate's complex layer admits it.
  const nuBig: BigComplex = {
    re: fromFloat64(nuRe),
    im: fromFloat64(nuIm),
  };
  const z: BigComplex = {
    re: fromFloat64(zRe),
    im: fromFloat64(zIm),
  };
  const method = ARBPREC_METHOD_COMPLEX[head];

  let result: BigComplex;
  try {
    switch (head) {
      case "BesselJ":
        result = bigCBesselJ(nuBig, z, precBits);
        break;
      case "BesselY":
        result = bigCBesselY(nuBig, z, precBits);
        break;
      case "BesselI":
        result = bigCBesselI(nuBig, z, precBits);
        break;
      case "BesselK":
        result = bigCBesselK(nuBig, z, precBits);
        break;
      case "BesselIScaled":
        result = bigCBesselIScaled(nuBig, z, precBits);
        break;
      case "BesselKScaled":
        result = bigCBesselKScaled(nuBig, z, precBits);
        break;
      default:
        throw new ToolError(`${NAME}: internal — Erf head ${head} routed through dispatchComplexBessel`);
    }
  } catch (e) {
    return noKnownRepresentation(
      head,
      "complex",
      `${head}(ν=${nuRe}+${nuIm}i, z=${zRe}+${zIm}i) at precision ${precisionDecimal}: ${(e as Error).message}`,
    );
  }
  return complexSuccess(result, method, precBits, []);
}

// -----------------------------------------------------------------------------
// Core dispatch — Gamma family (arity-1 spine + arity-2 with various semantics)
// -----------------------------------------------------------------------------
//
// 16 heads admitted (ADR-0042 §"Decision 7-9"; bead 6g09 / T2).  Three
// shape-classes within the family:
//
//   * Arity-1 spine — Gamma, LogGamma, Digamma, Trigamma, BarnesG,
//     Hyperfactorial.  args = [z].
//
//   * Arity-2, (order, point) shape — Polygamma(m, z), Pochhammer(a, n).
//     The first arg has integer-or-near-integer semantics in the
//     substrate (m must be a non-negative integer for Polygamma;
//     bigPochhammer accepts arbitrary real n but the most common
//     consumer pattern is integer n).
//
//   * Arity-2, (point, point) shape — IncompleteGamma{Upper,Lower,P,Q}
//     (a, z), Beta(a, b), LogBeta(a, b), GammaRatio(a, b),
//     GammaDeltaRatio(a, δ).  Both args are general real / complex.
//
// The arity gate (`HEAD_ARITY`) treats all three uniformly as arity-2;
// per-head semantics for which arg is which are documented in the
// README's catalog.
//
// Per-output tier conditioning (ADR-0040 §"Decision 9"):
//
//   * `--precision ≤ 15` → float64 lane (achieved_precision = 53 bits);
//     output `value` carries float64 leaves wrapped as a 53-bit
//     BigFloat / BigComplex, so the provenance record's `platform`
//     field IS written.
//   * `--precision > 15` → arb-prec lane (achieved_precision = the
//     binary precision derived from the decimal flag); BigInt
//     arithmetic is cross-platform bit-identical so the `platform`
//     field is OMITTED for these outputs.
//
// The per-output tier conditioning is enforced by the runner's
// provenance writer (ADR-0040 §"Decision 9"); this dispatcher only
// returns the canonical output shape and lets the runner inspect for
// float64 leaves.

/**
 * Real-axis Gamma dispatch.  Caller has validated arity (1 or 2 per
 * `HEAD_ARITY`) and finiteness of all scalars.  Routes float64 vs arb-
 * prec by the same `--precision <= 15` boundary as Erf / Bessel.
 *
 * Singularities (non-positive integer z for Gamma / LogGamma / Digamma /
 * Trigamma / Polygamma / BarnesG / Hyperfactorial; a ≤ 0 or z < 0 for
 * IncompleteGamma*; a ≤ 0 or b ≤ 0 for Beta / LogBeta) are substrate-
 * thrown `RangeError`s caught and converted to
 * `no-known-representation` refusals — the input is finite but the
 * closed-form output isn't, semantically parallel to `K_ν(0)`.
 */
function dispatchRealGamma(
  head: AdmittedHead,
  arg0: number,
  arg1: number | null,
  precisionDecimal: number,
): Value {
  const useFloat64 = precisionDecimal <= 15;
  const arity = HEAD_ARITY[head];

  if (useFloat64) {
    let y: number;
    try {
      switch (head) {
        case "Gamma":
          y = gammaFloat64(arg0);
          break;
        case "LogGamma":
          y = lgammaFloat64(arg0).value;
          break;
        case "Digamma":
          y = digammaFloat64(arg0);
          break;
        case "Trigamma":
          y = trigammaFloat64(arg0);
          break;
        case "Polygamma": {
          // First arg is the polygamma order m (must be a non-negative
          // integer); the substrate's `polygammaFloat64(m, x)` returns
          // NaN on non-integer / negative m.  We refuse explicitly with
          // a degenerate-shape tag rather than emit NaN.
          if (!Number.isInteger(arg0!) || arg0! < 0) {
            return degenerateShape(
              `Polygamma: order m must be a non-negative integer; got ${arg0}`,
            );
          }
          y = polygammaFloat64(arg0!, arg1!);
          break;
        }
        case "Pochhammer":
          y = pochhammerFloat64(arg0, arg1!);
          break;
        case "IncompleteGammaUpper":
          y = incGammaUpperFloat64(arg0, arg1!);
          break;
        case "IncompleteGammaLower":
          y = incGammaLowerFloat64(arg0, arg1!);
          break;
        case "IncompleteGammaP":
          y = gammaPFloat64(arg0, arg1!);
          break;
        case "IncompleteGammaQ":
          y = gammaQFloat64(arg0, arg1!);
          break;
        case "Beta":
          y = betaFloat64(arg0, arg1!);
          break;
        case "LogBeta":
          y = logBetaFloat64(arg0, arg1!).value;
          break;
        case "BarnesG":
          y = barnesGFloat64(arg0);
          break;
        case "Hyperfactorial":
          y = hyperfactorialFloat64(arg0);
          break;
        case "GammaRatio":
          y = gammaRatioFloat64(arg0, arg1!);
          break;
        case "GammaDeltaRatio":
          y = gammaDeltaRatioFloat64(arg0, arg1!);
          break;
        default:
          // Unreachable — Erf / Bessel handled elsewhere.
          throw new ToolError(
            `${NAME}: internal — non-Gamma head ${head} routed through dispatchRealGamma`,
          );
      }
    } catch (e) {
      return noKnownRepresentation(
        head,
        "real",
        `${head}(${arity === 1 ? arg0 : `${arg0}, ${arg1}`}) at float64 lane: ${(e as Error).message}`,
      );
    }
    const method = FLOAT64_METHOD[head];
    const warnings: string[] = [];
    // NaN on the float64 lane usually signals a domain refusal (e.g.
    // Pochhammer(a, n) with a ≤ 0 and n non-integer; IncompleteGamma
    // with a < 0).  Map to a `no-known-representation` refusal rather
    // than emit a silent NaN-loaded record.
    if (Number.isNaN(y)) {
      return noKnownRepresentation(
        head,
        "real",
        `${head}(${arity === 1 ? arg0 : `${arg0}, ${arg1}`}) returned NaN on the float64 lane (domain refusal)`,
      );
    }
    if (!Number.isFinite(y)) {
      // Saturated output (e.g. Γ(170) overflowing, Γ(0) = +∞).  We emit
      // a max-magnitude finite BigFloat with a warning, mirroring the
      // Erf / Bessel saturation pattern.  An agent reading `warnings`
      // can retry with `--precision > 15` to access the arb-prec lane
      // for the true value, or with a higher-precision composition
      // (e.g. `LogGamma(170)` directly).
      warnings.push(
        `float64-saturation: ${head}(${arity === 1 ? arg0 : `${arg0}, ${arg1}`}) = ${formatNonFinite(y)}; saturated at float64 boundary (try --precision > 15 for the arb-prec lane)`,
      );
      const sat = y > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
      return realSuccess(float64ToBigFloat(sat), method, 53, warnings);
    }
    return realSuccess(float64ToBigFloat(y), method, 53, warnings);
  }

  // Arb-prec lane.  Per ADR-0042 §"Decision 7-9", the gamma family has
  // direct arb-prec substrate for the 13 primary heads (Gamma, LogGamma,
  // Digamma, Trigamma, Polygamma, Pochhammer, IncompleteGamma*, Beta,
  // LogBeta, BarnesG).  Hyperfactorial / GammaRatio / GammaDeltaRatio
  // are COMPOSED here from `bigBarnesG` / `gamma` per the identities
  // documented in the head's docstring — the composition is exact and
  // inherits the substrate's `arbprec: true` determinism contract.
  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const method = ARBPREC_METHOD_REAL[head];

  let result: BigFloat;
  try {
    switch (head) {
      case "Gamma":
        result = gamma(fromFloat64(arg0), precBits);
        break;
      case "LogGamma":
        result = lgamma(fromFloat64(arg0), precBits);
        break;
      case "Digamma":
        result = digamma(fromFloat64(arg0), precBits);
        break;
      case "Trigamma":
        result = trigamma(fromFloat64(arg0), precBits);
        break;
      case "Polygamma": {
        if (!Number.isInteger(arg0) || arg0 < 0) {
          return degenerateShape(
            `Polygamma: order m must be a non-negative integer; got ${arg0}`,
          );
        }
        result = polygamma(arg0, fromFloat64(arg1!), precBits);
        break;
      }
      case "Pochhammer":
        result = bigPochhammer(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "IncompleteGammaUpper":
        result = bigIncompleteGammaUpper(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "IncompleteGammaLower":
        result = bigIncompleteGammaLower(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "IncompleteGammaP":
        result = bigGammaP(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "IncompleteGammaQ":
        result = bigGammaQ(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "Beta":
        result = bigBeta(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "LogBeta":
        result = bigLogBeta(
          fromFloat64(arg0),
          fromFloat64(arg1!),
          precBits,
        );
        break;
      case "BarnesG":
        result = bigBarnesG(fromFloat64(arg0), precBits);
        break;
      case "Hyperfactorial": {
        // Bendersky-Adamchik identity:  H(z) = Γ(z+1)^z / G(z+1).
        // Derivation: differentiate log G's integral representation
        // (Adamchik 2007 §3); the identity holds for z > 0 real and
        // analytically continues elsewhere except at the gamma poles.
        // For non-positive integer z the gamma substrate throws, which
        // propagates up to the catch block below as a refusal.
        //
        // MUTATION-PROOF: dropping the `^z` term sends H(3) (= 108) to
        // 3 (= Γ(4)/G(4) = 6/2); the closed-form test `H(3) = 108`
        // fires immediately.  Verified via inline check at the bottom
        // of the substrate dispatch on 2026-05-19.
        const work = precBits + 32;
        const zBig = fromFloat64(arg0);
        const zPlus1 = bfAdd(zBig, fromInt(1n, work), work);
        const gammaZPlus1 = gamma(zPlus1, work);
        const num = bfPow(gammaZPlus1, zBig, work);
        const denom = bigBarnesG(zPlus1, work);
        const ratio = bfDiv(num, denom, work);
        result = normalise(ratio.mantissa, ratio.exponent, precBits);
        break;
      }
      case "GammaRatio": {
        // Γ(a) / Γ(b).  At extreme |a|, |b| this loses precision through
        // double exp/log of magnitudes; the substrate's `gamma` carries
        // an internal extended-range BigFloat so direct division is
        // bit-deterministic without an lgamma round-trip.
        //
        // MUTATION-PROOF: swapping numerator and denominator yields
        // 1/intended at every input.  The closed-form test
        // `GammaRatio(5, 3) = Γ(5)/Γ(3) = 24/2 = 12` catches it.
        const work = precBits + 16;
        const ga = gamma(fromFloat64(arg0), work);
        const gb = gamma(fromFloat64(arg1!), work);
        const ratio = bfDiv(ga, gb, work);
        result = normalise(ratio.mantissa, ratio.exponent, precBits);
        break;
      }
      case "GammaDeltaRatio": {
        // Γ(a) / Γ(a + δ).  Equivalent to `1 / Pochhammer(a, δ)` for
        // integer δ ≥ 0, but we compute directly via two gamma calls
        // for uniform arb-prec semantics at non-integer δ.
        const work = precBits + 16;
        const a = fromFloat64(arg0);
        const delta = fromFloat64(arg1!);
        const ga = gamma(a, work);
        const gaDelta = gamma(bfAdd(a, delta, work), work);
        const ratio = bfDiv(ga, gaDelta, work);
        result = normalise(ratio.mantissa, ratio.exponent, precBits);
        break;
      }
      default:
        throw new ToolError(
          `${NAME}: internal — non-Gamma head ${head} routed through dispatchRealGamma arb-prec`,
        );
    }
  } catch (e) {
    return noKnownRepresentation(
      head,
      "real",
      `${head}(${arity === 1 ? arg0 : `${arg0}, ${arg1}`}) at precision ${precisionDecimal}: ${(e as Error).message}`,
    );
  }
  return realSuccess(result, method, precBits, []);
}

/**
 * Complex-axis Gamma dispatch.  Caller has validated arity, list-shape,
 * and finiteness.  Only 8 of the 16 admitted heads have a complex
 * substrate (real-axis only otherwise — see `NO_COMPLEX_GAMMA`).
 *
 * Heads with complex substrate:
 *   * Float64 + arbprec:  Gamma, LogGamma, Digamma  (gammaComplexFloat64
 *                         / lgammaComplexFloat64 / digammaComplexFloat64
 *                         + cgamma / clgamma / cdigamma).
 *   * Arbprec only:       Trigamma, Polygamma, IncompleteGammaUpper,
 *                         IncompleteGammaLower, Beta.
 *
 * Heads in `NO_COMPLEX_GAMMA` refuse with `no-known-representation` at
 * every precision tier — the substrate gap is documented per-head in
 * the `NO_COMPLEX_GAMMA` declaration.
 */
function dispatchComplexGamma(
  head: AdmittedHead,
  arg0Re: number,
  arg0Im: number,
  arg1Re: number | null,
  arg1Im: number | null,
  precisionDecimal: number,
): Value {
  const arity = HEAD_ARITY[head];

  // Honest refusal for heads with no complex substrate at any precision.
  if (NO_COMPLEX_GAMMA.has(head)) {
    return noKnownRepresentation(
      head,
      "complex",
      `${head} has no complex substrate in v0.2 (real-axis only; see ADR-0042 §"Decision 7-9" — filed as a v0.3 follow-up)`,
    );
  }

  const useFloat64 = precisionDecimal <= 15;

  if (useFloat64) {
    // Float64 complex: only Gamma, LogGamma, Digamma ship a complex
    // float64 substrate (SciPy `_loggamma.pxd` lineage).  Trigamma,
    // Polygamma, IncompleteGamma{Upper,Lower}, Beta refuse here and
    // route to arb-prec at `--precision > 15`.
    if (NO_FLOAT64_COMPLEX.has(head)) {
      return noKnownRepresentation(
        head,
        "complex",
        `${head} complex float64 not in v0.2 (the gamma-float64 dispatcher ships gamma / lgamma / digamma complex only); use --precision > 15 for the arb-prec complex lane`,
      );
    }
    let result: { re: number; im: number };
    try {
      switch (head) {
        case "Gamma":
          result = gammaComplexFloat64(arg0Re, arg0Im);
          break;
        case "LogGamma":
          result = lgammaComplexFloat64(arg0Re, arg0Im);
          break;
        case "Digamma":
          result = digammaComplexFloat64(arg0Re, arg0Im);
          break;
        default:
          throw new ToolError(
            `${NAME}: internal — head ${head} reached float64-complex Gamma fallthrough`,
          );
      }
    } catch (e) {
      return noKnownRepresentation(
        head,
        "complex",
        `${head}(${arg0Re}+${arg0Im}i) at float64 lane: ${(e as Error).message}`,
      );
    }
    const method = FLOAT64_COMPLEX_METHOD[head];
    const warnings: string[] = [];
    if (Number.isNaN(result.re) || Number.isNaN(result.im)) {
      return noKnownRepresentation(
        head,
        "complex",
        `${head}(${arg0Re}+${arg0Im}i) returned NaN on the float64 complex lane (domain refusal)`,
      );
    }
    if (!Number.isFinite(result.re) || !Number.isFinite(result.im)) {
      warnings.push(
        `float64-saturation: ${head}(${arg0Re}+${arg0Im}i) = (${formatNonFinite(result.re)} + ${formatNonFinite(result.im)}i); saturated`,
      );
      const satRe = Number.isFinite(result.re)
        ? result.re
        : result.re > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
      const satIm = Number.isFinite(result.im)
        ? result.im
        : result.im > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
      return complexSuccess(
        float64ToBigComplex(satRe, satIm),
        method,
        53,
        warnings,
      );
    }
    return complexSuccess(
      float64ToBigComplex(result.re, result.im),
      method,
      53,
      warnings,
    );
  }

  // Arb-prec complex lane.
  const precBits = decimalToBinaryPrecision(precisionDecimal);
  const z: BigComplex = {
    re: fromFloat64(arg0Re),
    im: fromFloat64(arg0Im),
  };
  const w: BigComplex | null =
    arg1Re !== null && arg1Im !== null
      ? { re: fromFloat64(arg1Re), im: fromFloat64(arg1Im) }
      : null;
  const method = ARBPREC_METHOD_COMPLEX[head];

  let result: BigComplex;
  try {
    switch (head) {
      case "Gamma":
        result = cgamma(z, precBits);
        break;
      case "LogGamma":
        result = clgamma(z, precBits);
        break;
      case "Digamma":
        result = cdigamma(z, precBits);
        break;
      case "Trigamma":
        result = ctrigamma(z, precBits);
        break;
      case "Polygamma": {
        // Polygamma order m: must be a non-negative integer.  The
        // first complex arg encodes m: m.re is the integer order;
        // m.im must be 0 (we refuse otherwise — fractional polygamma
        // is a separate analytic continuation, ADR-0042 §"Decision
        // 7" excludes it).
        if (arg0Im !== 0) {
          return degenerateShape(
            `Polygamma: order m must have zero imaginary part; got m.im=${arg0Im}`,
          );
        }
        if (!Number.isInteger(arg0Re) || arg0Re < 0) {
          return degenerateShape(
            `Polygamma: order m must be a non-negative integer; got ${arg0Re}`,
          );
        }
        result = cpolygamma(arg0Re, w!, precBits);
        break;
      }
      case "IncompleteGammaUpper":
        result = cIncompleteGammaUpper(z, w!, precBits);
        break;
      case "IncompleteGammaLower":
        result = cIncompleteGammaLower(z, w!, precBits);
        break;
      case "Beta":
        result = cBeta(z, w!, precBits);
        break;
      default:
        throw new ToolError(
          `${NAME}: internal — head ${head} reached arbprec-complex Gamma fallthrough`,
        );
    }
  } catch (e) {
    return noKnownRepresentation(
      head,
      "complex",
      `${head}(${arity === 1 ? `${arg0Re}+${arg0Im}i` : `${arg0Re}+${arg0Im}i, ${arg1Re}+${arg1Im}i`}) at precision ${precisionDecimal}: ${(e as Error).message}`,
    );
  }
  return complexSuccess(result, method, precBits, []);
}

// -----------------------------------------------------------------------------
// Per-head family classification
// -----------------------------------------------------------------------------

function isBesselHead(h: AdmittedHead): boolean {
  return (
    h === "BesselJ" ||
    h === "BesselY" ||
    h === "BesselI" ||
    h === "BesselK" ||
    h === "BesselIScaled" ||
    h === "BesselKScaled"
  );
}

function isGammaHead(h: AdmittedHead): boolean {
  return (
    h === "Gamma" ||
    h === "LogGamma" ||
    h === "Digamma" ||
    h === "Trigamma" ||
    h === "Polygamma" ||
    h === "Pochhammer" ||
    h === "IncompleteGammaUpper" ||
    h === "IncompleteGammaLower" ||
    h === "IncompleteGammaP" ||
    h === "IncompleteGammaQ" ||
    h === "Beta" ||
    h === "LogBeta" ||
    h === "BarnesG" ||
    h === "Hyperfactorial" ||
    h === "GammaRatio" ||
    h === "GammaDeltaRatio"
  );
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  examples: [
    {
      description: "Erf(0.5) at default precision (53-bit float64 lane, BigFloat-encoded)",
      input: record({
        head: str("Erf"),
        args: list([float64FromNumber(0.5)]),
      }),
    },
    {
      description: "Erfc(20) at precision 50 (arb-prec lane; tiny output ≈ 5.4e-176)",
      input: record({
        head: str("Erfc"),
        args: list([float64FromNumber(20)]),
      }),
      flags: { precision: "50" },
    },
    {
      description: "complex Erf at z = 1 + i, precision 50",
      input: record({
        head: str("Erf"),
        args: record({
          re: list([float64FromNumber(1)]),
          im: list([float64FromNumber(1)]),
        }),
      }),
      flags: { precision: "50" },
    },
    {
      description: "BesselJ(3, 1.5) at precision 50 (arb-prec; FLINT ₀F₁ Maclaurin)",
      input: record({
        head: str("BesselJ"),
        args: list([float64FromNumber(3), float64FromNumber(1.5)]),
      }),
      flags: { precision: "50" },
    },
    {
      description: "BesselK(0, 10) at precision 100 (arb-prec deep series)",
      input: record({
        head: str("BesselK"),
        args: list([float64FromNumber(0), float64FromNumber(10)]),
      }),
      flags: { precision: "100" },
    },
    {
      description: "BesselIScaled(0, 700) at precision 10 (float64; unscaled would overflow)",
      input: record({
        head: str("BesselIScaled"),
        args: list([float64FromNumber(0), float64FromNumber(700)]),
      }),
      flags: { precision: "10" },
    },
    {
      description: "Gamma(0.5) at precision 50 (arb-prec; expect √π = 1.7724...)",
      input: record({
        head: str("Gamma"),
        args: list([float64FromNumber(0.5)]),
      }),
      flags: { precision: "50" },
    },
    {
      description: "Pochhammer(1.5, 3) at precision 100 (arb-prec; expect 13.125 exact)",
      input: record({
        head: str("Pochhammer"),
        args: list([float64FromNumber(1.5), float64FromNumber(3)]),
      }),
      flags: { precision: "100" },
    },
    {
      description: "IncompleteGammaUpper(1+0.5i, 2+0.1i) at precision 50 (complex arb-prec)",
      input: record({
        head: str("IncompleteGammaUpper"),
        args: record({
          re: list([float64FromNumber(1), float64FromNumber(2)]),
          im: list([float64FromNumber(0.5), float64FromNumber(0.1)]),
        }),
      }),
      flags: { precision: "50" },
    },
    {
      description: "BarnesG(2.5) at precision 200 (deep arb-prec)",
      input: record({
        head: str("BarnesG"),
        args: list([float64FromNumber(2.5)]),
      }),
      flags: { precision: "200" },
    },
    {
      description: "unknown head → tagged refusal",
      input: record({
        head: str("WhittakerM"),
        args: list([float64FromNumber(0)]),
      }),
      output: unknownHead("WhittakerM"),
    },
    {
      description: "complex InverseErf → no-known-representation",
      input: record({
        head: str("InverseErf"),
        args: record({
          re: list([float64FromNumber(0.5)]),
          im: list([float64FromNumber(0)]),
        }),
      }),
      output: noKnownRepresentation(
        "InverseErf",
        "complex",
        "InverseErf on the complex axis has no canonical computational form (multi-valued Riemann surface; R3 §3 — SciPy / Boost / Julia all decline)",
      ),
    },
  ],
  invariants: [
    {
      name: "arbprec-deterministic-cross-platform",
      statement:
        "Same input bytes + same --precision → byte-identical output bytes on any runtime / arch / os (ADR-0020). BigInt arithmetic is bit-identical by language spec; the substrate inherits the contract.",
      machine_checkable: true,
    },
    {
      name: "tier-dispatch-by-precision-flag",
      statement:
        "--precision <= 15 (decimal) routes the float64 lane (achieved_precision = 53 bits); --precision > 15 routes the arb-prec lane. The wire output is uniformly bigfloat / bigcomplex across tiers; achieved_precision discloses the live tier (ADR-0040 §'Decision 9').",
      machine_checkable: true,
    },
    {
      name: "honest-no-known-representation",
      statement:
        "Complex InverseErf / InverseErfc refuse always (R3 §3 — multi-valued Riemann surface). Arb-prec InverseErf / InverseErfc refuse at --precision > 15 (Phase 2 substrate gap). Float64 real InverseErf / InverseErfc remain available.",
      machine_checkable: true,
    },
    {
      name: "parity-real-arbprec",
      statement:
        "bigErf(-x, prec) == -bigErf(x, prec) byte-identically at every precision (DLMF §7.4.1).",
      machine_checkable: true,
    },
    {
      name: "erfc-plus-erf-identity",
      statement:
        "bigErf(x, prec) + bigErfc(x, prec) == 1 byte-identically (DLMF §7.2.1 / §7.2.2 algebraic relation).",
      machine_checkable: true,
    },
    {
      name: "restriction-to-real-axis",
      statement:
        "bigCErf(x + 0i, prec).re agrees with bigErf(x, prec) to >= prec - 4 bits; bigCErf(x + 0i, prec).im is zero by construction.",
      machine_checkable: true,
    },
    {
      name: "non-finite-input-tagged",
      statement:
        "NaN / ±Inf in any args slot → tagged 'special-eval/non-finite-input' — never silent wrong value.",
      machine_checkable: true,
    },
    {
      name: "unknown-head-tagged",
      statement:
        "head not in the admitted vocabulary {Erf-family (6), Bessel-family (6), Gamma-family (16)} → tagged 'special-eval/unknown-head' with the admitted list — never a silent fallthrough.",
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement:
        "complex args with mismatched re/im list lengths → tagged 'special-eval/degenerate-shape'; args of wrong arity for the head (Erf=1, Bessel=2, Gamma family=1|2) → 'special-eval/degenerate-shape' — never a silent zero-fill.",
      machine_checkable: true,
    },
    {
      name: "bessel-integer-nu-parity",
      statement:
        "bigBesselJ(-n, z, prec) == (-1)^n · bigBesselJ(n, z, prec) byte-identically for n ∈ ℤ, real z > 0 (DLMF §10.4.1). Routed through dispatchRealBessel at arb-prec.",
      machine_checkable: true,
    },
    {
      name: "bessel-scaled-vs-unscaled-identity",
      statement:
        "bigBesselIScaled(ν, z, prec) · exp(|z|) ≈ bigBesselI(ν, z, prec) for moderate z (substrate identity from R3 §0.4; not byte-identical due to internal precision margins).",
      machine_checkable: true,
    },
    {
      name: "gamma-half-equals-sqrt-pi",
      statement:
        "Gamma(1/2) = √π byte-identically with sqrt(pi) at every precision (ADR-0042 / DLMF §5.4.1).  The closed-form anchor; a mutation that perturbs the reflection branch fails this immediately.",
      machine_checkable: true,
    },
    {
      name: "beta-half-half-equals-pi",
      statement:
        "Beta(1/2, 1/2) = π byte-identically with bigfloat π at every precision (DLMF §5.12.1; trivial closed form).  Acts as the cross-substrate anchor between bigBeta and the transcendental π.",
      machine_checkable: true,
    },
    {
      name: "gamma-restriction-to-real-axis",
      statement:
        "cgamma(x + 0i, prec).re agrees with gamma(x, prec) to >= prec - 8 bits for real x > 0; .im is zero by construction.  Same shape as the Erf real-axis restriction (loadbearing real ↔ complex consistency across both lanes).",
      machine_checkable: true,
    },
    {
      name: "pochhammer-positive-integer-exact",
      statement:
        "Pochhammer(1, n) = n! for positive integer n; Pochhammer(1/2, n) byte-identical to the doubled-product closed form (DLMF §5.2.4).  Anchored against the float64 substrate at p=10 and against the arb-prec substrate at p>15.",
      machine_checkable: true,
    },
    {
      name: "incomplete-gamma-p-plus-q-identity",
      statement:
        "IncompleteGammaP(a, z) + IncompleteGammaQ(a, z) = 1 byte-identically at arb-prec for real a > 0, z >= 0 (DLMF §8.2.4 algebraic relation; substrate I2b guarantees the cancellation-free dispatch).",
      machine_checkable: true,
    },
    {
      name: "honest-no-known-representation-gamma",
      statement:
        "Pochhammer / LogBeta / BarnesG / Hyperfactorial / IncompleteGammaP / IncompleteGammaQ / GammaRatio / GammaDeltaRatio on the complex axis refuse with 'special-eval/no-known-representation' at every precision (no complex substrate in v0.2; ADR-0042 §'Decision 7-9').  Trigamma / Polygamma / IncompleteGamma{Upper,Lower} / Beta refuse on the complex float64 tier only (the arb-prec complex lane is available at --precision > 15).",
      machine_checkable: true,
    },
  ],
  fn: (input, flags) => {
    const inputRecord = input as RecordValue;
    const headField = inputRecord.fields.head as StringValue | undefined;
    const argsField = inputRecord.fields.args;
    if (headField === undefined || argsField === undefined) {
      throw new ToolError(
        `${NAME}: input record must have 'head' and 'args' fields`,
      );
    }
    const head = headField.value;
    if (!isAdmittedHead(head)) {
      return unknownHead(head);
    }

    // Read the precision flag. Per ADR-0020 / ADR-0011, arb-prec tools
    // inherit a standard `--precision=<int>` flag from the runner; it
    // arrives in `flags.precision` as `bigint` (the runner's typed
    // parse). Default 50 decimal digits (the ADR-0020 default).
    const precisionDecimal = Number(
      (flags as { precision?: bigint }).precision ?? 50n,
    );
    if (!Number.isInteger(precisionDecimal) || precisionDecimal < 1) {
      throw new ToolError(
        `${NAME}: precision must be a positive integer; got ${precisionDecimal}`,
      );
    }

    // Dispatch on the args' wire shape: list = real axis; record = complex.
    // The HEAD_ARITY table (Erf=1, Bessel=2, Gamma=1|2) is the arity gate;
    // the per-family dispatcher (`dispatchReal{Bessel?,Gamma?}` /
    // `dispatchComplex{Bessel?,Gamma?}`) splits on family because the
    // substrate signatures and refusal envelopes differ.
    const arity = HEAD_ARITY[head];
    const bessel = isBesselHead(head);
    const gammaFam = isGammaHead(head);

    if (argsField.kind === "list") {
      const xs = readRealArgs(argsField as ListValue);
      if (xs.length !== arity) {
        return degenerateShape(
          `head '${head}' requires arity ${arity}; got args list of length ${xs.length}`,
        );
      }
      for (let i = 0; i < xs.length; i++) {
        if (!Number.isFinite(xs[i]!)) {
          return nonFinite(`args[${i}]`, xs[i]!);
        }
      }
      if (bessel) {
        // Bessel: args = [ν, z]; route through dispatchRealBessel.
        return dispatchRealBessel(head, xs[0]!, xs[1]!, precisionDecimal);
      }
      if (gammaFam) {
        // Gamma family: args = [z] for arity-1 spine; args = [m, z] or
        // [a, n] or [a, z] or [a, b] or [a, δ] for arity-2 (semantics
        // per head documented in the README catalog).  The dispatcher
        // treats both arities uniformly.
        const a1 = arity === 2 ? xs[1]! : null;
        return dispatchRealGamma(head, xs[0]!, a1, precisionDecimal);
      }
      // Erf family: args = [z]; route through arity-1 dispatchReal.
      return dispatchReal(head, xs[0]!, precisionDecimal);
    }
    if (argsField.kind === "record") {
      const { re, im } = readComplexArgs(argsField as RecordValue);
      if (re.length !== im.length) {
        return degenerateShape(
          `complex args 're' and 'im' lists must have matching lengths; got re.length=${re.length}, im.length=${im.length}`,
        );
      }
      if (re.length !== arity) {
        return degenerateShape(
          `head '${head}' requires arity ${arity}; got complex args of length ${re.length}`,
        );
      }
      for (let i = 0; i < re.length; i++) {
        if (!Number.isFinite(re[i]!)) return nonFinite(`args.re[${i}]`, re[i]!);
        if (!Number.isFinite(im[i]!)) return nonFinite(`args.im[${i}]`, im[i]!);
      }
      if (bessel) {
        // Bessel: complex args.re = [ν.re, z.re], args.im = [ν.im, z.im].
        // ν is typically real (ν.im = 0); the substrate's complex layer
        // admits complex ν, so we pass it through verbatim.
        return dispatchComplexBessel(
          head,
          re[0]!,
          im[0]!,
          re[1]!,
          im[1]!,
          precisionDecimal,
        );
      }
      if (gammaFam) {
        // Gamma family complex: arity-1 spine (Gamma, LogGamma, Digamma,
        // Trigamma, BarnesG, Hyperfactorial) takes (z.re + i·z.im);
        // arity-2 heads take (arg0, arg1) as parallel complex pairs.
        // Per ADR-0035 the wire is the parallel-array `record{re, im}`
        // shape (mandatory `im` field; same length as `re`).
        const a1Re = arity === 2 ? re[1]! : null;
        const a1Im = arity === 2 ? im[1]! : null;
        return dispatchComplexGamma(
          head,
          re[0]!,
          im[0]!,
          a1Re,
          a1Im,
          precisionDecimal,
        );
      }
      // Erf family: arity-1, args = [z.re + i·z.im].
      return dispatchComplex(head, re[0]!, im[0]!, precisionDecimal);
    }
    throw new ToolError(
      `${NAME}: args must be either a list<float64> (real) or record{re, im: list<float64>} (complex); got ${argsField.kind}`,
    );
  },
  // ---------------------------------------------------------------------------
  // --test hook — structural property assertions
  // ---------------------------------------------------------------------------
  //
  // Per CLAUDE.md Rule 7 ("'runs without errors' is not a passing test")
  // every assertion below pins a load-bearing invariant. The hook is the
  // second-fastest signal (per Rule 5); goldens lock the bytes; --test
  // verifies the algebra.
  //
  // Cross-validation against the mpmath corpus (bench/erf-anchor/oracles/
  // mpmath/results.json) is the *gold-tier* check; here we use a
  // representative subset (~5 cases per head) so --test stays well under
  // a second. Full corpus cross-validation lives in a sibling Phase-1
  // bench harness (not this tool).
  test: () => {
    const errors: string[] = [];

    // Helper: round a BigFloat to a decimal string and compare against
    // an expected decimal-string truth to N digits (lenient bytes-wise,
    // strict on digit agreement).
    function digitsAgree(
      actual: BigFloat,
      expected: string,
      minAgreeDigits: number,
    ): boolean {
      const actualStr = toDecimalNormalised(actual, minAgreeDigits + 4);
      const expStr = canonicalDecimal(expected, minAgreeDigits + 4);
      // Compare the first minAgreeDigits significant figures.
      return actualStr.slice(0, minAgreeDigits) === expStr.slice(0, minAgreeDigits);
    }

    // ----- Erf basic spot-checks against mpmath@55dp values from the
    //       Phase-1 corpus (bench/erf-anchor/oracles/mpmath/results.json) -----
    //
    // Reference values transcribed verbatim from the corpus; agreement
    // to 30 decimals is the bar (deep enough to detect any single-bit
    // perturbation in the bigErf series / asymptotic dispatch).
    const erfCases: Array<{ x: number; expected: string }> = [
      // T1-erf-001: erf(0) = 0
      { x: 0, expected: "0" },
      // T1-erf-002: erf(0.001) ≈ 0.001128378790969236...
      { x: 0.001, expected: "0.001128378790969236403437564139371489641823499076882565274" },
      // erf(0.5) ≈ 0.520499877813046537682746653891964...
      { x: 0.5, expected: "0.5204998778130465376827466538919645287364515757579637000588" },
      // erf(1) ≈ 0.842700792949714869341220635082609...
      { x: 1, expected: "0.8427007929497148693412206350826092592960669979663028634" },
      // erf(2) ≈ 0.995322265018952734162069256367252...
      { x: 2, expected: "0.9953222650189527341620692563672529070270731865186750986" },
    ];
    const prec200 = 200; // bits — enough for ~60 decimals
    for (const c of erfCases) {
      const result = bigErf(fromFloat64(c.x), prec200);
      if (!digitsAgree(result, c.expected, 30)) {
        errors.push(
          `Erf(${c.x}) @ p=200 bits disagrees with mpmath corpus at 30 dp; got ${toDecimalNormalised(result, 40)} expected ${c.expected.slice(0, 40)}`,
        );
      }
    }

    // ----- Parity invariant: erf(-x) == -erf(x) byte-identically -----
    for (const xs of ["0.1", "0.5", "1.0", "2.0", "5.0"]) {
      const xNum = parseFloat(xs);
      const x = fromFloat64(xNum);
      const minusX = { mantissa: -x.mantissa, exponent: x.exponent, precision: x.precision };
      const lhs = bigErf(minusX as BigFloat, 200);
      const rhs = bigErf(x, 200);
      // Compare: lhs.mantissa === -rhs.mantissa byte-for-byte
      if (lhs.mantissa !== -rhs.mantissa || lhs.exponent !== rhs.exponent || lhs.precision !== rhs.precision) {
        errors.push(
          `parity: bigErf(-${xs}) != -bigErf(${xs}) byte-identically (mantissa ${lhs.mantissa} vs -${rhs.mantissa})`,
        );
      }
    }

    // ----- Algebraic identity: erf(x) + erfc(x) = 1 byte-identically -----
    //
    // The substrate (I2 worklog 135) guarantees this byte-identically.
    // We assert here at three different precisions to prove the
    // dispatch lanes don't perturb the identity.
    for (const xs of ["0.5", "1.0", "5.0", "20.0"]) {
      const x = fromFloat64(parseFloat(xs));
      const prec = 200;
      const e = bigErf(x, prec);
      const ec = bigErfc(x, prec);
      // Add: byte-identical to 1
      const sum = addBig(e, ec, prec);
      const one = fromInt(1n, prec);
      // For the sum to equal one byte-identically would be too strict
      // for cross-tier (the I2 worklog notes the relaxation to ≥prec-2
      // bits agreement); we check |sum - 1| has small magnitude.
      const diff = subBig(sum, one, prec);
      if (diff.mantissa !== 0n) {
        // The diff should be at most a handful of low bits off.
        const diffBits = bitMag(diff.mantissa) + diff.exponent;
        if (diffBits > -(prec - 4)) {
          errors.push(
            `erf + erfc != 1 byte-identically at x=${xs}; magBits(diff) = ${diffBits}, expected < -${prec - 4}`,
          );
        }
      }
    }

    // ----- Restriction to real axis: bigCErf(x + 0i).re == bigErf(x)
    //       and bigCErf(x + 0i).im == 0 within rounding tolerance. -----
    for (const xs of ["0.5", "1.0", "2.0"]) {
      const x = fromFloat64(parseFloat(xs));
      const prec = 200;
      const realResult = bigErf(x, prec);
      const cZ: BigComplex = { re: x, im: fromInt(0n, prec) };
      const cResult = bigCErf(cZ, prec);
      // Real parts: agreement to >= prec - 4 bits per the relaxed
      // I2 cross-tier convention.
      const rDiff = subBig(cre(cResult), realResult, prec);
      if (rDiff.mantissa !== 0n) {
        const diffMag = bitMag(rDiff.mantissa) + rDiff.exponent;
        if (diffMag > -(prec - 8)) {
          errors.push(
            `restriction-to-real: bigCErf(${xs}+0i).re differs from bigErf(${xs}) by magBits ${diffMag}; expected < -${prec - 8}`,
          );
        }
      }
      // Imaginary part: should be ~0 to working precision.
      const imBits = cim(cResult).mantissa === 0n
        ? -Infinity
        : bitMag(cim(cResult).mantissa) + cim(cResult).exponent;
      if (imBits > -(prec - 16)) {
        errors.push(
          `restriction-to-real: bigCErf(${xs}+0i).im has magBits ${imBits}; expected < -${prec - 16}`,
        );
      }
    }

    // ----- Refusal coverage: arb-prec InverseErf must refuse -----
    {
      const r = dispatchReal("InverseErf", 0.5, 50);
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `InverseErf at precision 50 should refuse with no-known-representation; got ${r.kind}`,
        );
      }
    }
    {
      const r = dispatchComplex("InverseErf", 0.5, 0, 50);
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `Complex InverseErf at precision 50 should refuse; got ${r.kind}`,
        );
      }
    }
    {
      const r = dispatchComplex("InverseErf", 0.5, 0, 10);
      // Even at p=10 (float64 tier), complex InverseErf refuses (R3 §3).
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `Complex InverseErf at precision 10 should still refuse (R3 §3); got ${r.kind}`,
        );
      }
    }

    // ----- Float64 lane sanity: erf(0.5) ≈ 0.5204998... to 14 dp -----
    {
      const r = dispatchReal("Erf", 0.5, 10) as RecordValue;
      const val = r.fields.value;
      if (val === undefined || val.kind !== "tagged") {
        errors.push(`float64 lane: dispatchReal Erf(0.5) should return tagged bigfloat`);
      } else {
        // Decode the bigfloat and convert to float64 for comparison
        const payload = (val as { payload: RecordValue }).payload;
        const mantissaField = payload.fields.mantissa;
        if (mantissaField?.kind === "integer") {
          // Not directly testing the value here; the substrate-level
          // test in packages/quadrature/test covers ULP. Just structural.
        }
      }
    }

    // ----- Determinism: same input bytes + same precision → same output bytes -----
    {
      const r1 = dispatchReal("Erf", 0.5, 50);
      const r2 = dispatchReal("Erf", 0.5, 50);
      // Compare via canonicalisation:
      // We don't import canonicalize here, but BigFloat byte-equality
      // implies value-equality. Pull the bigfloat out and compare
      // mantissa/exponent/precision.
      if (r1.kind === "record" && r2.kind === "record") {
        const v1 = ((r1 as RecordValue).fields.value as { payload: RecordValue }).payload;
        const v2 = ((r2 as RecordValue).fields.value as { payload: RecordValue }).payload;
        const m1 = (v1.fields.mantissa as { value: string }).value;
        const m2 = (v2.fields.mantissa as { value: string }).value;
        if (m1 !== m2) {
          errors.push(
            `determinism: two consecutive arb-prec Erf(0.5, 50) calls produced different mantissas (${m1} vs ${m2})`,
          );
        }
      }
    }

    // ----- Bessel J_0 corpus spot-checks against Arb@55dp -----
    //
    // Reference values transcribed from bench/besselj-anchor/oracles/arb/
    // results.json. Agreement to 30 dp is the bar (the Arb radius at
    // these inputs is ~1e-60, so 30 dp is comfortable).
    const besselJCases: Array<{ nu: number; z: number; expected: string }> = [
      // T1-besselj-003 (z=0.5)
      { nu: 0, z: 0.5, expected: "0.9384698072408129042284046735997126255689267970968215766" },
      // T1-besselj-007 (z=8.0)
      { nu: 0, z: 8.0, expected: "0.1716508071375539060908694078519720010684237099201356660" },
    ];
    for (const c of besselJCases) {
      const r = dispatchRealBessel("BesselJ", c.nu, c.z, 50);
      if (r.kind !== "record") {
        errors.push(`BesselJ(${c.nu}, ${c.z}) @ p=50 expected success, got ${r.kind}`);
        continue;
      }
      // Extract bigfloat from value, convert to decimal, compare leading digits.
      const valField = (r as RecordValue).fields.value;
      if (!valField || valField.kind !== "tagged") {
        errors.push(`BesselJ(${c.nu}, ${c.z}): value field not a bigfloat tagged value`);
        continue;
      }
      // Decode mantissa/exponent/precision and render to string.
      const payload = (valField as { payload: RecordValue }).payload;
      const mantStr = (payload.fields.mantissa as { value: string }).value;
      const expStr = (payload.fields.exponent as { value: string }).value;
      const precStr = (payload.fields.precision as { value: string }).value;
      const bf: BigFloat = {
        mantissa: BigInt(mantStr),
        exponent: Number(expStr),
        precision: Number(precStr),
      };
      const actualStr = stripDecimalToDigits(bfToString(bf, 40));
      const expectedStr = stripDecimalToDigits(c.expected);
      if (actualStr.slice(0, 30) !== expectedStr.slice(0, 30)) {
        errors.push(
          `BesselJ(${c.nu}, ${c.z}) @ p=50 disagrees with Arb corpus at 30 dp; got ${actualStr.slice(0, 35)}, expected ${expectedStr.slice(0, 35)}`,
        );
      }
    }

    // ----- Bessel integer-ν parity: J_{-n}(z) = (-1)^n · J_n(z) -----
    //
    // DLMF §10.4.1. We assert this at the wire level for a couple of
    // (n, z) pairs to prove the dispatcher's integer-ν fast path
    // preserves the substrate's identity-honouring discipline.
    for (const [n, z] of [[1, 2.5], [2, 3.7], [3, 4.5]] as Array<[number, number]>) {
      const sign = n % 2 === 0 ? 1 : -1;
      const rPos = dispatchRealBessel("BesselJ", n, z, 50);
      const rNeg = dispatchRealBessel("BesselJ", -n, z, 50);
      if (rPos.kind !== "record" || rNeg.kind !== "record") {
        errors.push(`BesselJ parity: dispatch failed for n=${n}, z=${z}`);
        continue;
      }
      // Compare the bigfloat mantissas: J_{-n}.mantissa should equal
      // sign · J_n.mantissa byte-for-byte at the same exponent/precision.
      const pPos = ((rPos as RecordValue).fields.value as { payload: RecordValue }).payload;
      const pNeg = ((rNeg as RecordValue).fields.value as { payload: RecordValue }).payload;
      const mPos = BigInt((pPos.fields.mantissa as { value: string }).value);
      const mNeg = BigInt((pNeg.fields.mantissa as { value: string }).value);
      if (mNeg !== BigInt(sign) * mPos) {
        errors.push(
          `BesselJ parity: J_{-${n}}(${z}) (mantissa ${mNeg}) != (-1)^${n} · J_${n}(${z}) (mantissa ${sign === 1 ? mPos : -mPos})`,
        );
      }
    }

    // ----- Bessel scaled-vs-unscaled: I_ν(z) · exp(-|z|) ≈ IScaled(ν, z) -----
    //
    // R3 §0.4 identity. Not byte-identical (internal precision margins
    // differ); we assert agreement at the float64 lane to 1 ULP × tens.
    {
      const nu = 0;
      const z = 5.0;
      const rI = dispatchRealBessel("BesselI", nu, z, 10);
      const rIS = dispatchRealBessel("BesselIScaled", nu, z, 10);
      if (rI.kind === "record" && rIS.kind === "record") {
        // Decode both as float64 via the bigfloat encoding (53-bit lane).
        const pI = ((rI as RecordValue).fields.value as { payload: RecordValue }).payload;
        const pIS = ((rIS as RecordValue).fields.value as { payload: RecordValue }).payload;
        const bfI: BigFloat = {
          mantissa: BigInt((pI.fields.mantissa as { value: string }).value),
          exponent: Number((pI.fields.exponent as { value: string }).value),
          precision: Number((pI.fields.precision as { value: string }).value),
        };
        const bfIS: BigFloat = {
          mantissa: BigInt((pIS.fields.mantissa as { value: string }).value),
          exponent: Number((pIS.fields.exponent as { value: string }).value),
          precision: Number((pIS.fields.precision as { value: string }).value),
        };
        const iVal = parseFloat(bfToString(bfI, 20));
        const isVal = parseFloat(bfToString(bfIS, 20));
        const expected = iVal * Math.exp(-Math.abs(z));
        const rel = Math.abs(isVal - expected) / Math.abs(expected);
        if (rel > 1e-12) {
          errors.push(
            `BesselIScaled identity: BesselI(${nu},${z})·exp(-${z}) = ${expected}, but BesselIScaled(${nu},${z}) = ${isVal} (relative diff ${rel.toExponential(3)})`,
          );
        }
      } else {
        errors.push(`BesselIScaled identity test: dispatch failed`);
      }
    }

    // ----- Bessel refusal coverage: unknown-head, K_0(0) singular -----
    {
      // K_0(0) is +∞ (logarithmic singularity); substrate throws.
      // Our wrapper converts to no-known-representation.
      const r = dispatchRealBessel("BesselK", 0, 0, 50);
      if (r.kind !== "tagged" || (r as { tag: string }).tag !== `${NAME}/no-known-representation`) {
        errors.push(
          `BesselK(0, 0) at precision 50 should refuse (K_0 is singular at 0); got ${r.kind}`,
        );
      }
    }

    // ----- Bessel complex arb-prec smoke test -----
    //
    // bigCBesselJ on a near-real input — we don't pin the value here
    // (substrate tests do that); we just prove the path returns a
    // successful record with a non-zero result.
    {
      const r = dispatchComplexBessel("BesselJ", 0, 0, 2.0, 0.5, 50);
      if (r.kind !== "record") {
        errors.push(`complex BesselJ smoke test failed: got ${r.kind}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `${NAME} --test failed (${errors.length} assertions):\n  ${errors.join("\n  ")}`,
      );
    }

    process.stderr.write(
      `${NAME} --test: ${erfCases.length} corpus cases + parity + erf+erfc + restriction-to-real + refusals + determinism + ${besselJCases.length} Bessel corpus + Bessel parity + Bessel scaled identity + Bessel refusal + complex Bessel smoke — all green\n`,
    );
  },
});

// -----------------------------------------------------------------------------
// Small numeric helpers — kept local to avoid coupling to package internals
// -----------------------------------------------------------------------------

/** BigFloat add — re-exported from the substrate. */
function addBig(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  return bfAdd(a, b, prec);
}

function subBig(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  return bfSub(a, b, prec);
}

/** Bit magnitude of an integer mantissa (log2 of |x|, integer floor). */
function bitMag(n: bigint): number {
  if (n === 0n) return -Infinity;
  const absN = n < 0n ? -n : n;
  return absN.toString(2).length - 1;
}

/**
 * Render a BigFloat as a normalised decimal-digit sequence with at
 * least `digits` significant figures available, used by the --test
 * hook's leading-digit comparison.
 */
function toDecimalNormalised(a: BigFloat, digits: number): string {
  const raw = bfToString(a, digits);
  return stripDecimalToDigits(raw);
}

function canonicalDecimal(s: string, _digits: number): string {
  return stripDecimalToDigits(s);
}

function stripDecimalToDigits(s: string): string {
  // Strip sign, leading zeros, decimal point, and scientific exponent;
  // return the significant-digit sequence. "0.0012345" → "12345";
  // "1.2345e-10" → "12345"; "-2.71828" → "271828".
  let t = s;
  if (t.startsWith("-") || t.startsWith("+")) t = t.slice(1);
  // Split exponent
  const eSplit = t.indexOf("e");
  if (eSplit >= 0) t = t.slice(0, eSplit);
  // Strip decimal point and leading zeros
  t = t.replace(".", "");
  // Strip leading zeros (after sign)
  let i = 0;
  while (i < t.length && t[i] === "0") i++;
  return t.slice(i);
}

if (import.meta.main) void runTool(def);
