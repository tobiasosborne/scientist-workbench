#!/usr/bin/env python3
# =============================================================================
# scripts/oracles/mosek-sdpa-probe.py — feed an SDPLIB .dat-s file to Mosek
# =============================================================================
#
# Why this exists
# ---------------
# Mosek 11 dropped command-line support for the SDPA-sparse format
# (`mosek.dataformat` no longer lists `sdpa`; the CLI rejects `.dat-s`
# files with `MSK_RES_ERR_MPS_INV_FIELD`). The workbench's sdp-sdplib
# corpus is shipped *in* `.dat-s`, so getting Mosek's iter-by-iter
# trajectory on a corpus problem — the Tier-2 Mosek-comparison oracle for
# the HSDE precision floor (bead `fsr7`) — needs a Python-side bridge.
#
# This script parses an SDPA-sparse file inline, builds the equivalent
# Mosek `Task` via the Python API, runs the interior-point optimizer
# with the verbose log enabled, and writes the log to stdout (or to a
# file, if `--out=<path>` is given). The output is byte-compatible with
# the verbose iter table that `scripts/mosek-log-to-jsonl.ts` expects.
#
# SDPA-sparse refresher
# ---------------------
# The file format is whitespace-separated ASCII:
#
#     <m>                              # number of linear constraints
#     <nblocks>                        # number of (PSD or diagonal) blocks
#     <n_1> <n_2> ... <n_nblocks>      # block sizes; n_b < 0 ⇒ diagonal block
#     <b_1> <b_2> ... <b_m>            # constraint right-hand side
#     <i> <block> <k> <l> <v>          # one entry per remaining row:
#                                       #   i = 0 ⇒ contributes to C
#                                       #   i ∈ 1..m ⇒ contributes to A_i
#                                       # k, l are 1-based row/col within block
#
# Convention (per SDPLIB README): the *primal* form is the MAX side
#
#     max  b^T y
#     s.t. Σ_i y_i A_i^b − C^b ⪯ 0 for each block b
#
# whose Lagrangian dual is the MIN-trace form
#
#     min  Σ_b ⟨C^b, X^b⟩
#     s.t. Σ_b ⟨A_i^b, X^b⟩ = b_i for all i
#          X^b ⪰ 0 for all b.
#
# Mosek's natural API surface matches the *dual* (the `X^b` form) — barvars
# `X^b`, m equality constraints, objective sum of `⟨C^b, X^b⟩` — so we
# minimize and report `dualObj = b^T y` as our "primal" objective at the
# end. This is the same convention `convertSdpaToSdp(..., maximize=true)`
# uses on the TS side, so the two trajectories are directly comparable.
#
# Diagonal blocks (`n_b < 0`) are represented as `|n_b|` nonneg scalar
# slacks. Mosek's barvars are dense PSD matrices, so we lift each scalar
# `s` to a 1×1 PSD block.
#
# Usage
# -----
#
#     PYTHONPATH=~/mosek/11.1/tools/platform/linux64x86/python/3 \
#         python3 scripts/oracles/mosek-sdpa-probe.py \
#         <path.dat-s> [--out=<log path>]
#
# The script writes Mosek's iter log to stdout by default. The exit code
# is 0 on `optimal` / 1 otherwise; the wrapper script in `bash` can
# collect both regardless.

import sys
from pathlib import Path

import mosek


def parse_sdpa_sparse(path: Path):
    """Yield ``(m, blocksizes, b, entries)`` from a `.dat-s` file.

    ``entries`` is a flat list of ``(i, block, k, l, v)`` tuples with `k`,
    `l` already 1-based as in the source file. We don't dedupe (k, l) ↔
    (l, k) symmetric duplicates — Mosek absorbs symmetric duplicates via
    `appendsparsesymmat`, and the file convention is to list each
    off-diagonal once.
    """
    text = path.read_text()
    # Tokenize: SDPA-sparse uses whitespace + commas/braces interchangeably;
    # the corpus files use plain whitespace, but we strip the noise tokens
    # for robustness against the "extended" variant.
    raw = text.replace(",", " ").replace("{", " ").replace("}", " ")
    # Strip comments — '"' or '*' at start of a line is the canonical
    # SDPA-sparse comment marker.
    lines = [ln for ln in raw.splitlines() if not ln.lstrip().startswith(('"', "*"))]
    tokens = " ".join(lines).split()
    cur = 0

    def take(n: int) -> list[str]:
        nonlocal cur
        out = tokens[cur:cur + n]
        cur += n
        return out

    m = int(take(1)[0])
    nblocks = int(take(1)[0])
    blocksizes = [int(x) for x in take(nblocks)]
    b = [float(x) for x in take(m)]
    entries = []
    while cur + 5 <= len(tokens):
        i = int(tokens[cur]); cur += 1
        blk = int(tokens[cur]); cur += 1
        k = int(tokens[cur]); cur += 1
        l = int(tokens[cur]); cur += 1
        v = float(tokens[cur]); cur += 1
        entries.append((i, blk, k, l, v))
    return m, blocksizes, b, entries


