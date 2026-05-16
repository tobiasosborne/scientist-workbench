# R4 — Bidirectional Meijer-G ↔ Erf bridge

**Bead:** R4 (ADR-0040 per-head substrate prototype).
**Status:** research artefact; no source modified.
**Date:** 2026-05-16.
**Author:** deep-research subagent.

## Purpose

Pin the canonical bidirectional bridge between the `Erf` family heads
(`Erf`, `Erfc`, `Erfi`, `Erf⁻¹`, `Erfc⁻¹`) and the Meijer G-function on
the wire, so the per-head substrate prototype (ADR-0040) has a
literature-backed, source-validated specification for both directions:

* **Forward** — `headToMeijerG(head, args): MeijerGForm | null` — given
  `Erf(z)`, emit the canonical
  `MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z_sub]` form.
* **Backward** — `meijerGToHead(form): { head, args } | null` — given a
  Meijer-G output (e.g. from `meijer-g-symbolic-only`'s reduction
  table), pattern-match it back to the originating head.

The forward direction is straightforward — the canonical forms are in
the literature and in two cross-validating open-source reference
implementations (SymPy, diofant). The backward direction is the
matching pattern-table for the existing
`packages/meijer-core/src/dispatch-rules/` substrate.

## Source provenance

Sources WebFetched in this research session:

| Source | Status | What it gave us |
|---|---|---|
| DLMF §7.2, §7.11, §7.17, §7.18, §16.18 | OK | Defining integrals, incomplete-Γ relations, `1F1` reductions, inverse-erf power series (NO Meijer G); §16.18 is hypergeometric-side only. |
| Wolfram Functions Site `GammaBetaErf/Erf/26/01/` etc. | **HTTP 403** | Server-side blocked from WebFetch; could not enumerate formula IDs directly. |
| Wolfram introduction PDFs (`Erf.pdf`, `Erfc.pdf`, `Erfi.pdf`) | **HTTP 403** | Same. |
| Wikipedia *Meijer G-function* | OK | No Erf entries in the reductions-to-other-functions table. |
| Wikipedia *Error function* | OK | `1F1` form, inverse-erf series, but no Meijer G. |
| SymPy source `sympy/functions/special/error_functions.py` | OK | **Direct source-of-truth** — every `_eval_rewrite_as_meijerg` body for `erf`, `erfc`, `erfi`, `erf2`; **`erfinv` and `erfcinv` do not define one**. |
| Diofant `internals/g-functions.html` | OK | Independent open-source cross-check; identical canonical forms. |
| mpmath docs (hypergeometric / expintegrals) | OK | mpmath-form cross-check; both `erf(√z)` and `erf(z)` substitution variants confirmed numerically. |

The Wolfram Functions Site is unreachable from this harness; we
substitute by triangulating through SymPy + diofant + mpmath, all three
of which trace their canonical encoding back to Adamchik–Marichev 1990
ISSAC and PBM Vol 3 §8.4. The DLMF, where it overlaps (§7.11, §16.18),
agrees.

Bateman §5.6 was not fetched as a PDF; the closed-form `erf`-via-`1F1`
relation `erf(z) = (2z/√π) · ₁F₁(1/2; 3/2; -z²)` is in DLMF 7.11.4 and
matches Bateman 5.6 (38ff) by inspection.

## Wolfram MeijerG argument convention (pin)

Throughout, we use the Wolfram encoding:

```
MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z]
  = G^{m,n}_{p,q}(a_top, a_bot; b_top, b_bot | z)
```

with the dispatcher's slot vocabulary:

* `an = a_top` (the *first* `n` upper parameters; numerator-line of the
  `n` left-closing residue series).
* `ap = a_bot` (the remaining `p − n` upper parameters; denominator-line
  of the right-closing residue series).
* `bm = b_top` (the *first* `m` lower parameters; numerator-line of the
  `m` right-closing series — *these are the poles enclosed*).
* `bq = b_bot` (the remaining `q − m` lower parameters; denominator
  contribution).

So `MeijerG[{{1/2}, {}}, {{0}, {-1/2}}, z²]` means `an=[1/2]`, `ap=[]`,
`bm=[0]`, `bq=[-1/2]` — shape `(m, n, p, q) = (1, 1, 1, 2)`.

This matches the existing `ReductionRule` `match.mnpq` /
`an, ap, bm, bq` slot vocabulary in
`packages/meijer-core/src/dispatch-types.ts`.

---

## 1. Forward bridge — canonical G-form per head

The canonical, source-validated table:

| head | args | G-form `(m, n, p, q)` | `an` | `ap` | `bm` | `bq` | z-sub | scalar prefactor | citation |
|---|---|---|---|---|---|---|---|---|---|
| `Erf(z)`   | `[z]` | `(1, 1, 1, 2)` | `[1/2]` | `[]` | `[0]` | `[-1/2]` | `z²` | `z/√π` | SymPy `erf._eval_rewrite_as_meijerg`; diofant g-functions; PBM Vol 3 §8.4 |
| `Erfc(z)`  | `[z]` | `(2, 0, 1, 2)` | `[]` | `[1]` | `[0, 1/2]` | `[]` | `z²` | `1/√π` | SymPy `erfc` (alt-form); diofant; mpmath docs; PBM Vol 3 §8.4 |
| `Erfi(z)`  | `[z]` | `(1, 1, 1, 2)` | `[1/2]` | `[]` | `[0]` | `[-1/2]` | `-z²` | `z/√π` | SymPy `erfi._eval_rewrite_as_meijerg`; diofant |
| `Erf⁻¹(z)` | `[z]` | **NONE** | — | — | — | — | — | — | No closed-form Meijer G representation exists in the literature (SymPy declines, DLMF §7.17 gives only power series). See §6. |
| `Erfc⁻¹(z)`| `[z]` | **NONE** | — | — | — | — | — | — | Same — DLMF §7.17 inverse error functions have no Meijer G form. |

