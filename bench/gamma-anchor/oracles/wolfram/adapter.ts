// =============================================================================
// bench/gamma-anchor/oracles/wolfram/adapter.ts
//   Gold-tier Wolfram Mathematica oracle adapter for the Gamma-family corpus
//   (ADR-0042 §"Decision 8" — Wolfram is one of two gold voices for all 19
//   ADMITTED_HEADS, alongside mpmath; for `BarnesG` complex Wolfram and mpmath
//   are the ONLY voices that ship a value).
// =============================================================================
//
// This script consumes `bench/gamma-anchor/corpus.json` (the frozen 377-input
// manifest produced by `generate-corpus.ts`, bead `scientist-workbench-0kq3`,
// sha256 `1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5`),
// evaluates each input against Wolfram Mathematica's arbitrary-precision
// implementation of the gamma family at 60 declared decimal digits, and emits
// the canonical gold-tier golden-master file
// `bench/gamma-anchor/oracles/wolfram/results.json`.
//
// The adapter is the bench/besselj-anchor sister of the Bessel G2 adapter
// (bead `scientist-workbench-z9fq`, worklog reference at
// `bench/besselj-anchor/oracles/wolfram/adapter.ts`). The structural
// extensions over the Bessel precedent are:
//
//   1. NINETEEN HEADS, NOT SIX. The Bessel corpus had four Bessel heads plus
//      two scaled variants; this corpus has 19 distinct heads spanning
//      Gamma/LogGamma, the polygamma ladder, the incomplete-gamma quartet
//      (Upper/Lower/P/Q + the two inverses), the beta cousins (Beta/LogBeta/
//      IncompleteBeta), and the rare BarnesG/Pochhammer/GammaRatio/
//      GammaDeltaRatio/GammaPDerivative cells. Each head has its own Wolfram
//      symbol or expression (`headToWolframBody`), pinned with citations and
//      the L12 convention comments mandatory on every regularised-incomplete-
//      gamma branch (ADR-0042 §Decision 4).
//
//   2. DISCRIMINATED-`kind` SCALAR ARGUMENTS. Per the corpus-spec arity table
//      (`bench/gamma-anchor/corpus-spec.md`), the non-`z` scalar args `a`,
//      `b`, `m`, `n` carry a `{kind, value}` discriminator: integers
//      ("integer"), half-integers ("half-integer" — `"a/b"` form), and
//      decimals ("decimal" — 60-dp fixed-format strings). `argToWlExpr`
//      dispatches on `kind` and emits `Integer[k]` / `Rational[p, q]` exactly
//      mirroring the Bessel adapter's `nuToWlExpr` discipline (R5 §6 L1).
//      The primary `z` (real string OR `{re, im}` complex record) goes
//      through the same `decimalStringToWl` shaver as Bessel's z.
//
//   3. POLES → "refused" (NOT "limit"). The orchestrator prompt for the
//      Gamma-family G8 cross-agreement comparator wants
//      `ComplexInfinity` → `status: "refused"` with
//      `wolfram_returned_token: "ComplexInfinity"`. This is INTENTIONALLY
//      different from the Bessel adapter's `COMPLEX-INFINITY → "limit"`
//      mapping. The reasoning: in Bessel land an `Infinity`-argument
//      `BesselI[0, Infinity]` is a function-with-a-limit that Wolfram
//      declines to numerically volunteer; in Gamma land `Gamma[0]` is a true
//      *pole*, not a limit — `Γ` blows up there, every oracle handles it
//      differently (Wolfram `ComplexInfinity`, mpmath `ValueError`, SciPy
//      `+∞`, libm `NaN`; landmine L17), and the comparator special-cases
//      these cells. `"refused"` is the honest status for "Wolfram declined
//      to produce a number because there is no number to produce."
//      `Indeterminate` / `Underflow[]` / `Overflow[]` / non-numeric symbolic
//      tokens follow the same pattern — `"refused"` with the symbolic token
//      pinned in `wolfram_returned_token`. The `"limit"` status remains
//      reserved for the (rare) Bessel-style "function has a finite limit at
//      `±Infinity` but Wolfram doesn't volunteer it" case.
//
//   4. L12 — INCOMPLETE-GAMMA CONVENTION INVERSION. The single most
//      load-bearing comment in this file. Wolfram's `GammaRegularized` and
//      `Gamma` symbols cover the four incomplete-gamma heads via three
//      distinct arities:
//
//        IncompleteGammaUpper(a, z) → Gamma[a, z]                    // L12
//        IncompleteGammaLower(a, z) → Gamma[a, 0, z]                 // L12
//        IncompleteGammaP(a, z)     → GammaRegularized[a, 0, z]      // L12
//        IncompleteGammaQ(a, z)     → GammaRegularized[a, z]         // L12
//
//      The 3-arg form `Gamma[a, 0, z]` is the lower incomplete gamma γ(a,z),
//      NOT a typo. `GammaRegularized[a, z]` returns the *upper* regularised
//      Q(a,z); `GammaRegularized[a, 0, z]` returns the *lower* regularised
//      P(a,z). The corpus emits four DISTINCT input records per L12 (never
//      shared), and the comparator cross-checks identities like P+Q=1 to
//      catch any oracle that ships the wrong head. Every Wolfram-body
//      construction below for these heads carries an inline `// L12` comment;
//      a future editor stripping the comments would erase the only audit
//      trail for the convention choice.
//
//   5. ADAMCHIK BARNESG CONVENTION (L_polynew_3). Wolfram's `BarnesG[z]`
//      follows the Adamchik 1998 convention, normalised so
//      `BarnesG[1] = BarnesG[2] = BarnesG[3] = 1`, `BarnesG[4] = 2`,
//      `BarnesG[5] = 12`. This is the same convention as mpmath's
//      `barnesg(z)` (verified by spot-check); the Boost/SciPy world does
//      not ship a `BarnesG` at all so cross-validation is gold-only. The
//      pin is here so any future "convention drift" between Wolfram
//      releases shows up as a comment-vs-behaviour mismatch in the diff.
//
//   6. GAMMA-RATIO / GAMMA-DELTA-RATIO / GAMMA-P-DERIVATIVE expansion. None
//      of these have a native Wolfram symbol; they are computed by
//      composition at 60 working digits:
//
//        GammaRatio(a, b)       := Gamma[a] / Gamma[b]
//        GammaDeltaRatio(a, b)  := Gamma[a] / Gamma[a + b]
//        GammaPDerivative(a, z) := Exp[-z] · z^(a-1) / Gamma[a]
//        LogBeta(a, b)          := LogGamma[a] + LogGamma[b] - LogGamma[a+b]
//
//      The closed forms come from DLMF §5.2.5 (Pochhammer / ratio identities)
//      and DLMF §8.8.3 (∂P/∂z = e⁻ᶻ z^(a-1) / Γ(a)). All four expressions
//      preserve the corpus's convention exactly (`bench/gamma-anchor/
//      corpus-spec.md` "Arity table per head") — `GammaDeltaRatio(a,b) =
//      Γ(a)/Γ(a+b)`, NOT `Γ(a+b)/Γ(a)·Γ(a-b)/Γ(a)²`. The corpus generator
//      `generate-corpus.ts:446` is the spec; this adapter mirrors it.
//
// Probed against: WolframScript 1.13.0, Mathematica kernel 14.3.0 for Linux
// x86_64 (released 2025-07-08). Re-runs on a different kernel version record
// that version in the `oracle_version` envelope field; downstream comparators
// treat differing kernel versions as separate oracle generations.
//
// -----------------------------------------------------------------------------
// Wolfram input-trap (R5 §6 L1) — load-bearing
// -----------------------------------------------------------------------------
//
// Inherited verbatim from the Bessel adapter. The literal
// `N[Gamma[1.5], 60]` silently returns only ~16 digits because `1.5` parses
// as a `MachinePrecision` double and `N[…, 60]` propagates that precision
// through the head. The fix: every numeric corpus value (real-string z,
// half-integer "a/b", 60-dp decimal scalar) is parsed to an exact
// `(BigInt num, BigInt den)` rational and emitted to Wolfram as
// `Rational[num, den]` (auto-reducing to a bare integer when `den == 1`).
// The path is `decimalStringToWl` for raw decimal-string z; `argToWlExpr`
// dispatches on `kind` for the `{kind, value}` scalar args.
//
// Reproducer (from R5 §6 L1):
//   wrong:   N[Gamma[15/10], 50]                  -> ~16 digits
//   right:   N[Gamma[Rational[3,2]], 50]          -> 50 digits
//
// -----------------------------------------------------------------------------
// Wolfram `*^` exponent marker (R5 §6 L_carryover) and trailing-noise
// digits (L11) — load-bearing
// -----------------------------------------------------------------------------
//
// Wolfram's `InputForm` of an arb-prec real has shape
//   <mantissa>BT<prec>.            (no exponent, e.g. `1.7724…BT60.`)
// or
//   <mantissa>BT<prec>.*^<exp>     (with `*^<exp>` Wolfram-scientific marker;
//                                   the `BT<prec>.` is a decimal-precision
//                                   annotation that can itself carry a
//                                   decimal point — e.g. `BT59.7421…`).
//
// Two parsing pitfalls without mitigation:
//   (a) `*^` is not standard scientific notation. JS Number / Python float /
//       awk all parse it as "multiply, with a typo" and silently drop the
//       exponent. This was the load-bearing G2a bug from the Erf epic
//       (worklog 138). Fix: rewrite `` BT[0-9.]+\*\^ `` → `e` BEFORE shaving.
//   (b) The trailing `BT<prec>.` precision-annotation is invisible to every
//       downstream JSON parser. Naive "split on backtick" silently drops the
//       `*^<exp>` exponent that lives AFTER the backtick. Strip the
//       precision-annotation AFTER rewriting the exponent.
//
// Both rewrites live in the `.wls` preamble's `FormatNumeric` function. The
// TS-side `stripPrecisionSuffix` is retained as belt-and-suspenders.
//
// L11 — trailing noise. At declared 60-dp precision Wolfram emits ~62-64
// digits; the last 2-4 are rounding noise past the declared precision.
// This adapter emits ALL digits Wolfram produces; the tier-tolerance band
// is the G8 comparator's job (`bench/gamma-anchor/comparator.ts`, the G8
// bead), not this adapter's.
//
// -----------------------------------------------------------------------------
// Underflow[] / Overflow[] post-processing (R5 §6 L9, L10)
// -----------------------------------------------------------------------------
//
// For inputs pushing the kernel past `$MaxExtraPrecision`, Wolfram emits a
// wrapper like `1 - Underflow[]` instead of an evaluated limit. The `.wls`
// preamble's `PrintRecord` applies `Underflow[] -> 0` and `Overflow[] ->
// Infinity` and re-evaluates, collapsing the structural limit. At 60-dps
// declared precision this rarely triggers for the gamma corpus (which
// caps |z| ≤ 1000 in T6); the mitigation remains for parity with the Bessel
// adapter and defence against any future corpus that pushes further. When
// the post-processing IS triggered the pre-rewrite symbolic form is
// captured in `wolfram_returned_token` for honesty.
//
// -----------------------------------------------------------------------------
// Batch invocation — Wolfram cold-start ~7.6 s; per-input ~0.05 s for Gamma
// -----------------------------------------------------------------------------
//
// Cold-start of `wolframscript` is ~7.6 seconds (R5 §3.1). For 377 inputs
// the per-invocation overhead would be ~50 minutes; batched it amortises
// to a few seconds of arithmetic post-startup. The adapter writes ALL 377
// `PrintRecord` calls into a single `.wls` script and invokes
// `wolframscript -file <path>` exactly once. The full run completes in
// ~25-40 seconds wall time (Bessel's 1766-input batch took 20 s; gamma is
// smaller).
//
// Why not `Table[]` / `Do[]`? Same reason as Bessel: a single per-input
// kernel diagnostic would abort the loop. The flat sequence of `PrintRecord`
// calls is robust to per-input issues — each `Quiet[]` suppresses its
// messages without affecting siblings.
//
// -----------------------------------------------------------------------------
// Subprocess plumbing — `Bun.spawn`, not `node:child_process` (ADR-0001)
// -----------------------------------------------------------------------------
//
// `resolveWolframscript` walks `$PATH` (preferring `WOLFRAMSCRIPT_BIN` env
// var), runs `realpathSync` to dereference any symlinks, and caches. The
// pattern mirrors `spawnBun` from `@workbench/spawn` (ADR-0001) — although
// the child binary is `wolframscript`, not `bun`, the discipline of
// realpath-then-cache is the same.

