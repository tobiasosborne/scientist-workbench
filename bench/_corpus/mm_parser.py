"""Matrix Market format parser — minimal, just enough for harwell-boeing.

Supports:
  - %%MatrixMarket matrix coordinate real symmetric
  - %%MatrixMarket matrix coordinate real general
  - %%MatrixMarket matrix array real general (rare in HB)

Returns a dense numpy array. For symmetric inputs, the lower triangle in
the file is mirrored to the upper triangle on read.

Usage:
    A = read_mm("/path/to/bcsstk01.mtx.gz")  # transparently un-gzips

The harwell-boeing collection is public domain; we commit small files
into the repo under bench/_corpus/harwell-boeing/.
"""

from __future__ import annotations

import gzip
from pathlib import Path
from typing import IO

import numpy as np


def _open_maybe_gz(path: str | Path) -> IO[str]:
    p = Path(path)
    if p.suffix == ".gz":
        return gzip.open(p, "rt")
    return open(p, "rt")


def read_mm(path: str | Path) -> np.ndarray:
    """Read a Matrix Market file (optionally gzipped) into a dense ndarray."""
    with _open_maybe_gz(path) as f:
        header = f.readline().strip()
        if not header.startswith("%%MatrixMarket"):
            raise ValueError(f"not a Matrix Market file: header={header!r}")
        parts = header.split()
        if len(parts) < 5:
            raise ValueError(f"malformed header: {header!r}")
        _mm, kind, fmt, dtype, sym = parts[:5]
        if kind != "matrix":
            raise NotImplementedError(f"only 'matrix' kind supported, got {kind!r}")
        if dtype != "real":
            raise NotImplementedError(f"only 'real' values supported, got {dtype!r}")

        # Skip comments + blank lines
        while True:
            line = f.readline()
            if not line:
                raise ValueError("unexpected EOF before size line")
            stripped = line.strip()
            if stripped and not stripped.startswith("%"):
                break

        if fmt == "coordinate":
            tokens = stripped.split()
            if len(tokens) != 3:
                raise ValueError(f"expected 'rows cols nnz' size line, got: {stripped!r}")
            rows, cols, nnz = (int(t) for t in tokens)
            A = np.zeros((rows, cols), dtype=np.float64)
            count = 0
            for line in f:
                line = line.strip()
                if not line or line.startswith("%"):
                    continue
                parts = line.split()
                if len(parts) != 3:
                    raise ValueError(f"malformed coord line: {line!r}")
                i = int(parts[0]) - 1
                j = int(parts[1]) - 1
                v = float(parts[2])
                A[i, j] = v
                if sym == "symmetric" and i != j:
                    A[j, i] = v
                elif sym == "skew-symmetric" and i != j:
                    A[j, i] = -v
                count += 1
            if count != nnz:
                raise ValueError(f"expected {nnz} entries, read {count}")
            return A

        elif fmt == "array":
            tokens = stripped.split()
            if len(tokens) != 2:
                raise ValueError(f"expected 'rows cols' size line, got: {stripped!r}")
            rows, cols = (int(t) for t in tokens)
            A = np.zeros((rows, cols), dtype=np.float64)
            # Column-major dump: read rows*cols values.
            vals: list[float] = []
            for line in f:
                line = line.strip()
                if not line or line.startswith("%"):
                    continue
                vals.append(float(line))
            if len(vals) != rows * cols:
                raise ValueError(f"expected {rows*cols} values, read {len(vals)}")
            for c in range(cols):
                for r in range(rows):
                    A[r, c] = vals[c * rows + r]
            if sym == "symmetric":
                # Mirror upper from lower (or vice versa, doesn't matter for symmetric).
                A = np.triu(A) + np.triu(A, 1).T
            return A

        raise NotImplementedError(f"format {fmt!r} not supported")


# ─── corpus catalog ──────────────────────────────────────────────────────────
#
# Curated subset of harwell-boeing dense-friendly matrices. n is the
# matrix dimension; type indicates structural property; provenance is
# the canonical source citation.
#
# All entries are public-domain test matrices used by the wider
# numerical-computing community since the 1980s.

HARWELL_BOEING_SUBSET = [
    # name      size   type              source domain
    ("bcsstk01",  48, "spsd",  "small structural matrix (Harwell-Boeing BCSSTRUC1)"),
    ("bcsstk02",  66, "spsd",  "Steel mass-stiffness (Harwell-Boeing BCSSTRUC1)"),
    ("bcsstk03", 112, "spsd",  "Module of an off-shore platform (Harwell-Boeing)"),
    ("bcsstk04", 132, "spsd",  "Calahan structure (Harwell-Boeing)"),
    ("bcsstk05", 153, "spsd",  "Transmission tower (Harwell-Boeing)"),
]


def load_harwell_boeing(name: str, corpus_dir: Path) -> np.ndarray:
    """Load a named harwell-boeing matrix from the local corpus mirror."""
    path = corpus_dir / f"{name}.mtx.gz"
    if not path.exists():
        raise FileNotFoundError(
            f"corpus matrix {name!r} not found at {path}; "
            f"download via: curl -sL https://math.nist.gov/pub/MatrixMarket2/Harwell-Boeing/bcsstruc1/{name}.mtx.gz -o {path}"
        )
    return read_mm(path)


if __name__ == "__main__":
    # Smoke test — load each subset entry and print shape + condition.
    import sys

    here = Path(__file__).resolve().parent
    for name, expected_n, *_ in HARWELL_BOEING_SUBSET:
        try:
            A = load_harwell_boeing(name, here / "harwell-boeing")
        except FileNotFoundError as e:
            print(f"  SKIP  {name}: {e}", file=sys.stderr)
            continue
        cond = float(np.linalg.cond(A))
        rank = int(np.linalg.matrix_rank(A))
        print(f"  {name}: shape={A.shape}, cond={cond:.2e}, rank={rank} (expected_n={expected_n})")
