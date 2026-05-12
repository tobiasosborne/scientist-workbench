// Parser for SDPA-sparse format (.dat-s).
// Reference: Yamashita-Fujisawa-Fukuda-Nakata-Nakata 2003.
// Convention: maximize <C, X> s.t. <A_i, X> = b_i, X = block-diag(X_1, ..., X_nb) ⪰ 0.

export interface SdpaSparseEntry {
  i: number; // 0 = C, 1..m = A_i
  block: number; // 1-indexed
  k: number; // 1-indexed row
  l: number; // 1-indexed col, k <= l
  v: number;
}

export interface SdpaSparseProblem {
  m: number;
  nblocks: number;
  blockSizes: number[]; // positive = PSD block of that size; negative = diagonal (LP) block of |size|
  b: number[];
  entries: SdpaSparseEntry[];
}

export function parseSdpaSparse(text: string): SdpaSparseProblem {
  const lines = text.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length) {
    const ln = (lines[idx] ?? "").trim();
    if (ln.length === 0 || ln.startsWith('"') || ln.startsWith("*")) idx++;
    else break;
  }
  const m = parseInt(stripTrailingComment(lines[idx++] ?? ""), 10);
  const nblocks = parseInt(stripTrailingComment(lines[idx++] ?? ""), 10);
  const sizesLine = stripTrailingComment(lines[idx++] ?? "");
  const blockSizes = sizesLine
    .split(/[\s,{}()]+/)
    .filter((t) => t.length > 0)
    .map((t) => parseInt(t, 10));
  if (blockSizes.length !== nblocks) {
    throw new Error(`SDPA-sparse: nblocks=${nblocks} but parsed ${blockSizes.length} block sizes`);
  }
  const bLine = stripTrailingComment(lines[idx++] ?? "");
  const b = bLine
    .split(/[\s,{}()]+/)
    .filter((t) => t.length > 0)
    .map((t) => parseFloat(t));
  if (b.length !== m) {
    throw new Error(`SDPA-sparse: m=${m} but parsed ${b.length} b values`);
  }
  const entries: SdpaSparseEntry[] = [];
  while (idx < lines.length) {
    const ln = stripTrailingComment(lines[idx++] ?? "").trim();
    if (ln.length === 0) continue;
    const parts = ln.split(/\s+/);
    if (parts.length < 5) continue;
    const i = parseInt(parts[0]!, 10);
    const blk = parseInt(parts[1]!, 10);
    const k = parseInt(parts[2]!, 10);
    const l = parseInt(parts[3]!, 10);
    const v = parseFloat(parts[4]!);
    if (!Number.isFinite(v)) continue;
    entries.push({ i, block: blk, k, l, v });
  }
  return { m, nblocks, blockSizes, b, entries };
}

function stripTrailingComment(s: string): string {
  const i = s.indexOf("=");
  return i >= 0 ? s.slice(0, i) : s;
}