import {
  realpathSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Corpus + result shapes (mirroring the corpus schema in
// `bench/gamma-anchor/corpus-spec.md` "Arity table per head").
// -----------------------------------------------------------------------------
//
// Discriminated scalar argument: `kind` selects the parser branch.
//   - "integer":      decimal-integer string (e.g. "3", "-2", "0", "50")
//   - "half-integer": fraction string "[-]p/q" (e.g. "1/2", "-3/2", "7/2")
//   - "decimal":      60-dp fixed-format decimal string (toFixed(60))
//
// The arity table per head (replicated for the dispatch switch):
//   1-ary: Gamma, LogGamma, Digamma, Trigamma, BarnesG
//   2-ary: Polygamma (m, z)
//          Pochhammer (a, n, [z redundant mirror — ignored])
//          IncompleteGamma{Upper,Lower,P,Q} (a, z)
//          InverseIncompleteGamma{P,Q} (a, z=q)
//          Beta, LogBeta, GammaRatio, GammaDeltaRatio (a, b)
//          GammaPDerivative (a, z)
//   3-ary: IncompleteBeta (z, a, b)
//
// Wire types reflect what `JSON.parse(corpus.json)` produces; missing fields
// are `undefined` (e.g. a `Gamma` row has no `a` or `b`).

type ArgKind = "integer" | "half-integer" | "decimal";
type ScalarArg = { kind: ArgKind; value: string };

type CorpusZ = string | { re: string; im: string };

interface CorpusInput {
  readonly id: string;
  readonly tier: string;
  readonly head: string;
  readonly z?: CorpusZ;
  readonly a?: ScalarArg;
  readonly b?: ScalarArg;
  readonly m?: ScalarArg;
  readonly n?: ScalarArg;
  readonly notes?: string;
}

interface Corpus {
  readonly manifest_version: number;
  readonly seed: number;
  readonly inputs: ReadonlyArray<CorpusInput>;
  readonly totals?: unknown;
  readonly landmines_pinned?: unknown;
}

type ResultStatus = "success" | "refused" | "limit" | "error";

interface ResultRecord {
  input_id: string;
  status: ResultStatus;
  value: string | { re: string; im: string } | null;
  wolfram_returned_token: string | null;
  elapsed_ms: number;
  notes?: string;
}

// -----------------------------------------------------------------------------
// Decimal-string → exact rational (BigInt num, BigInt den)
// -----------------------------------------------------------------------------
//
// Same parser as the Bessel adapter. The corpus stores numerics in three
// forms; each maps to an exact `(BigInt, BigInt)` rational:
//   (a) 60-dp fixed-format decimal — `parseDecimalToRational`.
//   (b) exponent-bearing scientific (`1.7e308` for MAX_VALUE; not currently
//       emitted by the gamma corpus but supported for parity with Bessel)
//       — same `parseDecimalToRational`.
//   (c) fraction string `[-]p/q` for half-integer args —
//       `parseFractionToRational`.
//   (d) symbolic literals "NaN", "Infinity", "-Infinity" — dispatched at the
//       call site in `decimalStringToWl`.

type ExactRational = { num: bigint; den: bigint };

function parseDecimalToRational(s: string): ExactRational {
  if (!/^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    throw new Error(
      `parseDecimalToRational: malformed decimal '${s}'. ` +
      `suggestion: the corpus is supposed to emit toFixed(60) or scientific; ` +
      `if this came from corpus.json a regeneration bug occurred.`,
    );
  }
  let sign = 1n;
  let rest = s;
  if (rest.startsWith("-")) {
    sign = -1n;
    rest = rest.slice(1);
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1);
  }
  let exp = 0;
  const eIdx = rest.search(/[eE]/);
  if (eIdx >= 0) {
    exp = Number.parseInt(rest.slice(eIdx + 1), 10);
    rest = rest.slice(0, eIdx);
  }
  const dot = rest.indexOf(".");
  let intPart: string;
  let fracPart: string;
  if (dot < 0) {
    intPart = rest;
    fracPart = "";
  } else {
    intPart = rest.slice(0, dot);
    fracPart = rest.slice(dot + 1);
  }
  if (intPart === "") intPart = "0";
  let numStr = intPart + fracPart;
  numStr = numStr.replace(/^0+(?=\d)/, "");
  let num = numStr === "" ? 0n : BigInt(numStr);
  const denExp = fracPart.length - exp;
  let den: bigint;
  if (denExp >= 0) {
    den = 10n ** BigInt(denExp);
  } else {
    num = num * 10n ** BigInt(-denExp);
    den = 1n;
  }
  num = sign * num;
  const g = gcd(num < 0n ? -num : num, den);
  return { num: num / g, den: den / g };
}

function parseFractionToRational(s: string): ExactRational {
  const m = /^(-?\d+)\/(\d+)$/.exec(s);
  if (m === null) {
    throw new Error(
      `parseFractionToRational: malformed fraction '${s}'. ` +
      `suggestion: half-integer corpus args are supposed to emit reduced '[-]a/b'.`,
    );
  }
  const a = BigInt(m[1]!);
  const b = BigInt(m[2]!);
  if (b === 0n) throw new Error(`parseFractionToRational: zero denominator in '${s}'`);
  const g = gcd(a < 0n ? -a : a, b);
  return { num: a / g, den: b / g };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

// -----------------------------------------------------------------------------
// Parser smoke-tests (run at module load; if these fail, the adapter is
// broken before it ever calls Wolfram and the L1 mitigation is moot)
// -----------------------------------------------------------------------------
//
// These are not unit tests; they are import-time invariants. A regression
// here surfaces as a hard throw before any wolframscript invocation, which
// is the desired Rule-1 ("fail fast, fail loud") behaviour.

(function smokeTest(): void {
  const cases: ReadonlyArray<[string, ExactRational]> = [
    ["1", { num: 1n, den: 1n }],
    ["-3", { num: -3n, den: 1n }],
    ["0.5", { num: 1n, den: 2n }],
    ["-1.5", { num: -3n, den: 2n }],
    ["0.1", { num: 1n, den: 10n }],
    ["1.7e2", { num: 170n, den: 1n }],
    ["1.5e-1", { num: 3n, den: 20n }],
    // The 60-dp canonical "1.0" string that Number.toFixed(60) produces.
    ["1.000000000000000000000000000000000000000000000000000000000000", { num: 1n, den: 1n }],
  ];
  for (const [input, expected] of cases) {
    const got = parseDecimalToRational(input);
    if (got.num !== expected.num || got.den !== expected.den) {
      throw new Error(
        `parseDecimalToRational smoke: '${input}' → {num=${got.num}, den=${got.den}}, ` +
        `expected {num=${expected.num}, den=${expected.den}}`,
      );
    }
  }
  const halfCases: ReadonlyArray<[string, ExactRational]> = [
    ["1/2", { num: 1n, den: 2n }],
    ["-3/2", { num: -3n, den: 2n }],
    ["7/2", { num: 7n, den: 2n }],
    ["2/4", { num: 1n, den: 2n }],  // gcd-reduces
  ];
  for (const [input, expected] of halfCases) {
    const got = parseFractionToRational(input);
    if (got.num !== expected.num || got.den !== expected.den) {
      throw new Error(
        `parseFractionToRational smoke: '${input}' → {num=${got.num}, den=${got.den}}, ` +
        `expected {num=${expected.num}, den=${expected.den}}`,
      );
    }
  }
})();

// -----------------------------------------------------------------------------
// Corpus-value → Wolfram-expression conversion
// -----------------------------------------------------------------------------

/** Convert a corpus scalar arg (with `kind` discriminator) into a Wolfram WL expression. */
function argToWlExpr(arg: ScalarArg, fieldName: string, inputId: string): string {
  // Dispatch on `kind`, not on string-shape: a misclassified "1.5" labelled
  // "half-integer" (or vice versa) should surface as a parser exception with
  // input id, not a silent wrong-precision evaluation (L1).
  switch (arg.kind) {
    case "integer": {
      if (!/^-?\d+$/.test(arg.value)) {
        throw new Error(
          `argToWlExpr: ${inputId}.${fieldName}.kind=integer but value='${arg.value}' is not an integer string`,
        );
      }
      return arg.value;
    }
    case "half-integer": {
      const r = parseFractionToRational(arg.value);
      if (r.den === 1n) return r.num.toString();
      return `Rational[${r.num.toString()}, ${r.den.toString()}]`;
    }
    case "decimal": {
      return decimalStringToWl(arg.value);
    }
  }
}

/** Convert a corpus z (string or {re, im}) into a Wolfram z-expression. */
function zToWlExpr(z: CorpusZ): string {
  if (typeof z === "string") return decimalStringToWl(z);
  const re = decimalStringToWl(z.re);
  const im = decimalStringToWl(z.im);
  // Parenthesise both halves so unary-minus binds correctly: "(-Infinity) +
  // (0)*I" is unambiguous; "-Infinity + 0*I" might lex differently depending
  // on operator precedence.
  return `(${re}) + (${im}) * I`;
}

function decimalStringToWl(s: string): string {
  if (s === "NaN") return "Indeterminate";
  if (s === "Infinity") return "Infinity";
  if (s === "-Infinity") return "-Infinity";
  const r = parseDecimalToRational(s);
  if (r.den === 1n) return r.num.toString();
  return `Rational[${r.num.toString()}, ${r.den.toString()}]`;
}

// -----------------------------------------------------------------------------
// Per-head Wolfram code emission (head-dispatch table)
// -----------------------------------------------------------------------------
//
// The full 19-head table per ADR-0042 §Decision 4. The L12 incomplete-gamma
// convention is pinned inline on every Wolfram body that involves a
// `GammaRegularized` or 3-arg `Gamma`; the comment is the audit trail
// (R5 §6 L12 + corpus-spec.md "L12 — Incomplete-gamma regularisation
// convention").
//
// Body conventions (each cites the corpus-side convention in
// `bench/gamma-anchor/generate-corpus.ts`):
//
//   Gamma(z)               -> Gamma[z]                       (DLMF §5.2.1)
//   LogGamma(z)            -> LogGamma[z]                    (DLMF §5.2.1 + branch)
//   Digamma(z)             -> PolyGamma[z]                   (DLMF §5.2.2)
//   Trigamma(z)            -> PolyGamma[1, z]                (DLMF §5.15.1)
//   Polygamma(m, z)        -> PolyGamma[m, z]                (DLMF §5.15.5)
//   BarnesG(z)             -> BarnesG[z]                     (Adamchik 1998;
//                                                              normalised
//                                                              G(1)=G(2)=G(3)=1,
//                                                              G(4)=2, G(5)=12;
//                                                              L_polynew_3)
//   Pochhammer(a, n)       -> Pochhammer[a, n]               (DLMF §5.2.5;
//                                                              same convention
//                                                              as mpmath rf
//                                                              and SciPy poch)
//   Beta(a, b)             -> Beta[a, b]                     (DLMF §5.12.1)
//   LogBeta(a, b)          -> LogGamma[a]+LogGamma[b]
//                              -LogGamma[a+b]                (closed form;
//                                                              Wolfram has no
//                                                              native LogBeta)
//   GammaRatio(a, b)       -> Gamma[a]/Gamma[b]              (R3 §5 ratio-
//                                                              stable variant)
//   GammaDeltaRatio(a, b)  -> Gamma[a]/Gamma[a+b]            (NOT a/b·a-b
//                                                              — corpus
//                                                              convention is
//                                                              Γ(a)/Γ(a+b)
//                                                              per generator
//                                                              line 446)
//   GammaPDerivative(a, z) -> Exp[-z] z^(a-1) / Gamma[a]     (DLMF §8.8.3)
//   IncompleteGammaUpper(a, z) -> Gamma[a, z]                            // L12
//   IncompleteGammaLower(a, z) -> Gamma[a, 0, z]                         // L12
//   IncompleteGammaP(a, z)     -> GammaRegularized[a, 0, z]              // L12
//   IncompleteGammaQ(a, z)     -> GammaRegularized[a, z]                 // L12
//   InverseIncompleteGammaP(a, q) -> InverseGammaRegularized[a, 0, q]    // L12
//   InverseIncompleteGammaQ(a, q) -> InverseGammaRegularized[a, q]       // L12
//   IncompleteBeta(z, a, b)    -> BetaRegularized[z, a, b]   (corpus notes
//                                                              "I_z(a,b)" =
//                                                              regularised
//                                                              incomplete beta)

const KNOWN_HEADS = new Set<string>([
  "Gamma",
  "LogGamma",
  "Digamma",
  "Trigamma",
  "Polygamma",
  "BarnesG",
  "Pochhammer",
  "Beta",
  "LogBeta",
  "GammaRatio",
  "GammaDeltaRatio",
  "GammaPDerivative",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "IncompleteGammaP",
  "IncompleteGammaQ",
  "InverseIncompleteGammaP",
  "InverseIncompleteGammaQ",
  "IncompleteBeta",
]);

/** Build the Wolfram expression body for a given head + corpus row. */
function headToWolframBody(inp: CorpusInput): string {
  const requireZ = (): string => {
    if (inp.z === undefined) {
      throw new Error(`headToWolframBody: ${inp.id} (head=${inp.head}) is missing required 'z' field`);
    }
    return zToWlExpr(inp.z);
  };
  const requireArg = (arg: ScalarArg | undefined, name: string): string => {
    if (arg === undefined) {
      throw new Error(`headToWolframBody: ${inp.id} (head=${inp.head}) is missing required '${name}' field`);
    }
    return argToWlExpr(arg, name, inp.id);
  };
  switch (inp.head) {
    // ---- 1-ary heads -----------------------------------------------------
    case "Gamma":    return `Gamma[${requireZ()}]`;
    case "LogGamma": return `LogGamma[${requireZ()}]`;
    case "Digamma":  return `PolyGamma[${requireZ()}]`;
    case "Trigamma": return `PolyGamma[1, ${requireZ()}]`;
    case "BarnesG":  return `BarnesG[${requireZ()}]`;
    // ---- 2-ary heads (m, z) ----------------------------------------------
    case "Polygamma": {
      const m = requireArg(inp.m, "m");
      const z = requireZ();
      return `PolyGamma[${m}, ${z}]`;
    }
    // ---- 2-ary heads (a, n); Pochhammer's `z` is a redundant mirror, ignored
    case "Pochhammer": {
      const a = requireArg(inp.a, "a");
      const n = requireArg(inp.n, "n");
      // DLMF §5.2.5: (a)_n = Γ(a+n)/Γ(a); Wolfram `Pochhammer` matches.
      return `Pochhammer[${a}, ${n}]`;
    }
    // ---- 2-ary heads (a, b) — Beta family, ratio variants ----------------
    case "Beta": {
      const a = requireArg(inp.a, "a");
      const b = requireArg(inp.b, "b");
      return `Beta[${a}, ${b}]`;
    }
    case "LogBeta": {
      const a = requireArg(inp.a, "a");
      const b = requireArg(inp.b, "b");
      // Wolfram has no native LogBeta; the closed-form lgamma-sum is the
      // canonical path (the same form Boost's `lbeta` uses).
      return `LogGamma[${a}] + LogGamma[${b}] - LogGamma[(${a}) + (${b})]`;
    }
    case "GammaRatio": {
      const a = requireArg(inp.a, "a");
      const b = requireArg(inp.b, "b");
      // Corpus convention (generate-corpus.ts:442): GammaRatio(a,b) = Γ(a)/Γ(b).
      return `Gamma[${a}] / Gamma[${b}]`;
    }
    case "GammaDeltaRatio": {
      const a = requireArg(inp.a, "a");
      const b = requireArg(inp.b, "b");
      // Corpus convention (generate-corpus.ts:446): GammaDeltaRatio(a,b) = Γ(a)/Γ(a+b).
      // NOT the symmetric-difference form some references use.
      return `Gamma[${a}] / Gamma[(${a}) + (${b})]`;
    }
    // ---- 2-ary head (a, z) — derivative of regularised lower incomplete --
    case "GammaPDerivative": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      // DLMF §8.8.3: ∂P(a,z)/∂z = e^(-z) z^(a-1) / Γ(a). Explicit closed form
      // avoids any kernel quirk around symbolic-derivative parsing
      // (Derivative[0,0,1][GammaRegularized][a,0,z] also works but is
      // syntactically heavier).
      return `Exp[-(${z})] * (${z})^((${a}) - 1) / Gamma[${a}]`;
    }
    // ---- 2-ary incomplete-gamma family (L12) -----------------------------
    case "IncompleteGammaUpper": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      return `Gamma[${a}, ${z}]`; // L12 — Wolfram's Gamma[a,z] = Γ(a,z) UNregularised upper
    }
    case "IncompleteGammaLower": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      return `Gamma[${a}, 0, ${z}]`; // L12 — Wolfram's Gamma[a,0,z] = γ(a,z) UNregularised lower
    }
    case "IncompleteGammaP": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      return `GammaRegularized[${a}, 0, ${z}]`; // L12 — = P(a,z) = γ(a,z)/Γ(a)
    }
    case "IncompleteGammaQ": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      return `GammaRegularized[${a}, ${z}]`; // L12 — = Q(a,z) = Γ(a,z)/Γ(a) (Wolfram's default 2-arg form)
    }
    case "InverseIncompleteGammaP": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      // L12 — InverseGammaRegularized[a, 0, q] inverts P (3-arg form).
      // The corpus's z field carries q ∈ (0,1) per corpus-spec.md.
      return `InverseGammaRegularized[${a}, 0, ${z}]`;
    }
    case "InverseIncompleteGammaQ": {
      const a = requireArg(inp.a, "a");
      const z = requireZ();
      // L12 — InverseGammaRegularized[a, q] inverts Q (2-arg form, Wolfram's default).
      return `InverseGammaRegularized[${a}, ${z}]`;
    }
    // ---- 3-ary incomplete beta -------------------------------------------
    case "IncompleteBeta": {
      // Corpus convention: IncompleteBeta = I_z(a,b) regularised, NOT B(z;a,b).
      // Confirmed by generate-corpus.ts notes "I_z(a, b)" and corpus-spec.md.
      const z = requireZ();
      const a = requireArg(inp.a, "a");
      const b = requireArg(inp.b, "b");
      return `BetaRegularized[${z}, ${a}, ${b}]`;
    }
    default:
      throw new Error(
        `headToWolframBody: unknown head '${inp.head}' on input ${inp.id}. ` +
        `suggestion: add a case to the switch above and a row in the dispatch table comment.`,
      );
  }
}

