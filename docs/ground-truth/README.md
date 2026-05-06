# Ground-truth: primary sources for the `solve` epic

This directory stages primary-source PDFs and reference implementations
the `solve` epic implementations cite. PDFs are not committed
(`.gitignore` excludes them); this index is. Re-stage on a fresh clone
by re-running the acquisition pass — Wayback / Springer routes
documented below are stable.

## Layout

```
ground-truth/
  linear/          Phase 1: exact linear (Bareiss, Geddes-Czapor-Labahn)
  factor/          Phase 2a/b: univariate factor + radicals
  real-roots/      Phase 3a: real-root isolation + SymPy reference
  alg-num/         Phase 3b: algebraic numbers + Sage qqbar reference
  groebner/        Phase 4: Groebner-basis literature
  solve-disp/      Phase 5: solve dispatcher (Fateman, Strzebonski) + SymPy solveset
  transcendental/  Phase 6: transcendental solving (SymPy solveset)
```

OSS reference implementations are sparse-checkouts under
`real-roots/sympy/` and `alg-num/sage/`; cross-phase symlinks pull the
relevant Python files into `factor/` (factortools, galoistools),
`solve-disp/` (solveset), and `transcendental/` (solveset).

## What's where, what's missing

The lists below mirror the paper plan in `solve` epic notes. Each row:
local filename (or "MISSING — see MISSING.md"), source, citation.

### Phase 1 — linear (`linear/`)

| File | Source | Citation |
|---|---|---|
| `bareiss-1968-mathcomp.pdf` | AMS via Wayback | Bareiss, "Sylvester's identity and multistep integer-preserving Gaussian elimination", Math. Comp. 22(103), 1968 |
| `bareiss-1968-argonne-tech-report.pdf` | UNT digital library | Same content as Argonne tech report — kept for cross-reference |
| `geddes-czapor-labahn-1992-full-book.pdf` | Springer (TIB IP) | Geddes-Czapor-Labahn, *Algorithms for Computer Algebra*, Kluwer 1992 — full book PDF (594 pp). Section 9.5 is the load-bearing chapter |

### Phase 2a — univariate factor (`factor/`)

| File | Source | Citation |
|---|---|---|
| `berlekamp-1967.pdf` | VTDA BSTJ archive (open) | Berlekamp, "Factoring polynomials over finite fields", BSTJ 46(8), 1967 |
| MISSING — see `factor/MISSING.md` | — | Zassenhaus, "On Hensel factorization, I", JNT 1(3), 1969 |
| `mignotte-1974.pdf` | AMS via Wayback | Mignotte, "An inequality about factors of polynomials", Math. Comp. 28(128), 1974 |
| `vanhoeij-2002-knapsack.pdf` | author page (FSU) | van Hoeij, "Factoring polynomials and the knapsack problem", JNT 95(2), 2002 |
| `hart-vanhoeij-novocin-2011.pdf` | author page (FSU) | Hart-van Hoeij-Novocin, "Practical polynomial-time factoring", ISSAC 2011 |

### Phase 2b — radicals (`factor/` shared)

| File | Source | Citation |
|---|---|---|
| (URL-only) | https://en.wikipedia.org/wiki/Cubic_equation | Cardano formula |
| (URL-only) | https://en.wikipedia.org/wiki/Quartic_equation | Ferrari formula |
| `cox-little-oshea-ideals-varieties-algorithms-4th.pdf` | Springer (TIB IP) | Cox-Little-O'Shea, *Ideals, Varieties, and Algorithms* 4th ed., Springer 2015 — full book PDF, §1 covers the radicals context |

### Phase 3a — real-root isolation (`real-roots/`)

| File | Source | Citation |
|---|---|---|
| `tsigaridas-emiris-2008.pdf` | author page (Inria) | Tsigaridas-Emiris, "On the complexity of real root isolation using continued fractions", TCS 392(1-3), 2008 |
| `akritas-strzebonski-vigklas-2008.pdf` | Serdica J. Computing (open) | Akritas-Strzebonski-Vigklas, "On the various bisection methods derived from Vincent's theorem", Serdica J. Computing 2(1), 2008 |
| (URL-only) | https://dl.acm.org/doi/abs/10.5555/63365 | Akritas, *Elements of Computer Algebra with Applications*, Wiley 1989 — book |
| `sympy/sympy/polys/rootisolation.py` | GitHub sparse checkout | SymPy's reference impl of root isolation |

### Phase 3b — algebraic numbers (`alg-num/`)

| File | Source | Citation |
|---|---|---|
| `cohen-1993-comput-alg-number-theory.pdf` | Springer (TIB IP) | Cohen, *A Course in Computational Algebraic Number Theory*, GTM 138, Springer 1993 — full book PDF |
| `brown-traub-1971-subresultants.pdf` | ACM (TIB IP) | Brown-Traub, "On Euclid's algorithm and the theory of subresultants", JACM 18(4), 1971 |
| MISSING — see `alg-num/MISSING.md` | — | Strzebonski, "Computing in the field of complex algebraic numbers", JSC 24(6), 1997 |
| `sage/src/sage/rings/qqbar.py` | GitHub sparse checkout | Sage's reference impl of QQbar |

### Phase 4 — Groebner (`groebner/`)

