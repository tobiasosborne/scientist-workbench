#!/usr/bin/env python3
# =============================================================================
# plot-meijer-g-surface.py — 3D surface, coloured by phase
# =============================================================================
#
# Reads the TSV produced by `bun scripts/plot-meijer-g-grid.ts` on stdin
# and writes a PNG of the classic complex-function visualisation:
#
#     z (in C)  ↦  3D point (Re z, Im z, |G(z)|)
#                    coloured by arg G(z) ∈ (-π, π]
#
# This is the same idiom Wikipedia / DLMF / Wolfram use for special-
# function plots. The cyclic colormap (`twilight`) maps -π and +π to
# the same colour so the seam across the principal-branch cut is
# invisible when the phase is continuous, and visible as a sharp
# colour discontinuity when there's an actual branch cut.
#
# Usage:
#     bun scripts/plot-meijer-g-grid.ts > grid.tsv
#     python3 scripts/plot-meijer-g-surface.py [out.png] [--log] [--cmap=...] < grid.tsv
#
# Flags:
#   --log         plot height = log(1 + |G|) instead of |G|. Useful when
#                 |G| has a wide dynamic range (e.g. K_0 near 0). Off by
#                 default.
#   --cmap=NAME   matplotlib cyclic colormap for phase. Default `hsv`
#                 (the classic domain-coloring rainbow used in Wikipedia
#                 / Wolfram complex-plot figures); `twilight` is also
#                 common (perceptually-uniform; -π and +π map to the
#                 same colour).
#   --elev=DEG    elevation angle (default 35).
#   --azim=DEG    azimuth angle (default -55).

import sys
import csv
import math
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import cm
from matplotlib.colors import Normalize


def _flag_value(flag: str, default: str) -> str:
    prefix = f"{flag}="
    for a in sys.argv[1:]:
        if a.startswith(prefix):
            return a[len(prefix) :]
    return default


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--") and "=" not in a}
    out_path = args[0] if args else "meijer-g-surface.png"
    use_log = "--log" in flags
    cmap_name = _flag_value("--cmap", "hsv")
    elev = float(_flag_value("--elev", "35"))
    azim = float(_flag_value("--azim", "-55"))

    rows = list(csv.DictReader(sys.stdin, delimiter="\t"))
    if not rows:
        print("plot-meijer-g-surface.py: no rows on stdin", file=sys.stderr)
        sys.exit(1)

    re_vals = sorted({float(r["zRe"]) for r in rows})
    im_vals = sorted({float(r["zIm"]) for r in rows})
    n_re = len(re_vals)
    n_im = len(im_vals)
    re_idx = {v: i for i, v in enumerate(re_vals)}
    im_idx = {v: i for i, v in enumerate(im_vals)}

    abs_grid = np.full((n_im, n_re), np.nan)
    arg_grid = np.full((n_im, n_re), np.nan)
    for r in rows:
        if r["method"] == "refused":
            continue
        i = im_idx[float(r["zIm"])]
        j = re_idx[float(r["zRe"])]
        abs_grid[i, j] = float(r["abs"])
        arg_grid[i, j] = float(r["arg"])

    X, Y = np.meshgrid(np.array(re_vals), np.array(im_vals))
    Z = np.log1p(abs_grid) if use_log else abs_grid

    # Cyclic colourmap for phase. `hsv` is the classic domain-colouring
    # rainbow (Wikipedia / Wolfram default); `twilight` is matplotlib's
    # perceptually-uniform alternative.  Both are cyclic — -π and +π
    # map to the same colour, so continuous phase looks seamless and
    # branch cuts read as sharp colour discontinuities.
    cyclic_cmap = matplotlib.colormaps[cmap_name]
    norm = Normalize(vmin=-math.pi, vmax=math.pi)
    facecolours = cyclic_cmap(norm(arg_grid))

    fig = plt.figure(figsize=(12, 9))
    ax = fig.add_subplot(111, projection="3d")

    # `plot_surface` with explicit per-quad face colours via `facecolors`.
    # `shade=False` so the colour comes purely from the phase, not from
    # a synthetic light source — otherwise the colour gets dimmed by the
    # surface's local slope and the phase reading is no longer faithful.
    surf = ax.plot_surface(
        X,
        Y,
        Z,
        facecolors=facecolours,
        rstride=1,
        cstride=1,
        linewidth=0,
        antialiased=True,
        shade=False,
    )

    ax.set_xlabel(r"$\mathrm{Re}\, z$")
    ax.set_ylabel(r"$\mathrm{Im}\, z$")
    ax.set_zlabel(r"$\log(1 + |G(z)|)$" if use_log else r"$|G(z)|$")
    title_height = "log(1 + |G(z)|)" if use_log else "|G(z)|"
    ax.set_title(
        f"meijer-g 3D surface: height = {title_height},  colour = arg G(z)"
    )

    # Phase colourbar. Doesn't get a "real" mappable from `facecolors`,
    # so we attach a stand-alone scalar mappable.
    sm = cm.ScalarMappable(norm=norm, cmap=cyclic_cmap)
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=ax, shrink=0.7, pad=0.1)
    cbar.set_label(r"$\arg G(z)$")
    cbar.set_ticks([-math.pi, -math.pi / 2, 0, math.pi / 2, math.pi])
    cbar.set_ticklabels([r"$-\pi$", r"$-\pi/2$", "0", r"$\pi/2$", r"$\pi$"])

    ax.view_init(elev=elev, azim=azim)

    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    print(f"plot-meijer-g-surface.py: wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