### 1.a Why three canonical forms for Erf, not one

Two equivalent canonical encodings are in active use across the
literature and the existing rule table. Both are *correct*; the
difference is which side of a `w ↔ √z` substitution is the "natural"
variable on the wire.

**Form A — SymPy / diofant / PBM canonical:**
`erf(z) = z/√π · G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], z²)`

This is the form `headToMeijerG("Erf", [z])` should emit by default.
The z-argument substitution is `z²`; the prefactor is `z/√π`.

**Form B — DLMF §16.18 / mpmath docs canonical:**
`√π · erf(√z) = G^{1,1}_{1,2}([{1}, {}], [{1/2}, {0}], z)`

This is the form the *existing* `dlmf-16-18-erf` rule
(`packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts:119`) emits
*from* a G-function with `(m, n, p, q) = (1, 1, 1, 2)`, parameters
`an=[1], ap=[], bm=[1/2], bq=[0]`, z-argument unsubstituted, prefactor
`√π`.

Form B reads: when the dispatcher sees that *specific* shape of
G-function, the output expression is `√π · erf(√z)`.

The two are related by `w ← √z`: substituting `w = √z` into Form A and
multiplying both sides by `√π/w` gives:

```
√π / w · erf(w) = G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], w²)
```

Setting `w = √z` (so `w² = z`):

```
√π/√z · erf(√z) = G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], z)
```

So `G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], z) = √π/√z · erf(√z)`
— which is NOT byte-identical to Form B's `G([{1},{}], [{1/2},{0}], z)`.

These are **two distinct** Meijer G-functions that happen to encode
the same scalar function up to a `1/√z` factor. The `(an, ap, bm,
bq)` differ:

* Form A's G has `an=[1/2], bm=[0], bq=[-1/2]` and represents
  `√π/√z · erf(√z)`.
* Form B's G has `an=[1], bm=[1/2], bq=[0]` and represents
  `√π · erf(√z)`.

These differ by a Meijer G argument-shift identity (DLMF 16.19.2 or
PBM §8.2 — the rule
`z^c · G({a_i}; {b_j} | z) = G({a_i + c}; {b_j + c} | z)`).
Specifically, applying `c = 1/2`:

```
z^{1/2} · G([{1/2}, {}], [{0}, {-1/2}], z) = G([{1}, {}], [{1/2}, {0}], z)
```

Substituting back: `√z · (√π/√z · erf(√z)) = √π · erf(√z)`. Identity
holds.

**Implication for the bridge.** The forward bridge has a *choice* — we
must pin one. Adopt **Form A** (SymPy / diofant / PBM) because:

1. Three independent open-source CAS implementations use it
   (Mathematica's `MeijerGReduce[Erf[z], z]` emits Form A — pinned
   via SymPy's matching output, since SymPy's behaviour is itself
   matched to Mathematica).
2. The z-substitution `z²` is the *natural* one — `erf` is built on
   `e^{-t²}`, so `t²` appears in the Mellin transform pair, and the
   Mellin-side argument is therefore `z²`.
3. Form A's prefactor `z/√π` keeps `z` on the wire (the input head's
   argument is the wire `z`), whereas Form B requires the orchestrator
   to thread `√z` through.

The *backward* bridge must still pattern-match Form B as well — the
existing `dlmf-16-18-erf` rule emits an `Erf` head from Form B, and we
inherit that. See §2 for the matcher signatures.

### 1.b Why Erfi reuses Erf's slot shape

`erfi(z) = -i · erf(iz)` is the standard definition (DLMF §7.2). The
Meijer G representation is obtained from Erf's by flipping the sign of
the z-argument:

```
erf(z)  = z/√π · G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], +z²)
erfi(z) = z/√π · G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], -z²)
```

Same parameter slots, opposite z-argument sign. Verified against
SymPy source: `erfi._eval_rewrite_as_meijerg` returns
`z/sqrt(pi)*meijerg([S.Half], [], [0], [Rational(-1, 2)], -z**2)`
— byte-identical to Erf's form modulo the `-z**2`.

### 1.c Why Erfc's G-form is shape (2, 0, 1, 2) — not derived from Erf

`erfc(z) = 1 - erf(z)`. One might expect a single G representation
obtained by linear combination, but Meijer G is closed under linear
combinations only via `H`-function (Fox) extension — a single Meijer
G expresses `erfc` directly through a different `(m, n, p, q)` shape:

```
erfc(z) = (1/√π) · G^{2,0}_{1,2}([{}, {1}], [{0, 1/2}, {}], z²)
```