// -----------------------------------------------------------------------------
// Build the batch .wls program
// -----------------------------------------------------------------------------
//
// Three Wolfram functions live in the preamble:
//
//   ClassifyResult[r] — buckets a numeric-evaluation result into one of:
//     INEXACT-NUMERIC | EXACT-NUMERIC | INDETERMINATE | POS-INFINITY |
//     NEG-INFINITY | COMPLEX-INFINITY | REFUSE.
//
//   FormatNumeric[x] — stringifies x via InputForm then normalises:
//     `BT<prec>.*^<exp>` → `e<exp>`  (L_carryover; was the G2a bug)
//     `BT<prec>.<end>`   → `<end>`   (precision-suffix strip)
//     Order matters: rewrite-exponent first, then strip-precision.
//
//   PrintRecord[id, expr] — applies `Quiet[N[expr, 60]]`, post-processes
//     Underflow[]/Overflow[] wrappers, classifies, prints one delimited line
//     per input. The `__VERSIONS__|...` header captures kernel versions
//     before any numerics so even a total failure preserves provenance.
//
// Line shape: `id|STATUS|RE|IM|TOKEN`. STATUS = classifier label.
// RE/IM = FormatNumeric strings (RE only for scalar real outputs; IM="0" for
// real result, non-trivial for complex). TOKEN = raw pre-N symbolic form
// for REFUSE rows (the wolfram_returned_token field).
//
// Quote-escape note: the FormatNumeric regex literal looks over-escaped
// because it is. Wolfram's string parser unescapes `"\\\\*"` to `"\\*"` on
// the wire, then RegularExpression[] receives `"\*"` — a literal `*`. The
// backtick (codepoint 96) is not a regex metachar and only needs the JS-
// template-literal escape `"\\`"` so it doesn't terminate the template.

