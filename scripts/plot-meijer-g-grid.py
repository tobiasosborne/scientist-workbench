#!/usr/bin/env python3
# =============================================================================
# plot-meijer-g-grid.py — render the TSV from plot-meijer-g-grid.ts as PNG
# =============================================================================
#
# Reads the TSV produced by `bun scripts/plot-meijer-g-grid.ts` on stdin
# and writes a four-panel PNG to the path given as the sole CLI argument
# (default: meijer-g-grid.png).
#
# Panels:
#   1. |G(z)|              — magnitude heatmap (linear)
#   2. arg G(z)            — phase heatmap [-pi, pi]
#   3. |G(z)| - e^{-Re z}  — pointwise residual against the closed form,
#                            visual sanity check that the dispatcher
#                            actually computed e^{-z}.
#   4. dispatch method     — categorical map (which lane fired per cell)
#
# Refused cells are rendered as transparent / NaN. Determinism: matplotlib
# rasterisation is platform-conditional, but the TSV upstream is bit-stable
# (arbprec); the PNG is a presentation artefact, not a contract.

import sys
import csv
import math
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import Normalize


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "meijer-g-grid.png"

    rows: list[dict[str, str]] = []
    reader = csv.DictReader(sys.stdin, delimiter="\t")
    for r in reader:
        rows.append(r)

    if not rows:
        print("plot-meijer-g-grid.py: no rows on stdin", file=sys.stderr)
        sys.exit(1)

    # Recover the grid axes by sorted unique (zRe, zIm). The TSV is
    # row-major in zIm-outer / zRe-inner, but we don't depend on order.
    re_vals = sorted({float(r["zRe"]) for r in rows})
    im_vals = sorted({float(r["zIm"]) for r in rows})
    n_re = len(re_vals)
    n_im = len(im_vals)
    re_idx = {v: i for i, v in enumerate(re_vals)}
    im_idx = {v: i for i, v in enumerate(im_vals)}

    abs_grid = np.full((n_im, n_re), np.nan)
    arg_grid = np.full((n_im, n_re), np.nan)
    resid_grid = np.full((n_im, n_re), np.nan)
    method_grid: list[list[str]] = [["" for _ in range(n_re)] for _ in range(n_im)]

    for r in rows:
        i = im_idx[float(r["zIm"])]
        j = re_idx[float(r["zRe"])]
        method_grid[i][j] = r["method"]
        if r["method"] == "refused":
            continue
        abs_v = float(r["abs"])
        arg_v = float(r["arg"])
        expected = float(r["expected_abs"])
        abs_grid[i, j] = abs_v
        arg_grid[i, j] = arg_v
        resid_grid[i, j] = abs_v - expected

    # Categorical method palette.
    methods = sorted({m for row in method_grid for m in row if m})
    method_to_idx = {m: k for k, m in enumerate(methods)}
    method_int_grid = np.full((n_im, n_re), -1.0)
    for i in range(n_im):
        for j in range(n_re):
            m = method_grid[i][j]
            if m:
                method_int_grid[i, j] = float(method_to_idx[m])

    extent = [re_vals[0], re_vals[-1], im_vals[0], im_vals[-1]]

    fig, axes = plt.subplots(2, 2, figsize=(11, 9))

    # Panel 1: |G(z)|. Log-scale because |e^{-z}| spans e^{-3}..e^{3}
    # (~1.8% to ~20) — linear washes out the small end.
    im0 = axes[0, 0].imshow(
        abs_grid,
        extent=extent,
        origin="lower",
        cmap="viridis",
        norm=matplotlib.colors.LogNorm(vmin=np.nanmin(abs_grid), vmax=np.nanmax(abs_grid)),
        aspect="equal",
    )
    axes[0, 0].set_title(r"$|G^{1,0}_{0,1}(_;0|z)| = |e^{-z}|$  (log scale)")
    axes[0, 0].set_xlabel(r"$\mathrm{Re}\, z$")
    axes[0, 0].set_ylabel(r"$\mathrm{Im}\, z$")
    fig.colorbar(im0, ax=axes[0, 0])

    # Panel 2: arg G(z) over [-pi, pi].
    im1 = axes[0, 1].imshow(
        arg_grid,
        extent=extent,
        origin="lower",
        cmap="twilight",
        vmin=-math.pi,
        vmax=math.pi,
        aspect="equal",
    )
    axes[0, 1].set_title(r"$\arg G(z) = -\mathrm{Im}\, z$  (mod $2\pi$)")
    axes[0, 1].set_xlabel(r"$\mathrm{Re}\, z$")
    axes[0, 1].set_ylabel(r"$\mathrm{Im}\, z$")
    fig.colorbar(im1, ax=axes[0, 1])

    # Panel 3: residual against closed form.
    rmax = max(abs(np.nanmin(resid_grid)), abs(np.nanmax(resid_grid)), 1e-30)
    im2 = axes[1, 0].imshow(
        resid_grid,
        extent=extent,
        origin="lower",
        cmap="RdBu_r",
        vmin=-rmax,
        vmax=rmax,
        aspect="equal",
    )
    axes[1, 0].set_title(
        r"$|G(z)| - e^{-\mathrm{Re}\, z}$  (max = " f"{rmax:.2e})"
    )
    axes[1, 0].set_xlabel(r"$\mathrm{Re}\, z$")
    axes[1, 0].set_ylabel(r"$\mathrm{Im}\, z$")
    fig.colorbar(im2, ax=axes[1, 0])

    # Panel 4: which dispatch lane fired.
    cmap_methods = plt.get_cmap("tab10", max(len(methods), 1))
    im3 = axes[1, 1].imshow(
        method_int_grid,
        extent=extent,
        origin="lower",
        cmap=cmap_methods,
        vmin=-0.5,
        vmax=len(methods) - 0.5,
        aspect="equal",
    )
    axes[1, 1].set_title("dispatch lane")
    axes[1, 1].set_xlabel(r"$\mathrm{Re}\, z$")
    axes[1, 1].set_ylabel(r"$\mathrm{Im}\, z$")
    cbar = fig.colorbar(im3, ax=axes[1, 1], ticks=range(len(methods)))
    cbar.set_ticklabels(methods)

    fig.suptitle(
        r"meijer-g dispatcher on $G^{1,0}_{0,1}(\_\,;\,0\,|\,z)$  —  20$\times$20 grid, "
        "request_mode=numerical-required, precision = 30 dps",
        fontsize=12,
    )
    fig.tight_layout(rect=[0, 0, 1, 0.96])
    fig.savefig(out_path, dpi=130)
    print(f"plot-meijer-g-grid.py: wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
