// Multi-block SDP: maximize <C, X> s.t. <A_i, X> = b_i, X = blockdiag(X_1, ..., X_nb) ⪰ 0.
// Internally we work with `min -<C, X>` to match the LP convention. The
// output objective is flipped back to the SDPA convention by `convertSdpaToSdp`.

import type { SdpaSparseProblem } from "../format/SdpaSparse.js";

export interface SdpBlock {
  size: number;
  C: Float64Array; // n × n row-major (negated for the min form)
  A: Float64Array[]; // length m; each is n × n row-major
}

export interface SdpProblem {
  m: number;
  blocks: SdpBlock[];
  b: Float64Array; // length m
  // For maximize→minimize sign flip: if `maximize` is true, internal C is negated
  // (we minimize internally) and the final objective is negated on output.
  maximize: boolean;
}

export function convertSdpaToSdp(p: SdpaSparseProblem, maximize = true): SdpProblem {
  const blocks: SdpBlock[] = [];
  for (let b = 0; b < p.nblocks; b++) {
    const size = Math.abs(p.blockSizes[b]!);
    blocks.push({
      size,
      C: new Float64Array(size * size),
      A: Array.from({ length: p.m }, () => new Float64Array(size * size)),
    });
  }
  for (const e of p.entries) {
    if (e.block < 1 || e.block > p.nblocks) continue;
    const blk = blocks[e.block - 1]!;
    const n = blk.size;
    const k = e.k - 1;
    const l = e.l - 1;
    if (k < 0 || l < 0 || k >= n || l >= n) continue;
    const M = e.i === 0 ? blk.C : blk.A[e.i - 1]!;
    const sign = maximize && e.i === 0 ? -1 : 1; // flip C if we maximize → internally minimize
    M[k * n + l] = M[k * n + l]! + sign * e.v;
    if (k !== l) M[l * n + k] = M[l * n + k]! + sign * e.v;
  }
  return { m: p.m, blocks, b: Float64Array.from(p.b), maximize };
}