| File | Source | Citation |
|---|---|---|
| `buchberger-1965-thesis-abramson-translation.pdf` | RISC Linz preprint repo | Buchberger 1965 PhD thesis, English translation by Abramson, JSC 41(3-4), 2006 |
| `gebauer-moeller-1988-installation-buchberger.pdf` | RISC JKU GB-Bibliography | Gebauer-Moeller, "On an installation of Buchberger's algorithm", JSC 6(2-3), 1988 |
| `giovini-mora-niesi-robbiano-traverso-1991-sugar-cube.pdf` | ACM (TIB IP) | Giovini-Mora-Niesi-Robbiano-Traverso, "One sugar cube, please OR Selection strategies in the Buchberger algorithm", ISSAC 1991 |
| `becker-mora-marinari-traverso-1994-shape-lemma.pdf` | ACM (TIB IP) | Becker-Mora-Marinari-Traverso, "The shape of the Shape Lemma", ISSAC 1994 |
| `faugere-1999-f4.pdf` | LIP6 author page via Wayback | Faugere, "A new efficient algorithm for computing Grobner bases (F4)", JPAA 139(1-3), 1999 |
| `faugere-gianni-lazard-mora-1993-fglm.pdf` | LIP6 author page via Wayback | Faugere-Gianni-Lazard-Mora, "Efficient computation of zero-dimensional Grobner bases by change of ordering", JSC 16(4), 1993 |
| `rouillier-1999-rur.pdf` | Springer (TIB IP) | Rouillier, "Solving zero-dimensional systems through the rational univariate representation", AAECC 9(5), 1999 |
| (URL-only) | https://bookstore.ams.org/gsm-3 | Adams-Loustaunau, *An Introduction to Grobner Bases*, AMS GSM 3, 1994 — book |

### Phase 5 — solve dispatcher (`solve-disp/`)

| File | Source | Citation |
|---|---|---|
| `sympy-solveset.py` (symlink) | sparse checkout | SymPy's `solveset.py` reference impl |
| MISSING — see `solve-disp/MISSING.md` | — | Strzebonski, "Solving polynomial systems over semialgebraic sets represented by cylindrical algebraic formulas", JSC 47(11), 2012 |
| `fateman-1991-solving-symbolic-equations.pdf` | Berkeley page | Fateman, "Notes on Computer Systems for Solving Symbolic Equations", 1991 — closest match to "What we have learned by trying to be systematic in CAS design" (the exact 1991 essay isn't on the public Berkeley index; this is the same period and theme) |
| `fateman-advances-trends-cas-design.pdf` | Berkeley page | Fateman, "Advances and Trends in the Design and Construction of Algebraic Manipulation Systems" — supporting design philosophy |
| `fateman-case-history-interactive-problem-solving.pdf` | Berkeley page | Fateman, "A Case History in Interactive Problem-Solving" (MIT) — supporting |

### Phase 6 — transcendental (`transcendental/`)

| File | Source | Citation |
|---|---|---|
| `sympy-solveset.py` (symlink) | sparse checkout (shared with solve-disp) | SymPy's `solveset.py` — relevant transcendental dispatch lives in this file |
| (URL-only) | https://reference.wolfram.com/language/ref/Solve.html | Wolfram Mathematica `Solve` documentation — transcendental cases |
| (URL-only) | https://reference.wolfram.com/language/tutorial/SolvingTranscendentalEquations.html | Wolfram tutorial on transcendental solving |

## Acquisition notes

Routes that worked from this device (uni-hannover.de IP, TIB VPN active):

- **Springer (link.springer.com/content/pdf/...)**: direct curl with
  default UA. Returns full-book PDFs without challenge.
- **ACM (dl.acm.org/doi/pdf/...)**: requires Playwright with the
  `download` event (the page initiates a file download, not an inline
  PDF response). Works from TIB IP.
- **Wayback (web.archive.org/web/<TS>/<url>)**: works for AMS Math.
  Comp. PDFs (which Cloudflare-block direct curl), and for LIP6
  author pages that have been deindexed but are CDX-discoverable.
  Use `web.archive.org/cdx/search/cdx?url=<host>/<path>&matchType=prefix&filter=mimetype:application/pdf&output=json`
  to find captures.
- **Author homepages (FSU, Inria, Berkeley)**: direct curl works.

Routes that **did not** work and need either real-Chrome (non-headless,
with display) or a different account state:

- **ScienceDirect (Elsevier)**: returns 403 with Cloudflare turnstile
  even from TIB IP under headless Playwright. Affected papers: Zassenhaus 1969,
  Strzebonski 1997, Strzebonski 2011. The full book PDFs from Springer
  (Geddes, Cohen, CLO) work because Springer is a different gateway —
  the Elsevier-specific bot wall is the blocker.
- **Inria HAL**: served behind an Anubis bot challenge for non-browser
  fetches; affected paper: Rouillier 1999. A real headed Chrome should
  pass.
- **AMS direct (ams.org/journals/...)**: Cloudflare turnstile.
  Workaround: web.archive.org/web/<TS>/<url> succeeds.

## Re-staging

Quick re-stage script (manual / bash):

```sh
# Springer books
for url in \
  "https://link.springer.com/content/pdf/10.1007/b102438.pdf:linear/geddes-czapor-labahn-1992-full-book.pdf" \
  "https://link.springer.com/content/pdf/10.1007/978-3-662-02945-9.pdf:alg-num/cohen-1993-comput-alg-number-theory.pdf" \
  "https://link.springer.com/content/pdf/10.1007/978-3-319-16721-3.pdf:factor/cox-little-oshea-ideals-varieties-algorithms-4th.pdf"; do
  src="${url%%:*}"; dst="${url##*:}"
  curl -sL -o "$dst" "$src" -A "Mozilla/5.0"
done
```

The full pass (Wayback + ACM + author pages) is documented in the
beads worklog for the corresponding `solve-acquire-ground-truth`
issue; re-running it takes ~20 min on TIB VPN.
