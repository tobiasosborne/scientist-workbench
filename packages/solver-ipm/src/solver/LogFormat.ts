// Per-iteration log line, fixed-width columns:
//   Iter | Primal.Obj | Dual.Obj | Compl | Primal.Inf | Dual.Inf | Time
//   printf format: "%4d  %+15.8e  %+15.8e   %8.2e  %10.2e  %8.2e %7s"

import type { IterLogLine } from "./Solver.js";

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
