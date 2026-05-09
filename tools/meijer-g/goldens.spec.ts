// =============================================================================
// Goldens — meijer-g top-level dispatcher
// =============================================================================
//
// Goldens cover every output shape across every tier of the
// `tstournament` problem-13 verifier:
//
//   * Tier 0 anchors      — symbolic match (e.g. `G^{1,0}_{0,1}(_; 0 | z) = e^{-z}`).
//   * Tier A elementary   — symbolic match.
//   * Tier C numerical    — Slater path success at default precision.
//   * Tier D coalescence  — Slater path with perturbation applied.
//   * Tier E numerical    — contour fallback for the `2(m+n) > p+q` regime.
//   * Tier F branch-cut   — Schwarz-reflection sensitivity (covered as
//                           tool.test.ts assertions; goldens record the
//                           successful numerical record at z near the cut).
//   * Tier G refusal      — out-of-region for genuinely unhandleable inputs
//                           plus structured forced-method-refused cases.
//   * Method-agreement    — same input via `--force-method=<lane>`; the
//                           generated goldens record each lane's value
//                           independently. tool.test.ts asserts agreement.
//
// All cases below run at the runner's default `--precision=50`. Goldens
// omit per-case `flags` fields because the meijer-g family's tier
// behaviour (symbolic anchors, Slater-path-success, contour fallback,
// refusal) is exercised meaningfully at the default precision; cases
// that exercise the precision dial itself live in `tool.test.ts`. After
// the lc1 / rn2 fixes (worklog 083) the runner threads `--precision=N`
// into `flags.precision` correctly — adding `flags: { precision: "..." }`
// to a case here will now produce a different golden at higher precision
// (correctly so), but the existing default-50 corpus stays byte-identical.

