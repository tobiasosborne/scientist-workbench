// =============================================================================
// TraceLog.ts — the JSONL trace-line schema and the external-log parsers
// =============================================================================
//
// Why this file exists
// --------------------
// The solver emits a `VerboseIterLine` per iteration (see `Solver.ts`): a
// strict record where every diagnostic scalar is a real `number` (`NaN` for
// fields the current solver kind does not compute). That type is consumed
// *in-process* — by the `verbose:` callback and by `formatVerboseLine` for
// human-readable console traces.
//
// Separately, the diff harness `scripts/trace-diff.ts` consumes a *persisted*
// JSONL trace. Those JSONL files come from three sources: the solver itself
// (`IPM_TRACE_JSONL=...`), and the two external-solver log parsers below,
// which mirror COPT and Mosek interior-point iteration logs into the same
// shape so a TS trace can be diffed against a reference solver line-by-line.
//
// An external log only exposes a handful of the diagnostic scalars, so the
// persisted schema must permit `null` for every solver-internal field. That
// is a genuinely *different* type from `VerboseIterLine` — a superset — and
// before this module it was hand-maintained as two ~35-field standalone
// interfaces (`CoptIterLine`, `MosekIterLine`) inside the script files. The
// scripts are not in the `tsconfig` `include`, so those interfaces were never
// typechecked: a field added to `VerboseIterLine` drifted all three apart
// silently. ADR-0033 §"Decision 8" calls the field set "a breaking change for
// the diff harness — coordinate"; this module makes "coordinate" a compile
// error instead of a manual chore.
//
// `TraceLine` is now the single JSONL schema. `parseCoptLog` / `parseMosekLog`
// return `TraceLine[]`, so their object literals are checked against it by
// `tsc` (this file lives under `packages/*/src`, which *is* in the include).
// `scripts/{copt,mosek}-log-to-jsonl.ts` shrink to thin CLI shells that import
// these functions — nothing left in them can drift.
//
// The compile-time assertion `_verboseIsTraceLine` below proves the remaining
// direction: every solver-emitted `VerboseIterLine` is assignable to
// `TraceLine` (its fields are stricter, its `kind` union a subset). If either
// type drifts out of the subtype relation the assertion fails to compile.

import type { IterLogLine, VerboseIterLine } from "./Solver.js";

/**
 * The stable JSONL trace-line schema — what `scripts/trace-diff.ts` reads and
 * what every trace producer (the solver, `parseCoptLog`, `parseMosekLog`)
 * writes. A superset of `VerboseIterLine`:
 *
 *   - the seven core IPM scalars (`IterLogLine`) are always real numbers —
 *     every producer, internal or external, has them;
 *   - every solver-internal diagnostic is `number | null` — `null` is the
 *     JSON encoding of "this producer does not expose this field" (and also
 *     the round-trip encoding of the solver's own `NaN`-for-inapplicable);
 *   - `kind` carries the producer tag, including the two external-parser
 *     tags `"copt"` and `"mosek"` that no in-process solver ever emits.
 *
 * `trace-diff.ts` treats `null` as "missing": `null`/`null` agrees,
 * `null`/number is a reported divergence. NaN serialises to `null` through
 * `JSON.stringify`, so the solver's `NaN`-for-inapplicable convention and an
 * external parser's genuine `null` land on the same wire byte — by design.
 */
export interface TraceLine extends IterLogLine {
  kind:
    | "lp"
    | "sdp-nt"
    | "sdp-aho"
    | "sdp-hkm"
    | "lp-hsde"
    | "sdp-hsde-nt"
    | "copt"
    | "mosek";
  // Centering / step
  sigma: number | null;
  sigmaRaw: number | null;
  muAff: number | null;
  alphaPrimal: number | null;
  alphaDual: number | null;
  alphaPrimalRaw: number | null;
  alphaDualRaw: number | null;
  // Regularization (3-way Tikhonov)
  jitterPrimal: number | null;
  jitterDual: number | null;
  jitterGap: number | null;
  bumpsPrimalThisIter: number | null;
  bumpsDualThisIter: number | null;
  bumpsGapThisIter: number | null;
  refactorsThisIter: number | null;
  failRow: number | null;
  // Schur conditioning proxies
  schurDiagMin: number | null;
  schurDiagMax: number | null;
  // SDP-only
  eigMinX: number | null;
  eigMinS: number | null;
  // HSDE-only
  tau: number | null;
  kappa: number | null;
  gfeas: number | null;
  prstatus: number | null;
  // Iterative-refinement counters (HSDE Phase 5)
  nitref1: number | null;
  nitref2: number | null;
  nitref3: number | null;
  // Phase timings (milliseconds)
  tSchurMs: number | null;
  tFactorMs: number | null;
  tDirectionMs: number | null;
  tStepMs: number | null;
}

