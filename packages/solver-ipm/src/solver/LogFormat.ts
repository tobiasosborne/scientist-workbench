// Per-iteration log line, fixed-width columns:
//   Iter | Primal.Obj | Dual.Obj | Compl | Primal.Inf | Dual.Inf | Time
//   printf format: "%4d  %+15.8e  %+15.8e   %8.2e  %10.2e  %8.2e %7s"

import type { IterLogLine, VerboseIterLine } from "./Solver.js";

export function formatIterHeader(): string {
  return "Iter       Primal.Obj         Dual.Obj      Compl  Primal.Inf  Dual.Inf    Time";
}

export function formatIterLine(line: IterLogLine): string {
  return (
    pad(String(line.iter), 4) +
    "  " +
    sciSigned(line.primalObj, 8).padStart(15) +
    "  " +
    sciSigned(line.dualObj, 8).padStart(15) +
    "   " +
    sci(line.compl, 2).padStart(8) +
    "  " +
    sci(line.primalInf, 2).padStart(10) +
    "  " +
    sci(line.dualInf, 2).padStart(8) +
    " " +
    formatTime(line.timeSec).padStart(7)
  );
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function sciSigned(x: number, prec: number): string {
  if (!Number.isFinite(x)) return x.toString();
  const sign = x >= 0 ? "+" : "-";
  return sign + Math.abs(x).toExponential(prec);
}

function sci(x: number, prec: number): string {
  if (!Number.isFinite(x)) return x.toString();
  return x.toExponential(prec);
}

function formatTime(t: number): string {
  return t.toFixed(2) + "s";
}

/**
 * One-line human-readable rendering of a `VerboseIterLine`. The schema
 * is JSONL-stable; this is the readable lens over it for the
 * eager-flush stderr trace from `tools/{lp,sdp}-solve`. Single line per
 * iter, multi-column, greppable. SDP-only and LP-only fields render as
 * `nan` for the irrelevant solver kind — that's the price of one
 * unified schema and is intentional.
 *
 * Field abbreviations:
 *   pObj/dObj — primal/dual objective       μ      — complementarity (mu)
 *   pInf/dInf — primal/dual ∞-norm residual σ      — Mehrotra centering
 *   α=(p,d)   — step lengths (post-safeguard) μAff  — predicted μ at affine step
 *   reg=(p,d,g) — cumulative δ_p,δ_d,δ_g       bumps — per-iter (delta)
 *   refac     — factorisations this iter (1 = clean, >1 = retried)
 *   fail      — most-recent Cholesky failRow (null = clean)
 *   Mdiag     — Schur diagonal [min,max] pre-lift
 *   eig(X,S)  — min eigenvalue across blocks (SDP only)
 *   t=Δms     — phase timings: S=Schur F=Factor D=Direction ST=Step
 */
export function formatVerboseLine(v: VerboseIterLine): string {
  const parts: string[] = [];
  parts.push(`iter=${pad(String(v.iter), 3)}`);
  parts.push(`[${v.kind}]`);
  parts.push(`pObj=${sciSigned(v.primalObj, 3)}`);
  parts.push(`dObj=${sciSigned(v.dualObj, 3)}`);
  parts.push(`μ=${sci(v.compl, 2)}`);
  parts.push(`pInf=${sci(v.primalInf, 2)}`);
  parts.push(`dInf=${sci(v.dualInf, 2)}`);
  parts.push(`σ=${num(v.sigma, 3)}`);
  parts.push(`μAff=${sci(v.muAff, 2)}`);
  parts.push(`α=(${num(v.alphaPrimal, 3)},${num(v.alphaDual, 3)})`);
  parts.push(`reg=(${sci(v.jitterPrimal, 1)},${sci(v.jitterDual, 1)},${sci(v.jitterGap, 1)})`);
  parts.push(`bumps=(${v.bumpsPrimalThisIter},${v.bumpsDualThisIter},${v.bumpsGapThisIter})`);
  parts.push(`refac=${v.refactorsThisIter}`);
  parts.push(`fail=${v.failRow === null ? "-" : v.failRow}`);
  parts.push(`Mdiag=[${sci(v.schurDiagMin, 2)},${sci(v.schurDiagMax, 2)}]`);
  if (v.kind !== "lp") {
    parts.push(`eigX=${sci(v.eigMinX, 2)}`);
    parts.push(`eigS=${sci(v.eigMinS, 2)}`);
  }
  parts.push(
    `t=${v.timeSec.toFixed(2)}s` +
    `(S=${v.tSchurMs.toFixed(1)} F=${v.tFactorMs.toFixed(1)} ` +
    `D=${v.tDirectionMs.toFixed(1)} ST=${v.tStepMs.toFixed(1)})`,
  );
  return parts.join(" ");
}

function num(x: number, prec: number): string {
  if (!Number.isFinite(x)) return x.toString();
  return x.toFixed(prec);
}