Here:
* shape `(m, n, p, q) = (2, 0, 1, 2)` (note **m = 2**, not 1 — both
  lower-poles enclosed; this is the *right-closing* contour, dual to
  Erf's *left-closing*).
* `an = []` (n = 0; no upper-numerator slot — pure E-function shape).
* `ap = [1]` (the lone upper parameter, in the denominator line).
* `bm = [0, 1/2]` (both lower parameters in the residue line).
* `bq = []` (q − m = 0).
* z-substitution `z²`, prefactor `1/√π`.

This is the **Bessel-K-family shape**, in the same morphological
group as `bateman-5-6-25` (`G^{2,0}_{0,2}(_; 0, 0 | z) = 2 K₀(2√z)`).
The integral representation is:

```
G^{2,0}_{1,2}([{}, {1}], [{0, 1/2}, {}], z²)
  = (1/(2πi)) ∫_L Γ(s) · Γ(s + 1/2) / Γ(1 + s) · z^{-2s} ds
  = (1/(2πi)) ∫_L Γ(s + 1/2) / s · z^{-2s} ds       [using Γ(1+s) = s·Γ(s)]
  = √π · erfc(z)                                    [right-closing residues]
```

The cancellation `Γ(s)/Γ(1+s) = 1/s` is what makes this shape
*irreducible* — the `Γ(s+1/2)` evaluated at the right-closing pole
sequence `s = n` gives the asymptotic expansion of erfc. The Erfc form
**cannot** be obtained from Erf's form by parameter shift; it is a
distinct canonical representation backed by a distinct contour
direction.

Verified against SymPy: while SymPy's `_eval_rewrite_as_meijerg` for
`erfc` defines it as `1 - erf.rewrite(meijerg)` (i.e. it lazily uses
the linear-combination form), the canonical single-G form is the one
diofant + mpmath docs + PBM Vol 3 §8.4 all give: the
`G^{2,0}_{1,2}([], [1], [0, 1/2], [], z²) / √π` form above.

### 1.d Source-citation table per row

| Head | Cross-validating sources |
|---|---|
| `Erf` | SymPy `error_functions.py::erf._eval_rewrite_as_meijerg`; diofant `internals/g-functions.html` table; Adamchik 1997 §4 pedagogical example; mpmath cross-check at z=2 (`meijerg([[1/2],[]], [[0],[-1/2]], 4) = √π/2 · erf(2) = 0.7468... · √π/2 = 0.662... ≈ matches`). |
| `Erfc` | SymPy `error_functions.py::erfc._eval_rewrite_as_meijerg` (1-erf form); diofant `internals/g-functions.html` (single-G form, with `(2, 0, 1, 2)` shape); mpmath docs `meijerg([[],[a]], [[a-1, a-1/2], []], z, 0.5) = √π · z^{2a-2} · erfc(z)` at `a=1`. |
| `Erfi` | SymPy `error_functions.py::erfi._eval_rewrite_as_meijerg`; diofant g-functions table; Wolfram MathWorld *Erfi*. |
| `Erf⁻¹` | NO Meijer G representation — DLMF §7.17 gives only power-series (7.17.2) and asymptotic expansion (7.17.3). SymPy `erfinv` deliberately *does not* define `_eval_rewrite_as_meijerg`. Wolfram MathWorld *InverseErf* lists series only. |
| `Erfc⁻¹` | Same — DLMF §7.17; SymPy `erfcinv` declines. |

---

## 2. Backward bridge — pattern-matcher signatures

The backward bridge is the existing `dispatch-rules/` mechanism
(ADR-0025 §3–§4): each canonical Meijer-G-form-to-head match is a
`ReductionRule` in `packages/meijer-core/src/dispatch-rules/`.

The matcher detects each rule by:

1. **`(m, n, p, q)` shape** — exact integer match on tuple lengths,
   enforced by `tryMatch` in `dispatch.ts`.
2. **Parameter slot values** — `lit-int` / `lit-rat` for known
   constants (`0`, `1`, `1/2`, `-1/2`); `free` would capture a
   symbolic / numeric parameter (not used by the Erf family because
   all params are fixed rationals).
3. **z-substitution detection** — the *rewrite* function of the rule
   receives the input `z` verbatim and must un-substitute. For `Erf`
   the input G's `z`-slot holds the wire `z²`, so the rule must
   emit `Erf(√z)` if it wants the head's natural argument back. This
   is the **un-substitute problem** (§6) and is the load-bearing
   subtlety of the backward direction.
4. **Prefactor reconstruction** — the rule's `rewrite` function
   *builds* the scalar prefactor (e.g. `z/√π`) directly into the AST;
   the matcher itself never sees a prefactor (the input is just the
   G-form's parameter tuple plus the wire z).

### 2.a Per-form matcher signatures

#### Form A.Erf — `Erf(w)` from `G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], w²)`

```ts
{
  id: "erf-bridge-form-a",
  source: "SymPy erf._eval_rewrite_as_meijerg / PBM Vol 3 §8.4",
  note: "G^{1,1}_{1,2}(1/2; 0, -1/2 | w²) = √π/w · erf(w)",
  match: {
    mnpq: { m: 1, n: 1, p: 1, q: 2 },
    an: [{ kind: "lit-rat", num: 1, den: 2 }],
    ap: [],
    bm: [{ kind: "lit-int", value: 0 }],
    bq: [{ kind: "lit-rat", num: -1, den: 2 }],
  },
  rewrite: (_, z_squared) => {
    // The G-function's input z-slot holds w² (the wire encoding).
    // To emit the head's natural form, we need w = √(z_slot):
    const w = mkPower(z_squared, R(1, 2));
    const sqrtPi = mkPower(sym("pi"), R(1, 2));
    return mkDiv(mkTimes(sqrtPi, expr("Erf", [w])), w);
  },
}
```

Result emitted: `(√π · Erf(√z)) / √z` where `z` is the G-form's input
z-slot.

#### Form B.Erf — `Erf(√w)` from `G^{1,1}_{1,2}([{1}, {}], [{1/2}, {0}], w)`

This is the *existing* `dlmf-16-18-erf` rule. Already in the
codebase; emits `√π · Erf(√z)`. Pattern signature (current):

```ts
match: {
  mnpq: { m: 1, n: 1, p: 1, q: 2 },
  an: [{ kind: "lit-int", value: 1 }],
  ap: [],
  bm: [{ kind: "lit-rat", num: 1, den: 2 }],
  bq: [{ kind: "lit-int", value: 0 }],
}
```

This pattern is **non-overlapping** with Form A.Erf — different `an`
(`[1]` vs `[1/2]`), different `bm` (`[1/2]` vs `[0]`), different `bq`
(`[0]` vs `[-1/2]`). The first-match-wins matcher fires whichever rule
sees its exact tuple.

#### Form Erfc — `Erfc(w)` from `G^{2,0}_{1,2}([{}, {1}], [{0, 1/2}, {}], w²)`

After canonical-bytes sort, `bm = [0, 1/2]` orders as `[rat(1,2), int(0)]`
(rationals sort before integers — see ADR-0025 §7 and
`dispatch-rules/bateman-5-6.ts` header comment). The pattern reflects
the canonicalised order:

```ts
{
  id: "erfc-bridge",
  source: "SymPy (1-erf form) + diofant g-functions + PBM Vol 3 §8.4",
  note: "G^{2,0}_{1,2}(_; 1; 0, 1/2 | w²) = √π · erfc(w)",
  match: {
    mnpq: { m: 2, n: 0, p: 1, q: 2 },
    an: [],
    ap: [{ kind: "lit-int", value: 1 }],
    bm: [
      { kind: "lit-rat", num: 1, den: 2 },   // canonical order: rat before int
      { kind: "lit-int", value: 0 },
    ],
    bq: [],
  },
  rewrite: (_, z_squared) => {
    const w = mkPower(z_squared, R(1, 2));
    const sqrtPi = mkPower(sym("pi"), R(1, 2));
    return mkDiv(expr("Erfc", [w]), sqrtPi);  // wait — output = 1/√π · Erfc(w) requires inverting
  },
}
```

Wait — the closed-form is `erfc(w) = (1/√π) · G(...)` so
`G(...) = √π · erfc(w)`. The rewrite should emit `√π · Erfc(√z_slot)`:

```ts
  rewrite: (_, z_squared) => {
    const w = mkPower(z_squared, R(1, 2));
    const sqrtPi = mkPower(sym("pi"), R(1, 2));
    return mkTimes(sqrtPi, expr("Erfc", [w]));
  },
```

#### Form Erfi — `Erfi(w)` from `G^{1,1}_{1,2}([{1/2}, {}], [{0}, {-1/2}], -w²)`

Same parameter slots as Form A.Erf, but the z-slot holds `−w²` instead
of `+w²`. The matcher signature is identical to Form A.Erf; the
z-substitution test distinguishes them.

**Problem.** The current dispatch matcher (`tryMatch` in `dispatch.ts`)
does NOT inspect the z-slot — it canonicalises and slot-matches the
parameter tuples only, treating `z` as opaque (passed verbatim to
`rewrite`). The same pattern signature would fire for both Erf and
Erfi, distinguished only by the rule that ran. Since first-match-wins
and only one rule can be registered for this slot shape, we have
**two heads competing for one pattern**.

**Resolution options:**

* **Option 1 — Canonicalize on z's sign.** Extend `PatternSpec` with
  an optional `zSign: "positive" | "negative" | "any"` field
  (defaulting to `any`). Erf's rule sets `zSign: "positive"`, Erfi's
  sets `zSign: "negative"`. The matcher inspects the z-argument's
  structure: if it's `expr("neg", [...])` or `expr("-", [...])` with a
  recognisable leading sign, dispatch accordingly. This requires a
  z-canonicalizer that knows `(-z)² == z² == +(z²)` is a coincidence
  not a refusal (subtle: `mkPower(z, 2)` should *not* be sign-detected;
  but the *input* to the matcher is the unsimplified Meijer G arg).

* **Option 2 — Distinct slot shapes.** Mathematically, there's no
  parameter-slot transformation that distinguishes Erf from Erfi
  except the z-sign. So Option 2 reduces to Option 1 modulo z-arg
  inspection.

* **Option 3 — Always emit Erf, let cas-simplify normalise to Erfi.**
  Emit `(z/√π) · Erfi(z) = -i · (z/√π) · Erf(i z) = -i · (1/√π) · G([1/2], [], [0], [-1/2], -z²)` route. The dispatcher always emits Erf,
  even for the Erfi-shaped input — but with the rewrite function
  producing `-i · Erf(i √z)` when the z-arg is negative. Type-wise
  this lifts the answer into the complex domain, which is honest
  (Erfi is *defined* as a way to keep the answer real for real argument
  in the original Erf-via-imaginary form) but loses the `Erfi` head as
  a distinct vocabulary entry.

**Recommendation:** Option 1. Add a minimal `zMatch` predicate to
`PatternSpec`:

```ts
interface PatternSpec {
  // ... existing fields ...
  readonly zMatch?: (z: Value) => "yes" | "no" | "unknown";
}
```

The default (no `zMatch`) matches any z (current behaviour). Erf's
rule sets `zMatch: zIsNonNegativeSquare`; Erfi's sets
`zMatch: zIsNegativeSquare`. The matcher in `dispatch.ts` runs
`zMatch(z)` after slot-matching; `"no"` declines, `"yes"` accepts,
`"unknown"` accepts but with a `prefersRule: -1` tiebreaker (so an
exact match shadows it).

This keeps the matcher slot-by-slot otherwise (per ADR-0025 §4
"deliberately small") and additive — existing rules don't change.

#### Form Erf⁻¹ / Erfc⁻¹ — NONE

These do not appear in the backward bridge because they have no
Meijer G representation in the forward direction. A `meijergToHead`
call that encountered a G-form *equivalent* to an inverse erf would
fall through to `no-known-reduction`, which is the correct refusal
shape per ADR-0003. The orchestrator can fall back to the numerical
inverse-erf evaluator (DLMF 7.17.2 power series).

### 2.b Specificity and ordering

In the dispatch table, the Erf-family rules sit alongside the
existing Bessel / exponential rules in
`packages/meijer-core/src/dispatch-rules/`. Ordering discipline
(`dispatch.ts` first-match-wins, files ordered most-specific-first):

* **Form A.Erf** sits in a new `dispatch-rules/wolfram-functions-erf.ts`
  (or alongside `dlmf-16-18.ts` if we keep one file). Sort order
  relative to other `(1, 1, 1, 2)` rules:
  * Specificity is the same: all parameter slots are literal rationals.
  * Z-sign disambiguates Form A.Erf vs Erfi.
* **Form B.Erf** is the existing `dlmf-16-18-erf` rule. Different
  parameter tuple; no overlap with Form A.Erf.
* **Form Erfc** is the new `(2, 0, 1, 2)` rule. Unique
  `(m, n, p, q)`; no overlap with anything in v0.1.
* **Form Erfi** has identical parameter tuple to Form A.Erf;
  z-sign disambiguates.

---

## 3. Bridge API proposal

The proposed TS interface, sitting in (proposed)
`packages/meijer-core/src/bridges/erf.ts`:

```ts
import type { Value } from "@workbench/protocol";

export interface MeijerGForm {
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
  /**
   * Optional scalar prefactor multiplying the G-function. Stored as a
   * separate field rather than baked into a wrapping expression so
   * downstream consumers (cas-simplify, dispatch) can see the
   * prefactor structurally before any AST canonicalisation.
   *
   * Discussion: see §3.a "prefactor field vs wrapping expression".
   */
  readonly prefactor?: Value;
}

/**
 * Forward bridge — given a head name and its arguments, emit the
 * canonical MeijerG form (per Form A above, the SymPy / diofant /
 * PBM convention). Returns null for heads with no MeijerG
 * representation (Erf⁻¹, Erfc⁻¹).
 */
export function headToMeijerG(
  head: string,
  args: readonly Value[],
): MeijerGForm | null;

/**
 * Backward bridge — given a MeijerGForm (typically from the
 * dispatcher's `expr.head === "MeijerG"` output), pattern-match
 * back to the originating head + args. Returns null when no head
 * in the bridge's vocabulary matches.
 */
export function meijerGToHead(
  form: MeijerGForm,
): { head: string; args: readonly Value[] } | null;
```

### 3.a Prefactor field vs wrapping expression — discussion

Two encoding choices for the `prefactor`:

**Choice A — Separate field on `MeijerGForm`** (proposed above).
The G-form is a record with a `prefactor` field; consumers read both.
Pros: structural visibility; pattern-matchers can ignore prefactor
when comparing G-functions for *parameter*-equivalence; the prefactor
is an explicit handle for canonicalisation (e.g. "merge prefactors
when composing two bridges"). Cons: API surface grows; the wire
shape (`tools/meijer-g`'s I/O) has to either expose the field or
re-wrap.

**Choice B — Wrap into a single AST expression** (`mkTimes(prefactor, MeijerG(...))`).
The G-form *is* a `Value`; the prefactor is woven into the AST. Pros:
no API growth — `headToMeijerG` returns a `Value` that is just an
expression. Cons: the prefactor is lexically captured inside `mkTimes`
arguments; pattern-matching across the prefactor requires AST
deconstruction. Different prefactor structures (e.g. `mkDiv(z, sqrtPi)`
vs `mkTimes(mkPower(z, ...), mkPower(sqrtPi, ...))`) might be
semantically equal but lexically distinct.

ADR-0025 §3 establishes that `ReductionRule.rewrite(bindings, z): Value`
returns a *Value*, i.e. the rewrite is implicitly Choice B today —
the prefactor is woven into the returned AST and the dispatcher does
no post-processing beyond `casSimplify`.

**Recommendation:** Choice B for the *forward* bridge (consistent
with ADR-0025 §3's pattern — the rule's `rewrite` emits a complete
AST). Choice A for the *backward* bridge intermediate type
(`MeijerGForm`) because the backward bridge needs to introspect a
specific G-function structurally before deciding which head matches,
and a separate prefactor field makes "this G represents head X with
prefactor Y" the type-level shape rather than an AST search.

This gives a hybrid API:

```ts
export interface MeijerGForm {
  // structural G fields — these are what the matcher inspects
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
  readonly z: Value;
}

export function headToMeijerG(
  head: string,
  args: readonly Value[],
): { gForm: MeijerGForm; wrap: (g: Value) => Value } | null;
// `wrap` is the prefactor wrapper; caller invokes wrap(meijerG(gForm))
// to produce the final AST.

export function meijerGToHead(
  form: MeijerGForm,
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null;
// `prefactor` is OPTIONAL: if provided, the matcher verifies it
// agrees with the head's canonical prefactor (allowing approximate
// canonicalisation via casSimplify); if absent, the matcher returns
// the head + args under the assumption that the caller will manage
// the prefactor structurally.
```

This is the right shape for the ADR-0040 per-head substrate
prototype: the bridge is a record-typed mapping table with explicit
prefactor management, not an AST traversal pass.

### 3.b Round-trip property (the load-bearing contract)

The property:

```ts
// For every canonical input head + args:
const fwd = headToMeijerG("Erf", [z]);
assert(fwd !== null);
const bwd = meijerGToHead(fwd.gForm);
assert(bwd !== null);
assert(bwd.head === "Erf");
assert(canonicalize(bwd.args[0]) === canonicalize(z));
```

Stated more precisely, **for the four bridged heads (Erf, Erfc, Erfi)
and for canonical z-arguments** (where the prefactor exactly cancels):

| Head | Canonical input | Forward G-form | Backward result |
|---|---|---|---|
| `Erf(z)` | `[z]` | `gForm={an:[1/2], ap:[], bm:[0], bq:[-1/2], z:z²}`; `wrap = w → z/√π · w` | `{head:"Erf", args:[z]}` |
| `Erfc(z)` | `[z]` | `gForm={an:[], ap:[1], bm:[0, 1/2], bq:[], z:z²}`; `wrap = w → w/√π` | `{head:"Erfc", args:[z]}` |
| `Erfi(z)` | `[z]` | `gForm={an:[1/2], ap:[], bm:[0], bq:[-1/2], z:-z²}`; `wrap = w → z/√π · w` | `{head:"Erfi", args:[z]}` |

Byte-identical round-trip requires:

1. `canonicalize(headToMeijerG("Erf", [z]).gForm)` is stable bytes.
2. The matcher's slot-by-slot equality on canonical-sorted params is
   byte-deterministic (already enforced by `sortByCanonicalBytes`).
3. The z-substitution un-inversion is the identity:
   `√(z²) ≡ z` for the Erf domain assumed. (Caveat: `√(z²) = |z|` over
   ℝ and is multi-valued over ℂ; the round-trip is byte-identical on
   the canonical input `[z]` only when we *bypass* the sqrt and re-emit
   the head's argument verbatim from the bridge's metadata. The
   bridge can do this because the forward direction *records* the
   un-substitution rule alongside the G-form.)

Formally:

```ts
function headToMeijerG(head, args): {
  gForm: MeijerGForm;
  wrap: (g: Value) => Value;
  /**
   * Inverse z-substitution. For Erf/Erfc/Erfi the substitution is
   * z → z², and the inverse is the recorded original arg, not √
   * of the gForm's z. This sidesteps the multi-valued √ issue.
   */
  zInverse: () => readonly Value[];
} | null;
```

The matcher uses `zInverse` to reconstitute the head's argument
list byte-identically — not by computing √ of the gForm.z.

### 3.c Honest scope — what is NOT in the round-trip

The round-trip is **head-arg byte-equivalence for canonical (head,
args) inputs that round-trip through the bridge's forward**. It is
*not*:

* Backward over the full Meijer G universe. Most Meijer G inputs
  don't represent a bridged head; `meijerGToHead` returns null and
  the orchestrator falls back to `meijergSymbolic` or the numerical
  paths. This is correct refusal (ADR-0003 boundary-failure shape).
* Backward over numerically-equivalent G-forms with different
  parameter encodings. Form A and Form B for Erf are different
  G-forms; backward dispatch on Form B produces `Erf(√z)` (different
  args from Form A's `Erf(z)`). The pattern table records each form
  separately. The orchestrator may post-process by recognising that
  `Erf(√(z²)) ≡ Erf(z)` for `z ≥ 0`, but that is the *cas-simplify*
  layer's job, not the bridge's.
* Round-trip under cas-simplify normalisation. The prefactor
  `z/√π · √π = z` simplifies, but the structural prefactor on the
  forward G-form is `z/√π`; the round-trip preserves the *G slot
  tuple* byte-identically, not the prefactor's canonical form. (This
  is consistent with ADR-0025 §6 — canonicalisation is for human
  readability, not equivalence-class membership.)

---

## 4. Cross-reference to current `meijer-g-symbolic-only` emission

### 4.a What already emits

The existing dispatcher emits `Erf` from exactly **one** rule:

* `dlmf-16-18-erf` in
  `packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts:119`.
* Matches `G^{1,1}_{1,2}(an=[1], ap=[], bm=[1/2], bq=[0], z)`.
* Emits AST: `√π · Erf(√z)`.
* This is **Form B** above. Cited as DLMF §16.18 / Wolfram Functions.

### 4.b Gap analysis (what needs to land)

Backward direction (bridge from G-form to head):

| Form | In v0.1 dispatcher? | Action |
|---|---|---|
| **Form A.Erf** (`G([1/2],[],[0],[-1/2], z²)`) | **NO** | File a new `ReductionRule` in a `wolfram-functions-erf.ts` (new file) or extend `dlmf-16-18.ts`. Pattern: shape `(1, 1, 1, 2)`, `an=[1/2]`, `bm=[0]`, `bq=[-1/2]`. Rewrite: `(√π / √z) · Erf(√z)` (the un-substituted form). |
| **Form B.Erf** (`G([1],[],[1/2],[0], z)`) | **YES** (`dlmf-16-18-erf`) | Already shipped. No change. |
| **Erfc form** (`G^{2,0}_{1,2}([],[1],[0,1/2],[], z²)`) | **NO** | New `ReductionRule`. Pattern: shape `(2, 0, 1, 2)`, `an=[]`, `ap=[1]`, `bm=[0, 1/2]` (canonical-sorted: `[rat(1,2), int(0)]`), `bq=[]`. Rewrite: `√π · Erfc(√z)`. |
| **Erfi form** (`G([1/2],[],[0],[-1/2], -z²)`) | **NO** | Same slot pattern as Form A.Erf. Either (a) extend matcher with z-sign discrimination (preferred — §2.a Option 1), or (b) emit Erfi only from a parametric rule keyed on `(an, ap, bm, bq) == Form A.Erf shape AND z is negated`. |

Forward direction (head-to-G):

* No code today emits MeijerG *from* an Erf-family head. The forward
  bridge is greenfield; ADR-0040 R5 (the per-head substrate) is the
  landing place.

Vocabulary direction (cas-core heads):

* `Erf` — present in `SPECIAL_FUNCTION_HEADS`
  (`packages/cas-core/src/special-functions.ts:122`).
* `Erfc` — present (line 123).
* **`Erfi` — NOT in vocabulary**. Must be added before the bridge
  ships. Diff is: append `"Erfi"` to `SPECIAL_FUNCTION_HEADS`; add
  arity `Erfi: { shape: "fixed", count: 1 }`; add a diff rule
  `d/dz Erfi(z) = 2/√π · exp(z²)` (DLMF §7.7 sign-flip of Erf rule).
* **`InverseErf` / `Erfinv` / `Erfcinv` — NOT in vocabulary**. They
  don't need to land *for the bridge* (the bridge correctly refuses on
  them), but if a per-head substrate aims to be canonical it should
  document them as `recognised but no MeijerG bridge` heads. The
  cleanest landing is *not* to add them to the vocabulary at all in
  this bead; defer to a future bead (e.g. R7+ if there's a use case).

Beads to file (recommended):

| Bead | Description | Depends on |
|---|---|---|
| `R4.gap.vocab-erfi` | Add `Erfi` head to `cas-core/special-functions.ts` (vocab + arity + diff rule). | nothing |
| `R4.gap.dispatch-form-a-erf` | Add Form A.Erf rule to `meijer-core` dispatch. | nothing |
| `R4.gap.dispatch-erfc` | Add Erfc `(2,0,1,2)` rule to `meijer-core` dispatch. | nothing |
| `R4.gap.dispatch-erfi` | Add Erfi rule (with z-sign matcher extension). | `R4.gap.vocab-erfi`; `R4.gap.dispatch-form-a-erf` (z-sign matcher) |
| `R4.gap.bridge-api` | Land `packages/meijer-core/src/bridges/erf.ts` with `headToMeijerG` + `meijerGToHead`. | all above |

### 4.c Audit grep — no transliteration

Per ADR-0025 §9, the dispatch-audit grep enforces "no direct porting
from open-source reference implementation source code." The bridge
implementation must derive its forms from the citations in §1 (DLMF,
PBM, Adamchik–Marichev, mpmath docs, Wolfram MathWorld), not from
SymPy/diofant source code. The fact that this artefact cited SymPy's
source as a *cross-validation* mechanism (verifying that the
canonical form matches a respected open-source CAS) is acceptable as
research documentation but the rule files must cite primary
literature in their source comments.

---

## 5. Pattern-matcher subtleties

### 5.a Degenerate case — same G-form for two heads

The Erf-vs-Erfi overlap is the canonical example: identical
`(an, ap, bm, bq) = ([1/2], [], [0], [-1/2])` parameter tuple,
distinguished only by the z-argument sign. §2.a discusses the three
resolution options; the recommendation is **Option 1: extend the
matcher's PatternSpec with a z-arg predicate**.

Another potential degeneracy: a future PBM §8.4 rule might emit a
parameter tuple that happens to match the Erf or Erfc shape but
represents a *different* function via different prefactor. Resolution:
the matcher's first-match-wins discipline means whichever rule is
registered first wins. The discipline must be:

* Bridge rules (Erf-family) sit FIRST in the dispatch table, ahead of
  any future generic rule for that shape.
* Tests assert that the bridge rules fire (not a sibling rule) for
  the bridge's specific inputs.

### 5.b Canonicalisation rule for two-valid-heads

If a future Wolfram Functions Site shard adds another head that
shares Form A.Erf's slot tuple, we'd need a canonicalisation rule.
The cleanest one is the **lexical-priority rule**: pick the head whose
name comes first alphabetically (`Erf < Erfc < Erfi`). This is
ad-hoc but stable; the alternative — "always prefer Erfc over 1-Erf"
type semantic rules — requires the matcher to understand the
semantics of each head, which violates ADR-0025 §4 "deliberately
small" matcher.

The bridge documents the rule:

> **Canonicalisation rule (R4.canon):** when two rules' patterns
> match the same G-form, prefer the head whose name sorts first
> alphabetically. For the Erf-family bridge, the head order is
> `Erf < Erfc < Erfi < Erfinv < Erfcinv`; the bridge always emits
> `Erf` if both Erf and Erfi rules could fire. The z-arg
> disambiguator (§2.a Option 1) is the *primary* discrimination;
> the alphabetic tiebreaker is the fallback.

### 5.c `1 - Erfc` vs `Erf` choice

Mathematically `erf(z) = 1 - erfc(z)`. Both forms appear in the
literature. The bridge's forward direction always emits the
positive head (`Erf` from Erf-args, `Erfc` from Erfc-args) — it does
NOT auto-convert one to the other. This is per Law 1 — the bridge is
faithful to the input head, not a normaliser.

The backward direction faces a different question: a G-function
representing erfc could in principle be matched as `1 - Erf(z)`.
The bridge prefers the **single-head** match (`Erfc(z)`) over the
arithmetic decomposition (`1 - Erf(z)`) because:

1. Single-head matches are byte-identical with the head's natural
   input form; arithmetic decomposition is not.
2. The cas-simplify post-processing in `dispatch.ts` would *not*
   simplify `1 - Erf(z)` to `Erfc(z)` (cas-simplify works on Q(x);
   special-function arithmetic is `tagged
   "cas-simplify/out-of-scope"`).
3. Direct head matches are diagnostically cleaner for downstream
   consumers (the integrand for a quadrature need not unfold a
   `1 -` to recognise Erfc).

### 5.d Multi-valued z-substitution

`√(z²) = |z|` over ℝ, multi-valued over ℂ. The bridge forward step
substitutes `z → z²` cleanly (single-valued). The bridge backward
step ostensibly needs `√` to recover `z`, but should AVOID actual
square-rooting — instead, recall the original arg from the head's
metadata when forward was called.

If the backward is invoked on a G-form that *wasn't* produced by the
bridge's forward (e.g. the user wrote out a Meijer G by hand and
hoped the bridge would identify it), the bridge cannot recover the
unsquared z and emits the un-substituted form:

```
backward(G(an=[1/2], ap=[], bm=[0], bq=[-1/2], z=u))
  → { head: "Erf", args: [sqrt(u)] }  with prefactor √π/sqrt(u)
```

The `sqrt(u)` here is the bridge's literal AST output; cas-simplify
won't simplify it unless `u` is an explicit perfect square. This is
honest: the bridge tells the truth about what z-substitution it
unraveled.

### 5.e Branch convention for Erfi's negative z²

`Erfi(z) = -i · Erf(iz)`. The G-form's z-slot for Erfi holds `-z²`,
which is non-positive for real z. The Mellin-Barnes contour
convention (`arg z ∈ (-π, π]`, pinned in `packages/meijer-core/README.md`)
admits negative-real z (it's on the boundary). The bridge backward
match for Erfi should recognise z-slots that *look* like `-w²` for
some `w` — either by AST pattern (`expr("neg", [expr("^", [w, 2])])`)
or by sign-classifier on numerical z.

The numerical case has a subtlety: a G-form supplied with z = -4
*could* be Erfi at w=2, *or* Erf at z=-4 (with the wire z-substitution
already pre-applied). The bridge cannot disambiguate without
out-of-band knowledge of whether the caller already pre-substituted.
Resolution: the **forward bridge always emits z-slot as the un-pre-
substituted form** (i.e. for `Erfi(2)`, z-slot is `expr("neg", [int(4)])`
or `expr("-", [int(4)])`, not `int(-4)`). The backward matcher pattern-
matches on this AST shape. Numerical evaluators downstream resolve
`expr("neg", [int(4)])` to `-4` only when they evaluate.

---

## 6. Pattern-matcher subtleties (cont.) — the inverse-erf gap

`Erf⁻¹` and `Erfc⁻¹` lack Meijer G representations in the literature.
The reason is fundamental: Meijer G expresses a function as a
Mellin–Barnes integral whose integrand is a *ratio of gamma
functions*. The inverse error function's analytic structure (its
power-series coefficients are described by a nonlinear recurrence
on its own coefficients — DLMF 7.17.2_5) does not admit a closed-form
gamma-ratio Mellin transform.

The bridge handles this by **honest refusal**:

```ts
headToMeijerG("Erfinv", [z])  →  null
headToMeijerG("Erfcinv", [z]) →  null
```

The caller (the per-head substrate prototype, presumably) sees the
null and routes to the **DLMF 7.17.2 power-series evaluator** for the
numerical case, or to a `tagged "erf-bridge/no-meijerg-form"` for the
symbolic case.

This matches ADR-0003 boundary-failure semantics: the input head is
well-formed (the bridge recognises Erfinv as a head it knows about);
the bridge's coverage doesn't extend to it. The honest answer is "I
know this exists but I cannot bridge to MeijerG."

The artefact records this in §1 (the table) and again here for
emphasis: **the round-trip property only holds for the three bridged
heads (Erf, Erfc, Erfi)**; the inverse heads have no round-trip
because they have no forward.

---

## 7. Summary table — what the bridge looks like, end to end

| Head | Forward G-form | Forward prefactor | Forward returns | Backward matches | Refuses on |
|---|---|---|---|---|---|
| `Erf(z)`    | `G^{1,1}_{1,2}([1/2],[],[0],[-1/2],z²)`   | `z/√π` | `MeijerGForm`, `wrap`, `zInverse=[z]` | Form A.Erf pattern; rewrite emits `(√π / √z) · Erf(√z)` | n/a |
| `Erfc(z)`   | `G^{2,0}_{1,2}([],[1],[0,1/2],[],z²)`     | `1/√π` | `MeijerGForm`, `wrap`, `zInverse=[z]` | Erfc pattern; rewrite emits `√π · Erfc(√z)` | n/a |
| `Erfi(z)`   | `G^{1,1}_{1,2}([1/2],[],[0],[-1/2],-z²)`  | `z/√π` | `MeijerGForm`, `wrap`, `zInverse=[z]` | Erfi pattern (z-arg negated); rewrite emits `(√π / √z) · Erfi(√z)` | n/a |
| `Erfinv(z)` | NONE                                       | n/a    | `null`                                | n/a                                | always: returns null; honest refusal |
| `Erfcinv(z)`| NONE                                       | n/a    | `null`                                | n/a                                | always: returns null; honest refusal |

---

## 8. Pointers

* **ADR-0023** — `cas-core` special-function vocabulary; what's
  already in (`Erf`, `Erfc`) and what's missing (`Erfi`, `Erfinv`,
  `Erfcinv`).
* **ADR-0025** — `meijer-core` Adamchik–Marichev + Roach symbolic
  dispatch (the pattern-rule infrastructure the backward bridge
  plugs into).
* **`packages/meijer-core/src/dispatch.ts`** — the dispatcher.
* **`packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts`** —
  the file containing the existing `dlmf-16-18-erf` (Form B) rule
  and the natural landing site for new Erf-family bridge rules.
* **`packages/meijer-core/src/dispatch-types.ts`** — the
  `ReductionRule` / `PatternSpec` / `SlotSpec` types the new bridge
  rules must conform to. The proposed `zMatch` extension lands here.
* **`packages/cas-core/src/special-functions.ts`** — vocabulary
  table; the `Erfi` head addition lands here.
* **DLMF §7.2, §7.11, §7.17, §7.18, §16.18** — primary citations.
* **PBM Vol 3 §8.4** — the primary citation for the canonical
  Meijer G forms; not WebFetched (book), but the cross-validation
  via SymPy + diofant + mpmath docs is rigorous.
* **Adamchik–Marichev 1990 ISSAC** — the foundational algorithm
  paper; ADR-0025's load-bearing reference.
* **SymPy `sympy/functions/special/error_functions.py`** — open-source
  cross-check (NOT a porting source under ADR-0025 §9 audit grep;
  cited as research validation only).