// Compile-time proof that every solver-emitted `VerboseIterLine` is a valid
// `TraceLine`. `VerboseIterLine`'s fields are strict (`number` where
// `TraceLine` permits `number | null`) and its `kind` union is a strict
// subset of `TraceLine`'s, so this assignment type-checks today; if either
// type drifts out of the subtype relation it fails to compile, and the drift
// surfaces at `bun run check` rather than in a silently-skewed JSONL trace.
const _verboseIsTraceLine: (v: VerboseIterLine) => TraceLine = (v) => v;
void _verboseIsTraceLine;

/**
 * Build a `TraceLine` with the seven core IPM scalars populated and every
 * solver-internal field `null`. The external-log parsers below overwrite the
 * handful of fields their source actually exposes; everything else stays
 * `null` so `trace-diff.ts` skips it.
 */
function externalTraceLine(
  kind: "copt" | "mosek",
  core: IterLogLine,
): TraceLine {
  return {
    ...core,
    kind,
    sigma: null,
    sigmaRaw: null,
    muAff: null,
    alphaPrimal: null,
    alphaDual: null,
    alphaPrimalRaw: null,
    alphaDualRaw: null,
    jitterPrimal: null,
    jitterDual: null,
    jitterGap: null,
    bumpsPrimalThisIter: null,
    bumpsDualThisIter: null,
    bumpsGapThisIter: null,
    refactorsThisIter: null,
    failRow: null,
    schurDiagMin: null,
    schurDiagMax: null,
    eigMinX: null,
    eigMinS: null,
    tau: null,
    kappa: null,
    gfeas: null,
    prstatus: null,
    nitref1: null,
    nitref2: null,
    nitref3: null,
    tSchurMs: null,
    tFactorMs: null,
    tDirectionMs: null,
    tStepMs: null,
  };
}

// A finite decimal / scientific-notation token. Accepts a leading-dot form
// (`.5`) — Mosek occasionally prints one — which is a strict superset of what
// COPT emits, so both parsers share it.
const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseFiniteNumber(tok: string): number | null {
  if (!NUM_RE.test(tok)) return null;
  const x = Number.parseFloat(tok);
  return Number.isFinite(x) ? x : null;
}

/**
 * Drop trace lines whose iteration index is not `prevIter + 1`. Both COPT and
 * Mosek number their iterations contiguously from a single start; a
 * non-contiguous jump after the first row is almost always a spurious token
 * match on some other tabular line (a status table, a DIMACS-error row), so
 * we stop at the first break rather than risk splicing unrelated rows into
 * the trace. Returns the contiguous prefix.
 */
function contiguousPrefix(lines: TraceLine[]): TraceLine[] {
  const out: TraceLine[] = [];
  let prevIter = -1;
  for (const line of lines) {
    if (out.length > 0 && line.iter !== prevIter + 1) break;
    out.push(line);
    prevIter = line.iter;
  }
  return out;
}

// =============================================================================
// COPT
// =============================================================================
//
// Iter-line section of a COPT 8.0.4 solver log (`set Logging 2; optimize` in
// `copt_cmd`). One iter row:
//
//     Iter       Primal.Obj         Dual.Obj      Compl  Primal.Inf  Dual.Inf    Time
//        0  -4.75000000e+00  +0.00000000e+00   5.00e+00    8.12e+00  2.00e+00   0.02s
//
// COPT's printf format is `%4d  %+15.8e  %+15.8e   %8.2e  %10.2e  %8.2e %7s`.
// We tokenise on whitespace rather than fixed columns — COPT pads with
// spaces, so split-on-whitespace is robust to small width drift across
// versions. Verified against probe1.log on COPT 8.0.4 build 20260424.
//
// COPT's default path is non-HSDE (per the COPT-decomp PD_IPM analysis), so
// every HSDE field stays `null`; so do `sigma`, `muAff`, the regularisation
// counters, phase timings, `eigMin{X,S}` and `schurDiag{Min,Max}` — COPT does
// not surface them. `iter`, the primal/dual objectives, `compl`, the
// primal/dual infeasibilities and `timeSec` are the shared cross-checks.

// COPT always suffixes the time token with `s` (`0.02s`).
const COPT_TIME_RE = /^([0-9.]+)s$/;

/** Parse one trimmed COPT log line, or `null` if it is not an iter row. */
function tryParseCoptLine(line: string): TraceLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const toks = trimmed.split(/\s+/);
  if (toks.length !== 7) return null;

  const iterTok = toks[0]!;
  if (!/^\d+$/.test(iterTok)) return null;
  const iter = Number.parseInt(iterTok, 10);

  const nums: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const v = parseFiniteNumber(toks[i]!);
    if (v === null) return null;
    nums.push(v);
  }

  const timeMatch = COPT_TIME_RE.exec(toks[6]!);
  if (timeMatch === null) return null;
  const timeSec = Number.parseFloat(timeMatch[1]!);
  if (!Number.isFinite(timeSec)) return null;

  return externalTraceLine("copt", {
    iter,
    primalObj: nums[0]!,
    dualObj: nums[1]!,
    compl: nums[2]!,
    primalInf: nums[3]!,
    dualInf: nums[4]!,
    timeSec,
  });
}

