# 177 — Incomplete-gamma CF: modified-Lentz probe + retain-and-gate

**Date:** 2026-05-20.
**Bead:** `scientist-workbench-o60c` ([gamma] v0.2 hardening — should the
upper incomplete-gamma continued fraction refit from a Wallis-style
recurrence to modified Lentz?).
**Files:**
[`packages/quadrature/src/special-funcs/gamma-float64.ts`](../../packages/quadrature/src/special-funcs/gamma-float64.ts),
[`packages/quadrature/test/special-funcs/gamma-float64.test.ts`](../../packages/quadrature/test/special-funcs/gamma-float64.test.ts),
[`packages/quadrature/src/index.ts`](../../packages/quadrature/src/index.ts).

## Context

R3-float64-algorithms.md §A.7 noted that Cephes `igam.c`'s upper
incomplete-gamma continued fraction uses a Wallis-style recurrence with
`big`/`biginv` magnitude-rescale rather than the modified-Lentz CF
(Thompson-Barnett 1986, J. Comput. Phys. 64; Numerical Recipes §5.2)
with its explicit tiny-denominator nudge. The bead asked whether v0.2
should refit to modified Lentz — benchmark-gated, low-priority, "probe
the premise first."

### Ground-truth correction — the bead named the wrong file

The bead text named `packages/bigfloat/src/special-funcs/incomplete-gamma.ts`
as the file carrying the Wallis recurrence. **It does not.** That
arb-prec module already evaluates its CF by modified Lentz — the
implementation (`bigIncompleteGammaUpperCF`, lines ~479-556) is a
textbook modified-Lentz iteration with `C`/`D` ratios and a `TINY`
nudge, and every doc comment in the module already says so. The Wallis
recurrence the bead describes lives in a *different* module —
`packages/quadrature/src/special-funcs/gamma-float64.ts` §12
`gammaQFloat64`, the verbatim Cephes `igam.c` float64 port (line 1263
literally read *"The Wallis-style recurrence is preserved verbatim;
modified-Lentz is a v0.2 alternative"*). R3 §A.7 is the *float64*
algorithm catalogue, so the bead's scoping reference pointed at the
float64 path; the named-file field conflated the two. Per Law 1 / Rule 3,
ground truth wins: the work was done where the Wallis recurrence
actually is.

## The probe

### Finding 1 — the bigfloat (arb-prec) CF loses zero bits

`bigIncompleteGammaUpper` at `prec = 300` was cross-validated against
mpmath 1.3.0 at 120 dp across the whole CF regime — extreme tails
(`z = 3000`, `z/a = 1000`), the moderate-cancellation band
(`z = 8.6, a = 7.5`), large `a` (`a = 1000`). It agrees to **~300+ bits
everywhere** (relative error ~1e-91). A 400-bit run is bit-identical to
a 1200-bit cross-check. The arb-prec modified-Lentz CF is bit-exact to
its working precision — nothing to change there.

### Finding 2 — the float64 Wallis CF does *not* lose bits in the CF; the
prefactor does

`gammaQFloat64` was probed against a 60-digit mpmath reference on an
18-point CF-regime grid. End-to-end `Q` errors looked alarming in the
large-`a` tail: ~21 ULP at `(10,50)`, ~101 ULP at `(100,1000)`,
**~1907 ULP at `(1000,1100)`, ~87 000 ULP at `(10⁴,1.2·10⁴)`**.

A modified-Lentz CF was then implemented and run on the same grid: it
produced **the same errors** — 1907 ULP, 87 021 vs 87 024. Isolating the
CF *value* alone (no prefactor) against mpmath showed **≤3 ULP for both
Wallis and Lentz** at every point, including `(10⁴,1.2·10⁴)`. The
visible tail error is therefore *entirely* the catastrophic
cancellation in the exponent prefactor
`ax = a·log(x) − x − lgamma(a)` — three large quantities subtracted
(at `a = 10⁴`: `93 650 − 12 000 − 82 099`, ~17 bits lost). That
prefactor loss is present byte-for-byte in *both* CF formulations and is
outside this bead's scope (it would need a `log Γ`-difference reform of
the prefactor).