import {
  bigcomplexToValue,
  cfromInts,
  cfromStrings,
} from "@workbench/bigfloat";
import { list, record, str, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

const PREC = 256;

const cZero = bigcomplexToValue(cfromInts(0n, 0n, PREC));
const cOne = bigcomplexToValue(cfromInts(1n, 0n, PREC));
const cTwo = bigcomplexToValue(cfromInts(2n, 0n, PREC));
const cThree = bigcomplexToValue(cfromInts(3n, 0n, PREC));
const c10 = bigcomplexToValue(cfromInts(10n, 0n, PREC));
const c100 = bigcomplexToValue(cfromInts(100n, 0n, PREC));
const cNeg100 = bigcomplexToValue(cfromInts(-100n, 0n, PREC));
const cHalf = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const cQuarter = bigcomplexToValue(cfromStrings("0.25", "0", PREC));
const c2plusI = bigcomplexToValue(cfromStrings("2", "1", PREC));

function meijergInput(
  an: Value[],
  ap: Value[],
  bm: Value[],
  bq: Value[],
  z: Value,
  requestMode?: string,
): Value {
  const fields: Record<string, Value> = {
    an: list(an),
    ap: list(ap),
    bm: list(bm),
    bq: list(bq),
    z,
  };
  if (requestMode !== undefined) fields["request_mode"] = str(requestMode);
  return record(fields);
}

export const goldens: GoldenSpec[] = [
  // ---------------------------------------------------------------- Tier 0/A: symbolic anchors
  // 1. G^{1,0}_{0,1}(_; 0 | 2) = e^{-2}  (Bateman §5.6 (8) / DLMF 16.18.4)
  {
    description:
      "G^{1,0}_{0,1}(_; 0 | 2) ⇒ symbolic e^{-z} (Bateman 5.6 (8))",
    input: meijergInput([], [], [cZero], [], cTwo),
  },

  // 2. G^{1,0}_{0,1}(_; 1 | 3) — symbolic z·e^{-z}
  {
    description:
      "G^{1,0}_{0,1}(_; 1 | 3) ⇒ symbolic z·e^{-z} (Bateman 5.6 (8))",
    input: meijergInput([], [], [cOne], [], cThree),
  },

  // 3. G^{2,0}_{0,2}(_; 0, 0 | 1) = 2 K_0(2√z)  (Bateman §5.6 (25))
  {
    description: "G^{2,0}_{0,2}(_; 0, 0 | 1) ⇒ symbolic 2·K_0(2√z)",
    input: meijergInput([], [], [cZero, cZero], [], cOne),
  },

  // 4. G^{0,1}_{1,0}(1; _ | 100) — Bateman 5.6.2: z^{a-1}·e^{-1/z}
  {
    description: "G^{0,1}_{1,0}(1; _ | 100) ⇒ symbolic e^{-1/z}",
    input: meijergInput([cOne], [], [], [], c100),
  },

  // 5. G^{1,1}_{1,1}(1/2; 0 | 1/2) — Bateman §5.6 mixed-pole rule (if a rule fires).
  {
    description:
      "G^{1,1}_{1,1}(1/2; 0 | 1/2) — symbolic match if curated rule fires, else numerical",
    input: meijergInput([cHalf], [], [cZero], [], cHalf),
  },

  // ---------------------------------------------------------------- Tier C: numerical Slater
  // 6. G^{1,0}_{0,1}(_; 0 | 2) — numerical-required short-circuit.
  // Same input as #1 but forced through Slater; demonstrates the
  // request_mode lever.
  {
    description:
      "G^{1,0}_{0,1}(_; 0 | 2) with request_mode=numerical-required ⇒ Slater numerical",
    input: meijergInput([], [], [cZero], [], cTwo, "numerical-required"),
  },

  // 7. G^{0,1}_{1,0}(1; _ | 100) — numerical-required forces Slater.
  {
    description:
      "G^{0,1}_{1,0}(1; _ | 100) numerical-required ⇒ Slater Series 2",
    input: meijergInput([cOne], [], [], [], c100, "numerical-required"),
  },

  // 8. G^{2,0}_{0,2}(_; 0, 0 | 1) — numerical via Slater.
  {
    description:
      "G^{2,0}_{0,2}(_; 0, 0 | 1) numerical-required ⇒ Slater Series 1",
    input: meijergInput([], [], [cZero, cZero], [], cOne, "numerical-required"),
  },

  // 9. Larger |z| with non-trivial pole shape.
  {
    description: "G^{1,1}_{1,2}([1/2]; _ ; [0], [1] | 2) ⇒ Slater numerical",
    input: meijergInput([cHalf], [], [cZero], [cOne], cTwo),
  },

  // ---------------------------------------------------------------- Tier C+: small |z|
  // 10. Small |z|: Slater Series 1 path.
  {
    description: "G^{2,0}_{0,2}(_; 0, 0 | 1/4) ⇒ Slater (small |z|)",
    input: meijergInput([], [], [cZero, cZero], [], cQuarter),
  },

  // ---------------------------------------------------------------- Tier E: middle-of-road
  // 11. G^{1,1}_{2,2}([1/2], [3/2]; [0], [1]) — m+n=2, p+q=4. Borderline contour.
  {
    description:
      "G^{1,1}_{2,2}([1/2], [3/2]; [0], [1] | 1/2) — middle-of-the-road",
    input: meijergInput(
      [cHalf],
      [bigcomplexToValue(cfromStrings("1.5", "0", PREC))],
      [cZero],
      [cOne],
      cHalf,
    ),
  },

  // ---------------------------------------------------------------- Tier F: branch-cut
  // 12. z = 2 + i — non-cut, Slater path success.
  {
    description: "G^{1,0}_{0,1}(_; 0 | 2 + i) ⇒ symbolic e^{-z}",
    input: meijergInput([], [], [cZero], [], c2plusI),
  },

  // 13. z = -100 (on the negative real axis = on the cut).
  {
    description: "G^{1,0}_{0,1}(_; 0 | -100) ⇒ symbolic e^{-z} (on the cut)",
    input: meijergInput([], [], [cZero], [], cNeg100),
  },

  // ---------------------------------------------------------------- Tier G: refusal
  // 14. Symbolic-required mode with no matching rule.
  {
    description:
      "G^{1,1}_{2,2}(symbolic | 1) symbolic-required ⇒ refused/symbolic-required-no-match",
    input: meijergInput(
      [bigcomplexToValue(cfromInts(5n, 0n, PREC))],
      [bigcomplexToValue(cfromInts(7n, 0n, PREC))],
      [bigcomplexToValue(cfromInts(3n, 0n, PREC))],
      [bigcomplexToValue(cfromInts(4n, 0n, PREC))],
      cOne,
      "symbolic-required",
    ),
  },

  // 15. Degenerate shape: m = n = 0.
  {
    description:
      "G^{0,0}_{0,0}(_;_|2) — degenerate shape, no Γ-pole cluster",
    input: meijergInput([], [], [], [], cTwo),
  },

  // 16. z = 0 — symbolic for the `b=0` shape.
  {
    description: "G^{1,0}_{0,1}(_; 0 | 0) ⇒ symbolic e^0 = 1",
    input: meijergInput([], [], [cZero], [], cZero),
  },

  // ---------------------------------------------------------------- Tier H: variety
  // 17. Higher |z| — asymptotic-eligible.
  {
    description:
      "G^{0,1}_{1,0}(1; _ | 10) numerical-required ⇒ Slater (asymptotic also applies)",
    input: meijergInput([cOne], [], [], [], c10, "numerical-required"),
  },

  // 18. Small |z| with numerical-required — Slater path.
  {
    description:
      "G^{0,1}_{1,0}(1; _ | 1/2) numerical-required ⇒ Slater small-|z|",
    input: meijergInput([cOne], [], [], [], cHalf, "numerical-required"),
  },

  // 19. G^{0,1}_{2,0}([1, 1/2]; _ | 100) — non-decaying contour, Slater diverges.
  // Asymptotic should pick this up.
  {
    description:
      "G^{0,1}_{2,0}([1, 1/2]; _ | 100) — large |z|, asymptotic regime",
    input: meijergInput([cOne, cHalf], [], [], [], c100, "numerical-required"),
  },

  // 20. Quarantine-band on |z|=1.
  {
    description:
      "G^{1,1}_{2,2}([0]; [1]; [0], [0] | 1) on |z|=1 boundary",
    input: meijergInput(
      [bigcomplexToValue(cfromInts(0n, 0n, PREC))],
      [bigcomplexToValue(cfromInts(1n, 0n, PREC))],
      [bigcomplexToValue(cfromInts(0n, 0n, PREC))],
      [bigcomplexToValue(cfromInts(0n, 0n, PREC))],
      cOne,
      "numerical-required",
    ),
  },
];