/**
 * Parse the iter-line section of a COPT solver log into `TraceLine`s.
 * Banner / status / fingerprint lines naturally fail the row shape and are
 * skipped; parsing stops at the first non-contiguous iteration index. Returns
 * `[]` if no iter rows are found — the caller decides whether that is an
 * error.
 */
export function parseCoptLog(text: string): TraceLine[] {
  const candidates: TraceLine[] = [];
  for (const line of text.split("\n")) {
    const parsed = tryParseCoptLine(line);
    if (parsed !== null) candidates.push(parsed);
  }
  return contiguousPrefix(candidates);
}

// =============================================================================
// Mosek
// =============================================================================
//
// Mosek's homogeneous self-dual interior-point iteration table. One iter row:
//
//   ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME
//     0 1.0e+00 2.0e+00 3.0e+00 0.00 -1.0e+00 +0.0e+00 1.0e+00 0.01
//
// Mosek versions differ slightly in spacing and in whether `TIME` carries a
// trailing `s`; this parser tokenises on whitespace and accepts either.
// Non-table lines naturally fail the nine-token shape.
//
// Mosek IS a homogeneous self-dual solver, so unlike COPT it exposes the
// HSDE-relevant `GFEAS` and `PRSTATUS` columns directly — they map onto
// `gfeas` and `prstatus`. Column map:
//
//   PFEAS -> primalInf   DFEAS -> dualInf   GFEAS -> gfeas
//   PRSTATUS -> prstatus  POBJ/DOBJ -> primalObj/dualObj
//   MU -> compl           TIME -> timeSec
//
// `tau` / `kappa` are NOT inferred — Mosek does not print them and a derived
// value would be a guess; they stay `null`, as do all TS-internal fields.
//
// !! FORMAT NOT YET VERIFIED against a real Mosek log. The row shape above is
// the documented Mosek IPM table layout, but the only fixture exercised so
// far was hand-written to match it. Verification against a real Mosek run is
// tracked in bead `scientist-workbench-yyme`; the strict nine-token check
// below at least fails closed (an empty result, surfaced loudly by the CLI)
// rather than silently emitting garbage.

// Mosek's time token may or may not carry a trailing `s`.
const MOSEK_TIME_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)s?$/;

/** Parse one trimmed Mosek log line, or `null` if it is not an iter row. */
function tryParseMosekLine(line: string): TraceLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const toks = trimmed.split(/\s+/);
  if (toks.length !== 9) return null;
  if (!/^\d+$/.test(toks[0]!)) return null;

  const iter = Number.parseInt(toks[0]!, 10);
  const pfeas = parseFiniteNumber(toks[1]!);
  const dfeas = parseFiniteNumber(toks[2]!);
  const gfeas = parseFiniteNumber(toks[3]!);
  const prstatus = parseFiniteNumber(toks[4]!);
  const pobj = parseFiniteNumber(toks[5]!);
  const dobj = parseFiniteNumber(toks[6]!);
  const mu = parseFiniteNumber(toks[7]!);
  const timeMatch = MOSEK_TIME_RE.exec(toks[8]!);
  const timeSec = timeMatch === null ? null : Number.parseFloat(timeMatch[1]!);

  if (
    pfeas === null || dfeas === null || gfeas === null ||
    prstatus === null || pobj === null || dobj === null ||
    mu === null || timeSec === null || !Number.isFinite(timeSec)
  ) {
    return null;
  }

  const traceLine = externalTraceLine("mosek", {
    iter,
    primalObj: pobj,
    dualObj: dobj,
    compl: mu,
    primalInf: pfeas,
    dualInf: dfeas,
    timeSec,
  });
  // Mosek, being an HSDE solver, exposes these two HSDE columns directly.
  traceLine.gfeas = gfeas;
  traceLine.prstatus = prstatus;
  return traceLine;
}

/**
 * Parse Mosek's homogeneous self-dual IPM iteration table into `TraceLine`s.
 * Non-table lines fail the nine-token shape and are skipped; parsing stops at
 * the first non-contiguous iteration index. Returns `[]` if no iter rows are
 * found — the caller decides whether that is an error.
 */
export function parseMosekLog(text: string): TraceLine[] {
  const candidates: TraceLine[] = [];
  for (const line of text.split("\n")) {
    const parsed = tryParseMosekLine(line);
    if (parsed !== null) candidates.push(parsed);
  }
  return contiguousPrefix(candidates);
}