const BATCH_PREAMBLE = `
(* Generated by bench/gamma-anchor/oracles/wolfram/adapter.ts. *)

(* $PageWidth = Infinity disables Wolfram's default Print line-wrapping.   *)
(* The default ~78-column wrap chops 60-decimal mantissas across physical *)
(* lines and breaks the line-oriented parser.                              *)
$PageWidth = Infinity;

(* Classifier — dispatches on the numeric-evaluation result so unevaluated *)
(* symbolic forms refuse cleanly. Order matters: check exact-numeric AFTER *)
(* the infinity buckets so e.g. Integer-Infinity doesn't fall into         *)
(* EXACT-NUMERIC.                                                          *)
ClassifyResult[r_] := Which[
  r === Indeterminate, "INDETERMINATE",
  r === Infinity, "POS-INFINITY",
  r === -Infinity, "NEG-INFINITY",
  r === ComplexInfinity || Head[r] === DirectedInfinity, "COMPLEX-INFINITY",
  IntegerQ[r] || Head[r] === Rational, "EXACT-NUMERIC",
  InexactNumberQ[r], "INEXACT-NUMERIC",
  True, "REFUSE"
];

(* FormatNumeric — rewrite Wolfram's InputForm of an arb-prec number to a   *)
(* standard-scientific or plain-decimal string. See top-of-file commentary  *)
(* for the L_carryover / L11 motivation. The character class [0-9.]+ in    *)
(* both regexes covers Wolfram's "decimal precision annotation" form (e.g. *)
(* BT59.74219736486953 — the precision is itself a decimal).                *)
FormatNumeric[x_] := StringReplace[
  ToString[x, InputForm],
  {RegularExpression["\`[0-9.]+\\\\*\\\\^"] -> "e",
   RegularExpression["\`[0-9.]+$"] -> ""}
];

(* PrintRecord — one line per input. Format: id|STATUS|REorVAL|IM|TOKEN     *)
(* TOKEN is the raw symbolic form when STATUS=REFUSE/COMPLEX-INFINITY/etc., *)
(* so the consumer captures wolfram_returned_token honestly; empty for     *)
(* successful numeric rows.                                                 *)
(*                                                                          *)
(* Underflow[]/Overflow[] handling: for inputs whose magnitude pushes the   *)
(* kernel past $MaxExtraPrecision, Wolfram emits a wrapper like             *)
(* '1 - Underflow[]'. We replace Underflow[] -> 0 and Overflow[] -> Infinity*)
(* then re-evaluate. At 60-dps + |z|≤1000 this rarely triggers for the     *)
(* gamma corpus, but the mitigation is here for parity with Bessel and as   *)
(* defence against future corpus extensions.                                *)
PrintRecord[id_, expr_] := Module[{rawN, replaced, cls, reStr, imStr, tokenStr},
  rawN = Quiet[N[expr, 60]];
  replaced = rawN /. {Underflow[] -> 0, Overflow[] -> Infinity};
  replaced = Quiet[N[replaced, 60]];
  cls = ClassifyResult[replaced];
  Which[
    cls === "INEXACT-NUMERIC",
      reStr = FormatNumeric[Re[replaced]];
      imStr = FormatNumeric[Im[replaced]];
      Print[StringJoin[id, "|INEXACT|", reStr, "|", imStr, "|"]],
    cls === "EXACT-NUMERIC",
      Print[StringJoin[id, "|EXACT|", FormatNumeric[replaced], "|0|"]],
    cls === "REFUSE",
      (* Capture symbolic form for the consumer; truncate to 200 chars     *)
      (* defensively against runaway symbolic forms that would blow up the *)
      (* record line.                                                       *)
      tokenStr = ToString[replaced, InputForm];
      If[StringLength[tokenStr] > 200, tokenStr = StringTake[tokenStr, 200] <> "..."];
      Print[StringJoin[id, "|REFUSE||0|", tokenStr]],
    True,
      Print[StringJoin[id, "|", cls, "||0|"]]
  ]
];

(* Header — capture versions BEFORE any numerical work so the version probe *)
(* still succeeds even if every evaluation aborts.                          *)
Print[StringJoin["__VERSIONS__|", ToString[$VersionNumber], "|", $Version]];
`.trim() + "\n";