## The decision — retain-and-gate

Benchmark (20-point grid × 2·10⁵ reps): Wallis **234.5 ns/call**, Lentz
**242.8 ns/call** — Lentz ~3 % slower. Accuracy identical (≤3 ULP CF,
both). Modified Lentz **does not beat** the verbatim-Cephes Wallis
recurrence on either axis. This is the same situation the two preceding
gamma-v0.2 beads (`idq1` CVZ, `d2ha` Temme) hit, and the user-confirmed
best practice applies: keep the alternative — fully implemented, tested,
cross-validated — but gate it off the hot path.

`gammaQFloat64` keeps the Wallis recurrence byte-identical (verbatim
port, marginally faster, byte-identical goldens). The modified-Lentz CF
ships as `gammaQLentzFloat64` — exported, literate, with the one-line
re-enable point documented in its doc comment (*"replace the CF block in
`gammaQFloat64` with `return gammaQLentzFloat64(a, x);`"*). No golden
churn: the production dispatch is untouched, so every existing
incomplete-gamma golden is byte-identical.

## Why these choices

A legendary senior engineer measures before refitting and refuses to
ship a non-winning algorithm as the default. The probe falsified the
bead's implicit premise twice over — the arb-prec module was already
Lentz, and the float64 Wallis CF was never the source of the tail bit
loss. Adding Lentz as a separate exported function (not an internal
branch) makes the "production goldens byte-identical" guarantee
structural rather than a tolerance argument.

## Frictions surfaced

- The bead's named target file was wrong; the Wallis recurrence is in a
  sibling package. The cross-package conflation cost the first ~half of
  the session to disentangle — R3 §A.7's float64 scope vs the bigfloat
  module's name.
- The tiny-denominator nudge — modified Lentz's *defining* feature —
  **never fires** for real-axis `(a, x)` in the CF regime: `x ≥ a` forces
  `b₀ = x+1−a ≥ 1` and the convergents stay clear of zero. It cannot be
  mutation-proven on the real-axis grid. Rather than fake a marker, M4
  was retargeted at the convergence criterion (which *is* exercised) and
  the nudge is pinned by an honestly-labelled structural finiteness test
  with a comment stating it is not a mutation marker (Rule 7 honesty).
- The visible "1907 ULP / 87 000 ULP" tail error tempts a CF refit; the
  CF-value isolation probe was essential to locate the real culprit
  (the prefactor) and avoid a pointless refit.

## Acceptance

- `bun test packages/quadrature/test/special-funcs/gamma-float64.test.ts`:
  98 pass / 0 fail (97 prior + 1 net new; §6b adds 7 tests).
- `bun test packages/quadrature/`: 473 pass / 0 fail.
- `bun test packages/bigfloat/test/special-funcs/incomplete-gamma.test.ts`:
  88 pass / 0 fail (untouched — already modified Lentz).
- `bun test packages/bigfloat/`: 1188 pass / 0 fail.
- `time bun -e 'import "@workbench/bigfloat";'`: 66 ms — no module-load
  regression (no import-time IIFE added).
- 4 mutation markers (M1 `aₙ` sign, M2 CF reciprocal `1/f`, M3 `bₙ`
  off-by-one, M4 convergence criterion) live-perturbed → RED; restored
  → GREEN.

## Pointers

- `gamma-float64.ts` §12 — `gammaQLentzFloat64` (the retained Lentz CF,
  literate derivation + Wallis-vs-Lentz verdict + re-enable point);
  `gammaQFloat64`'s CF-block comment carries the probe verdict.
- `gamma-float64.test.ts` §6b — "Modified-Lentz CF — retained-but-gated
  alternative" describe block.
- `bigfloat/src/special-funcs/incomplete-gamma.ts` — already modified
  Lentz; confirmed bit-exact, not modified.