def build_and_solve(path: Path) -> int:
    m, blocksizes, b, entries = parse_sdpa_sparse(path)
    nblocks = len(blocksizes)

    # Lift every block to a barvar. Diagonal blocks (negative size) become a
    # PSD block of the same |n|: a diagonal entry is just a (k, k) coord, and
    # the off-diagonal entries that would couple a diagonal block to itself
    # don't exist in SDPA-sparse files (the format gives diagonal blocks at
    # most |n| nonzero entries on the diagonal). Lifting is exact.
    bar_dims = [abs(n) for n in blocksizes]

    with mosek.Env() as env:
        env.set_Stream(mosek.streamtype.log, lambda msg: sys.stdout.write(msg))
        with env.Task(0, 0) as task:
            task.set_Stream(mosek.streamtype.log, lambda msg: sys.stdout.write(msg))
            task.putintparam(mosek.iparam.log, 10)
            # Don't pin `optimizer` — Mosek 11 routes SDP through the `conic`
            # interior-point optimizer; the legacy `intpnt` index (=4) is
            # LP-only here and refuses a problem with PSD bars. Leaving it
            # at the default `free` lets the dispatcher choose `conic`,
            # which is the HSDE IPM whose iter log we want.

            # PSD bars X^1 ... X^nblocks
            task.appendbarvars(bar_dims)
            # m equality constraints (we'll set bounds to ``fx`` = `[b_i, b_i]`)
            task.appendcons(m)
            for i in range(m):
                task.putconbound(i, mosek.boundkey.fx, b[i], b[i])

            # We append the *coefficient matrices* C, A_1..A_m as symmetric
            # sparse matrices into Mosek's matrix store (one append per
            # (i, block) pair that has at least one entry). Each append
            # returns a handle; we attach handles via `putbaraij` /
            # `putbarcj` with coefficient 1.0. Re-using a handle across
            # (i, block) pairs is not needed — they're already block-local.
            by_pair: dict[tuple[int, int], list[tuple[int, int, float]]] = {}
            for i, blk, k, l, v in entries:
                pair = (i, blk - 1)  # 0-based block
                by_pair.setdefault(pair, []).append((k - 1, l - 1, v))  # 0-based k, l

            # Mosek expects the *lower* triangle for symmetric matrices.
            # SDPA-sparse may list either (k, l) or (l, k); we normalize to
            # row ≥ col and dedupe the diagonal.
            for (i, blk_idx), trips in by_pair.items():
                rows, cols, vals = [], [], []
                seen: set[tuple[int, int]] = set()
                for (k, l, v) in trips:
                    r, c = (k, l) if k >= l else (l, k)
                    if (r, c) in seen:
                        # SDPA-sparse files occasionally double-list the
                        # diagonal as `k k v / k k v` for clarity — sum.
                        idx = next(j for j in range(len(rows)) if rows[j] == r and cols[j] == c)
                        vals[idx] += v
                        continue
                    rows.append(r); cols.append(c); vals.append(v)
                    seen.add((r, c))
                mat_idx = task.appendsparsesymmat(bar_dims[blk_idx], rows, cols, vals)
                if i == 0:
                    # Objective coefficient on X^blk_idx
                    task.putbarcj(blk_idx, [mat_idx], [1.0])
                else:
                    task.putbaraij(i - 1, blk_idx, [mat_idx], [1.0])

            # Minimize Σ_b ⟨C^b, X^b⟩ ≡ maximize b^T y on the SDPA primal.
            task.putobjsense(mosek.objsense.minimize)

            task.optimize()
            task.solutionsummary(mosek.streamtype.log)
            sol = task.getsolsta(mosek.soltype.itr)
            return 0 if sol == mosek.solsta.optimal else 1


def main() -> int:
    args = sys.argv[1:]
    out_path: Path | None = None
    positional: list[str] = []
    for a in args:
        if a.startswith("--out="):
            out_path = Path(a[len("--out="):])
        else:
            positional.append(a)
    if len(positional) != 1:
        sys.stderr.write(
            "usage: mosek-sdpa-probe.py <path.dat-s> [--out=<log path>]\n",
        )
        return 2
    in_path = Path(positional[0])

    if out_path is not None:
        with open(out_path, "w") as f:
            saved_stdout = sys.stdout
            sys.stdout = f
            try:
                code = build_and_solve(in_path)
            finally:
                sys.stdout = saved_stdout
        sys.stderr.write(f"wrote Mosek log to {out_path}\n")
        return code
    return build_and_solve(in_path)


if __name__ == "__main__":
    sys.exit(main())