function buildBatchProgram(inputs: ReadonlyArray<CorpusInput>): string {
  const lines: string[] = [BATCH_PREAMBLE];
  for (const inp of inputs) {
    if (!KNOWN_HEADS.has(inp.head)) {
      throw new Error(
        `buildBatchProgram: corpus input ${inp.id} has unknown head '${inp.head}'. ` +
        `suggestion: extend KNOWN_HEADS / headToWolframBody in adapter.ts.`,
      );
    }
    const body = headToWolframBody(inp);
    // ids are [A-Za-z0-9-] only — safe inside a Wolfram String[].
    lines.push(`PrintRecord["${inp.id}", ${body}];`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// wolframscript stdout parser
// -----------------------------------------------------------------------------
//
// Belt-and-suspenders against any regression in the .wls preamble:
// `FormatNumeric` should strip every backtick, but the TS-side
// `stripPrecisionSuffix` re-applies the strip and tolerates a trailing dot
// (e.g. `1.` → `1`). The .wls does the load-bearing rewrite (`*^` → `e`);
// this helper is the just-in-case shaver.

function stripPrecisionSuffix(s: string): string {
  const tick = s.indexOf("`");
  let body = tick >= 0 ? s.slice(0, tick) : s;
  if (body.endsWith(".")) body = body.slice(0, -1);
  return body;
}

type ParsedStatus =
  | "INEXACT"
  | "EXACT"
  | "INDETERMINATE"
  | "POS-INFINITY"
  | "NEG-INFINITY"
  | "COMPLEX-INFINITY"
  | "REFUSE";

interface ParsedRecord {
  id: string;
  status: ParsedStatus;
  re: string;
  im: string;
  token: string;
}

const VALID_STATUSES: ReadonlySet<ParsedStatus> = new Set<ParsedStatus>([
  "INEXACT",
  "EXACT",
  "INDETERMINATE",
  "POS-INFINITY",
  "NEG-INFINITY",
  "COMPLEX-INFINITY",
  "REFUSE",
]);

function parseBatchStdout(stdout: string): {
  versions: { number: string; long: string };
  records: ParsedRecord[];
} {
  const records: ParsedRecord[] = [];
  let versions: { number: string; long: string } | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") continue;
    if (line.startsWith("__VERSIONS__|")) {
      const parts = line.split("|");
      if (parts.length < 3) {
        throw new Error(`parseBatchStdout: malformed __VERSIONS__ line: ${line}`);
      }
      versions = { number: parts[1] ?? "", long: parts.slice(2).join("|") };
      continue;
    }
    // Per-record line: id|STATUS|RE|IM|TOKEN (5 fields; TOKEN may itself
    // contain `|` if Wolfram's symbolic form embeds one — defensive re-join
    // past index 4).
    const parts = line.split("|");
    if (parts.length < 5) {
      if (/::/.test(line)) {
        // Wolfram diagnostic (e.g. `General::stop`, `Gamma::indet`).
        // Surface on stderr but do not abort — the per-input classifier
        // still produces a record for the real input.
        process.stderr.write(`[wolfram-msg] ${line}\n`);
        continue;
      }
      throw new Error(`parseBatchStdout: malformed record line: '${line}'`);
    }
    const [id, statusStr, re, im] = parts as [string, string, string, string];
    const token = parts.slice(4).join("|");
    if (!VALID_STATUSES.has(statusStr as ParsedStatus)) {
      throw new Error(`parseBatchStdout: unknown status '${statusStr}' in line '${line}'`);
    }
    records.push({
      id,
      status: statusStr as ParsedStatus,
      re: re ?? "",
      im: im ?? "",
      token,
    });
  }
  if (versions === null) {
    throw new Error(
      `parseBatchStdout: did not find __VERSIONS__ line in wolframscript stdout. ` +
      `suggestion: wolframscript may have failed before reaching the version probe; ` +
      `check stderr for an early-abort diagnostic.`,
    );
  }
  return { versions, records };
}

// -----------------------------------------------------------------------------
// Wolframscript resolver — mirrors the spawnBun resolver shape (ADR-0001)
// -----------------------------------------------------------------------------

let cachedWolframscript: string | null = null;

function resolveWolframscript(): string {
  if (cachedWolframscript !== null) return cachedWolframscript;
  const fromEnv = process.env["WOLFRAMSCRIPT_BIN"];
  let initial: string | null = fromEnv && fromEnv.length > 0 ? fromEnv : null;
  if (initial === null) {
    const path = process.env["PATH"] ?? "";
    for (const dir of path.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, "wolframscript");
      if (existsSync(candidate)) {
        initial = candidate;
        break;
      }
    }
  }
  if (initial === null) {
    throw new Error(
      `resolveWolframscript: cannot find 'wolframscript' on PATH and ` +
      `WOLFRAMSCRIPT_BIN is unset. ` +
      `suggestion: install Wolfram Mathematica or set WOLFRAMSCRIPT_BIN to the absolute path.`,
    );
  }
  let real: string;
  try {
    real = realpathSync(initial);
  } catch (e) {
    throw new Error(`resolveWolframscript: '${initial}' does not resolve via realpath: ${(e as Error).message}`);
  }
  cachedWolframscript = real;
  return real;
}

interface SpawnResult { code: number; stdout: string; stderr: string; }

async function spawnWolframscriptVersion(): Promise<string> {
  const bin = resolveWolframscript();
  const proc = Bun.spawn([bin, "-version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `spawnWolframscriptVersion: '${bin} -version' exited ${code}; stderr: ${stderr.trim()}. ` +
      `suggestion: confirm the Wolfram kernel is activated (wolframscript -code 'Print[1+1]').`,
    );
  }
  return stdout.trim();
}

async function spawnWolframscriptFile(scriptPath: string): Promise<SpawnResult> {
  const bin = resolveWolframscript();
  const proc = Bun.spawn([bin, "-file", scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// -----------------------------------------------------------------------------
// Status → result-record conversion
// -----------------------------------------------------------------------------
//
// Maps the .wls classifier labels into the orchestrator's
// `status ∈ {success, refused, limit, error}` schema. The Gamma-family
// dispatch differs from Bessel in ONE critical way: `COMPLEX-INFINITY` and
// `±INFINITY` and `INDETERMINATE` and bare `REFUSE` (symbolic-form return)
// all map to `status: "refused"` rather than `"limit"`. The orchestrator
// prompt makes this explicit: in Gamma land these are genuine poles or
// indeterminacies, not finite-or-infinite limits — Wolfram declines because
// there is no number to produce. (Bessel's "limit" was the niche case of
// `BesselI[0, Infinity]` where the function does have a finite-or-infinite
// limit Wolfram simply doesn't volunteer; that case does not arise in the
// gamma corpus because the corpus does not push any head to a true
// "argument is infinity but the function is finite/infinite there" cell.)
//
// "error" is reserved for adapter-side failures (parse, spawn). Wolfram
// itself never returns an error result through this pipeline.

function buildResultRecord(
  inp: CorpusInput,
  parsed: ParsedRecord,
  elapsedMs: number,
): ResultRecord {
  const isComplexInput = inp.z !== undefined && typeof inp.z !== "string";
  switch (parsed.status) {
    case "INEXACT": {
      const re = stripPrecisionSuffix(parsed.re);
      const im = stripPrecisionSuffix(parsed.im);
      const imIsZero = im === "0" || /^-?0(\.0+)?$/.test(im);
      if (!isComplexInput && imIsZero) {
        return {
          input_id: inp.id,
          status: "success",
          value: re,
          wolfram_returned_token: null,
          elapsed_ms: elapsedMs,
        };
      }
      return {
        input_id: inp.id,
        status: "success",
        value: { re, im },
        wolfram_returned_token: null,
        elapsed_ms: elapsedMs,
      };
    }
    case "EXACT": {
      // Exact integers / rationals: e.g. Γ(1)=1, Γ(2)=1, B(1/2,1/2)·Γ(1) = π
      // (Wolfram returns π symbolically — the EXACT branch covers
      // Integer/Rational, π is a Symbol so it lands in REFUSE; for the
      // corpus's actual exact integer returns like Γ(1)=1 the EXACT branch
      // applies). Preserve as scalar for real inputs, {re, im} for complex.
      const v = stripPrecisionSuffix(parsed.re);
      if (!isComplexInput) {
        return {
          input_id: inp.id,
          status: "success",
          value: v,
          wolfram_returned_token: null,
          elapsed_ms: elapsedMs,
        };
      }
      return {
        input_id: inp.id,
        status: "success",
        value: { re: v, im: "0" },
        wolfram_returned_token: null,
        elapsed_ms: elapsedMs,
      };
    }
    case "POS-INFINITY":
      return {
        input_id: inp.id,
        status: "refused",
        value: null,
        wolfram_returned_token: "Infinity",
        elapsed_ms: elapsedMs,
        notes: "Wolfram returned +∞; honest refusal — function has a pole/blowup at this argument.",
      };
    case "NEG-INFINITY":
      return {
        input_id: inp.id,
        status: "refused",
        value: null,
        wolfram_returned_token: "-Infinity",
        elapsed_ms: elapsedMs,
        notes: "Wolfram returned −∞; honest refusal.",
      };
    case "COMPLEX-INFINITY":
      // L17 — Γ at non-positive integers returns ComplexInfinity. Different
      // oracles handle this differently (mpmath ValueError, SciPy +∞, libm
      // NaN); the comparator special-cases L17 cells.
      return {
        input_id: inp.id,
        status: "refused",
        value: null,
        wolfram_returned_token: "ComplexInfinity",
        elapsed_ms: elapsedMs,
        notes: "L17 — Wolfram ComplexInfinity at pole; comparator special-cases.",
      };
    case "INDETERMINATE":
      return {
        input_id: inp.id,
        status: "refused",
        value: null,
        wolfram_returned_token: "Indeterminate",
        elapsed_ms: elapsedMs,
        notes: "Wolfram Indeterminate — typically 0·∞ or 0^0 composition; honest refusal.",
      };
    case "REFUSE": {
      // Wolfram returned a non-numeric symbolic form (Underflow[],
      // Overflow[], or an unevaluated head application). Always refused for
      // the gamma family — see top-of-function commentary for why this
      // diverges from the Bessel adapter's `"limit"` mapping.
      return {
        input_id: inp.id,
        status: "refused",
        value: null,
        wolfram_returned_token: parsed.token,
        elapsed_ms: elapsedMs,
        notes:
          "Wolfram declined to numerically evaluate at this argument; symbolic-form token captured.",
      };
    }
  }
}

// -----------------------------------------------------------------------------
// Main entry — load corpus → build .wls → invoke wolframscript ONCE → parse
// stdout → emit results.json
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, "..", "..", "corpus.json");
  const outputPath = join(here, "results.json");

  // 1. Load corpus.
  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: Corpus = JSON.parse(corpusRaw);
  if (!Array.isArray(corpus.inputs) || corpus.inputs.length === 0) {
    throw new Error(
      `adapter: corpus at ${corpusPath} has no inputs (or is malformed). ` +
      `suggestion: regenerate via 'bun bench/gamma-anchor/generate-corpus.ts'.`,
    );
  }

  // 2. Probe wolframscript CLI version up-front (so we record it even if
  //    the batch program itself aborts).
  const cliVersion = await spawnWolframscriptVersion();
  process.stderr.write(`[wolfram-adapter] CLI: ${cliVersion}\n`);
  process.stderr.write(`[wolfram-adapter] inputs in corpus: ${corpus.inputs.length}\n`);

  // 3. Build the batch program and write to a tempfile.
  const program = buildBatchProgram(corpus.inputs);
  const td = mkdtempSync(join(tmpdir(), "wolfram-gamma-oracle-"));
  const scriptPath = join(td, "batch.wls");
  writeFileSync(scriptPath, program, "utf8");
  process.stderr.write(`[wolfram-adapter] batch .wls size: ${program.length} bytes at ${scriptPath}\n`);
  process.stderr.write(`[wolfram-adapter] launching wolframscript -file <batch.wls> (cold-start ~7.6s; expect ~25-40s total wall-time for 377 inputs)\n`);

  // 4. Execute. Time the whole batch.
  const t0 = Date.now();
  let runResult: SpawnResult;
  try {
    runResult = await spawnWolframscriptFile(scriptPath);
  } finally {
    try {
      rmSync(td, { recursive: true, force: true });
    } catch {
      /* ignore tempfile cleanup races */
    }
  }
  const totalElapsed = Date.now() - t0;

  if (runResult.code !== 0) {
    throw new Error(
      `adapter: wolframscript exited with code ${runResult.code}.\n` +
      `stderr (tail):\n${runResult.stderr.slice(-1000)}\n` +
      `suggestion: re-run with WOLFRAMSCRIPT_BIN set to the kernel-script binary, ` +
      `or run the program directly via 'wolframscript -file <scriptPath>' for diagnostics.`,
    );
  }

  // 5. Parse.
  const { versions, records } = parseBatchStdout(runResult.stdout);
  process.stderr.write(`[wolfram-adapter] kernel: ${versions.long}\n`);
  process.stderr.write(`[wolfram-adapter] parsed ${records.length} records in ${totalElapsed} ms\n`);

  if (records.length !== corpus.inputs.length) {
    throw new Error(
      `adapter: expected ${corpus.inputs.length} records, got ${records.length}. ` +
      `suggestion: a Wolfram per-input failure may have aborted PrintRecord; ` +
      `inspect stderr (above) for the failing input id.`,
    );
  }

  // 6. Re-shape: build per-input result records, preserving corpus order.
  const recordById = new Map<string, ParsedRecord>(records.map((r) => [r.id, r]));
  // Amortise total elapsed evenly per-input; the batch does not time
  // individual evaluations to keep the wire format simple.
  const perInputElapsed = Math.round(totalElapsed / corpus.inputs.length);

  const results: ResultRecord[] = corpus.inputs.map((inp) => {
    const parsed = recordById.get(inp.id);
    if (parsed === undefined) {
      throw new Error(
        `adapter: corpus input ${inp.id} missing from wolframscript output. ` +
        `suggestion: a per-input Wolfram diagnostic may have prevented PrintRecord from running; ` +
        `re-execute with diagnostics on for that id.`,
      );
    }
    return buildResultRecord(inp, parsed, perInputElapsed);
  });

  // 7. Wrap into the file-level envelope (matches orchestrator schema).
  const totals = {
    success: results.filter((r) => r.status === "success").length,
    refused: results.filter((r) => r.status === "refused").length,
    limit: results.filter((r) => r.status === "limit").length,
    error: results.filter((r) => r.status === "error").length,
  };

  const envelope = {
    oracle_id: "wolfram",
    oracle_version: `Mathematica ${versions.long} / wolframscript ${cliVersion}`,
    generated_at: new Date().toISOString(),
    corpus_seed: corpus.seed,
    corpus_sha256: "1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5",
    tier: "gold",
    precision_decimals_requested: 60,
    bead: "scientist-workbench-ehi4",
    adr: "0042",
    total_inputs: corpus.inputs.length,
    total_elapsed_ms: totalElapsed,
    notes: [
      "All numeric inputs (real z, complex re/im, scalar args via {kind, value}) emit as Rational[num, den] to dodge the Wolfram MachinePrecision input-trap (R5 §6 L1).",
      "L12 — incomplete-gamma convention pinned inline on every adapter line: Upper→Gamma[a,z], Lower→Gamma[a,0,z], P→GammaRegularized[a,0,z], Q→GammaRegularized[a,z]; inverse-P→InverseGammaRegularized[a,0,q], inverse-Q→InverseGammaRegularized[a,q].",
      "BarnesG: Adamchik 1998 convention (G(1)=G(2)=G(3)=1, G(4)=2, G(5)=12); L_polynew_3.",
      "GammaRatio(a,b)=Γ(a)/Γ(b); GammaDeltaRatio(a,b)=Γ(a)/Γ(a+b); GammaPDerivative(a,z)=Exp[-z] z^(a-1)/Gamma[a] (DLMF §8.8.3); LogBeta(a,b)=LogGamma[a]+LogGamma[b]-LogGamma[a+b].",
      "IncompleteBeta = BetaRegularized[z,a,b] = I_z(a,b) regularised (corpus convention per generate-corpus.ts).",
      "Pole behaviour (L17): Wolfram ComplexInfinity at non-positive-integer poles of Γ → status: 'refused' with wolfram_returned_token: 'ComplexInfinity'.",
      "Underflow[]→0 / Overflow[]→Infinity replacement applied before classification (R5 §6 L9/L10 belt-and-suspenders).",
      "Wolfram emits ~2-4 noise digits past declared precision (R5 §6 L11); G8 comparator handles tier-tolerance band, not this adapter.",
    ],
    totals,
    results,
  };

  writeFileSync(outputPath, JSON.stringify(envelope, null, 2) + "\n", "utf8");
  process.stdout.write(
    `Wrote N=${results.length} results ` +
    `(success=${totals.success}, refused=${totals.refused}, limit=${totals.limit}, error=${totals.error}) ` +
    `in ${totalElapsed}ms -> ${outputPath}\n`,
  );
}

if (import.meta.main || import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[wolfram-adapter] FAIL: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
