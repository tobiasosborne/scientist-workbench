// =============================================================================
// bridges/gamma.ts — bidirectional head ↔ Meijer-G bridge for the Gamma family
// =============================================================================
//
// Purpose
// -------
// Per ADR-0042 §"Decision 5" and the Gamma R4 (`docs/refs/gamma-research/
// R4-meijer-g-bridge.md`), this module pins the canonical bidirectional
// bridge between the gamma-family heads and the Meijer G-function on the
// wire. It is the **third** per-head bridge to land in the workbench
// (Erf was first, Bessel second; `bridges/erf.ts` and `bridges/bessel.ts`
// are the styling exemplars).
//
// The gamma family is structurally distinctive: of nine candidate heads,
// **only two have a closed Meijer-G representation** — `IncompleteGammaLower`
// and `IncompleteGammaUpper`. The remaining seven (`Gamma`, `LogGamma`,
// `Digamma`, `Trigamma`, `Polygamma`, `Beta`, `Pochhammer`, `BarnesG`)
// are honestly refused with `null`, each for a documented structural
// reason explained in the "Honest refusals" section below. This is not
// a coverage gap or a v0.1 deferral; it is the *correct* answer for
// every literature source surveyed (R4 §A, cross-validated against
// SymPy / mpmath / Wikipedia / DLMF / PBM Vol 3).
//
//   * `headToMeijerG(head, args)` — forward bridge. Given a head name and
//     its argument list `[a, z]`, returns a `ForwardBridge` for the two
//     bridgeable heads, or `null` for the seven honestly-refused heads
//     and for everything out-of-scope. CLAUDE.md Rule 8: `null` here is
//     the correct refusal contract, not a silent failure.
//
//   * `meijerGToHead(form, prefactor?)` — standalone backward bridge.
//     Pattern-matches a `MeijerGForm` against the two canonical Gamma-
//     family G-forms. The `(1,1,1,2)` shape is shared with Erf and the
//     `(2,0,1,2)` shape is shared with Erfc and `ExpIntegralE` — the
//     disambiguation lattice is documented and load-bearing.
//
// Canonical G-form table (R4 §A.3–A.4)
// ------------------------------------
// Wolfram convention `MeijerG[{{a_top},{a_bot}}, {{b_top},{b_bot}}, z]`,
// with `(m, n, p, q)` derived from sub-tuple lengths:
//
//   | Head                       | (m,n,p,q) | an  | ap  | bm     | bq  | z-sub | prefactor |
//   |----------------------------|-----------|-----|-----|--------|-----|-------|-----------|
//   | IncompleteGammaLower(a,z)  | (1,1,1,2) | [1] | []  | [a, 0] | []  | z     | 1         |
//   | IncompleteGammaUpper(a,z)  | (2,0,1,2) | []  | [1] | [a, 0] | []  | z     | 1         |
//
// Both are sourced from Wikipedia Meijer-G §"Representation of other
// functions" (HTTP 200, direct table entry), cross-validated against
// DLMF §8.6.10 / §8.6.11 Mellin-Barnes-kernel matching. Note that the
// Wikipedia table renders the slot signature in different `(m,n)`
// configurations — R4 §A.3 / §A.4 audited both renderings and pinned the
// `(an, ap, bm, bq)` decomposition that matches the G-function definition
// the dispatcher consumes.
//
// **Critical correction vs. some textbook renderings:**
// R4 §A.3 reads the Lower form as `(m,n,p,q) = (1,1,1,2)` with
// `an=[1], ap=[], bm=[a], bq=[0]`. After repeated cross-checks with
// the standalone definition `G^{m,n}_{p,q}` (p = an+ap, q = bm+bq) and
// the dispatcher's actual quintuple-layout, the **(an, ap, bm, bq)
// quintuple consistent with the (p,q) totals** is:
//
//   IncompleteGammaLower(a, z): an=[1], ap=[], bm=[a, 0], bq=[]
//   IncompleteGammaUpper(a, z): an=[], ap=[1], bm=[a, 0], bq=[]
//
// — both with `q = bm.length + bq.length = 2 + 0 = 2`. The R4 §A.3
// rendering `bm=[a], bq=[0]` is the same multiset of `q`-lower parameters
// `{a, 0}` split differently between `bm` and `bq`, but `bq=[0]` makes
// `m = bm.length = 1` (matching the Lower form's `(m,n,p,q) = (1,1,1,2)`).
// Either rendering matches the underlying Γ-product kernel; we pin the
// `bm=[a, 0], bq=[]` rendering for **Upper** (matches the bead spec line
// "ap=[1], bm=[a,0]") and the `bm=[a], bq=[0]` rendering for **Lower**
// (matches the bead spec line "an=[1], bm=[a,0]" — but the Lower form's
// `(m,n,p,q) = (1,1,1,2)` requires `m=1`, so `bm` has exactly one entry
// and `bq` has exactly one entry; bead's "bm=[a,0]" was shorthand for
// the full multiset of lower parameters).
//
// The final pinned table this module emits:
//
//   | Head                       | (m,n,p,q) | an  | ap  | bm   | bq  |
//   |----------------------------|-----------|-----|-----|------|-----|
//   | IncompleteGammaLower(a,z)  | (1,1,1,2) | [1] | []  | [a]  | [0] |
//   | IncompleteGammaUpper(a,z)  | (2,0,1,2) | []  | [1] | [a,0]| []  |
//
// — matching R4 §A.3 / §A.4 verbatim. The bead's "bm=[a,0]" for Lower
// was the lower-parameter multiset `{a, 0}` and is preserved exactly
// (the multiset survives byte-identically; the partition into
// `(bm, bq) = ([a], [0])` is what makes `(m,q) = (1,2)`).
//
// Encoding conventions
// --------------------
//   * Argument arity: both bridged heads are 2-arg `(a, z)`. Any other
//     arity returns `null` (honest scope per Rule 8).
//   * z-substitution is the **identity** — the head's `z` IS the
//     G-form's `z`-slot, byte-identical. Contrast with Erf (`z²`) and
//     Bessel (`z²/4`); the gamma bridge has no multi-valued root surface
//     to sidestep. The `argsInverse` closure is still emitted for API
//     uniformity with Erf / Bessel — same `ForwardBridge` contract per
//     ADR-0041 §"Decision 5".
//   * Prefactor is `1` for both heads — the head's value IS the G-form
//     directly, no scaling. `wrap(g) = g` (the identity closure).
//   * The parameter `a` is whatever Value the caller passes (typically
//     symbolic, but may be rational or integer). The slot literally
//     carries `a` straight through; the dispatcher's Γ-product kernel
//     evaluates the `a`-dependence correctly for every class.
//
// Honest refusals — the seven gamma-family heads with no G-form
// -------------------------------------------------------------
// Each refusal is recognised explicitly (head name matched, null
// returned with documented structural rationale). This is NOT
// "unknown head"; the bridge KNOWS these heads exist and that they
// are structurally unrepresentable.
//
//   * `Gamma(z)` — R4 §A.2: `z` appears in the exponent `t^{z-1}` of
//     Γ's defining integral. Encoding this as a G-form would require
//     `bm = [z-1]`, a parameter that depends on the head's *own*
//     argument — a structural impossibility, not a search failure.
//     Cross-validation: SymPy has no `gamma._eval_rewrite_as_meijerg`;
//     mpmath evaluates `Γ` via Stirling, never via `meijerg`.
//
//   * `LogGamma(z)` — same exponent-position obstruction as `Gamma(z)`
//     (`log Γ` is the logarithm of an exponent-positional function).
//     No source surveyed offers a G-form.
//
//   * `Digamma(z) = (d/dz) log Γ(z)` — derivative of `LogGamma`; same
//     structural obstruction. SymPy `gamma_functions.py` has no
//     `_eval_rewrite_as_meijerg`.
//
//   * `Trigamma(z) = (d²/dz²) log Γ(z)` — second derivative of
//     `LogGamma`; same obstruction. (NOTE: `Trigamma` is not currently
//     in the ADR-0023 vocabulary; the workbench encoding is
//     `Polygamma(1, z)`. The bridge recognises the name regardless,
//     so a hand-built call returning `null` is honest. The "third
//     derivative case" `Polygamma(2, z)` etc. are all the same
//     structurally-impossible class.)
//
//   * `Polygamma(m, z) = (d^{m+1}/dz^{m+1}) log Γ(z)` — generalised
//     derivative; same obstruction. The 2-arg signature `(m, z)` is the
//     vocab-pinned shape (ADR-0023 / `cas-core/src/special-functions.ts`).
//
//   * `Beta(a, b) = Γ(a)·Γ(b) / Γ(a+b)` — Γ-ratio, not a single
//     G-function. R4 §A.5: this can be expressed as a *product* of three
//     G-forms via the Γ-product channel, but not as a *single* G — the
//     bridge contract emits one canonical G-form per head, so this is
//     out of scope. The bridge would lie to claim a single-G form;
//     better to refuse honestly.
//
//   * `Pochhammer(a, n) = Γ(a+n) / Γ(a)` — same Γ-ratio category as
//     `Beta`. For fixed `n`, polynomial in `a`; for variable `a` and
//     fixed `n`, a rational function of Γ values. Neither shape fits
//     the bridge's single-G contract. R4 §A.7. The Pochhammer symbol
//     appears prominently *inside* the definition of `HypergeometricPFQ`
//     — which itself has a G-form via DLMF 16.18.1, dispatched by the
//     PFQ rules. But Pochhammer-as-a-head has none.
//
//   * `BarnesG(z)` — entire function of order 2 (Hadamard product
//     form). R4 §A.6: its Mellin transform is not a Γ-product ratio
//     of the kind G-machinery requires. The asymptotic expansion
//     involves the Glaisher-Kinkelin constant `A` and the Riemann zeta
//     function, not Γ-product ratios. No G-form in any source surveyed.
//
// The literate-prose discipline (CLAUDE.md Rule 10) demands the
// rationale, not just the verdict — a fresh reader of this file should
// learn *why* each refusal is correct, not merely *that* the function
// returns `null`. The cases above are each tagged with the R4 section
// that pinned them; that's the audit trail.
//
// Backward discrimination lattice — `(2,0,1,2)` and `(1,1,1,2)` shapes
// --------------------------------------------------------------------
// This is the load-bearing piece of the gamma bridge's correctness.
// Both Gamma-family G-forms share their `(m,n,p,q)` shapes with other
// heads. The standalone backward bridge must NOT shadow the existing
// rules.
//
// **Shape `(2, 0, 1, 2)`:** shared between `Erfc`, `ExpIntegralE`,
// and `IncompleteGammaUpper`. R4 §C.3 + bead spec discrimination,
// in priority order (earlier rules WIN):
//
//   1. `bm = {0, 1/2}` (any order) → **Erfc**.  The Erfc rule lives in
//      `erf.ts` and is the *existing* backward rule. The gamma bridge
//      MUST NOT route this case — `erf.meijerGToHead` already handles
//      it, and a top-level bridge dispatcher iterates over registered
//      bridges in order. Even within the gamma bridge's *own* matcher
//      we check `bm = {0, 1/2}` first and refuse, so a caller invoking
//      gamma's backward directly on an Erfc-shaped form still gets the
//      structurally-correct `null` (not `IncompleteGammaUpper(1/2, z)`,
//      which would be a silent lie).
//
//   2. `bm = {0, 0}` → **ExpIntegralE(1, z)**. R4 §A.4: at `a = 0`,
//      `IncompleteGammaUpper(0, z) = E_1(z)`, so the two heads agree
//      numerically — but `ExpIntegralE` is the conventional vocab head
//      (in ADR-0023, with its own dispatch rules); `IncompleteGammaUpper`
//      at `a = 0` is the *equivalent* shape but not the canonical name.
//      The existing `dlmf-16-17-e1` rule fires on this shape and
//      emits `ExpIntegralE(1, z)`. The gamma bridge MUST NOT shadow it.
//      Even at the *bridge* layer (this function), `bm = {0, 0}` is
//      routed to `ExpIntegralE` to keep the bridge-layer answer consistent
//      with the dispatcher-layer answer.
//
//   3. `ap = [n]` with `n` rational ≠ 1 → **ExpIntegralE(n, z)** (the
//      general E_n rule). At the time of this bead, the dispatcher does
//      NOT yet ship a general-`n` ExpIntegralE rule (only the `n = 1`
//      special case). When that rule lands (filed as a P3 follow-up;
//      see R4 §E Discovery C), the bridge layer's gamma matcher will
//      still need to defer to it. Today the gamma bridge does NOT
//      shadow this case: it matches only when `ap = [1]` AND `bm` is
//      one of the IncompleteGammaUpper shapes (the `a` slot is
//      symbolic or a rational ≠ 0, 1/2).
//
//   4. `ap = [1]` and `bm = {a, 0}` with `a` symbolic OR `a` rational
//      ≠ {0, 1/2} → **IncompleteGammaUpper(a, z)**. This IS the gamma
//      bridge's hit. Recovered args: `[a, z]` where `a` is the
//      non-zero entry of `bm` and `z` is the G-form's z-slot.
//
// **Shape `(1, 1, 1, 2)`:** shared between `Erf` and `IncompleteGammaLower`.
// (`Erfi` shares Erf's shape with a sign-flipped z-slot; that's an
// existing Erf-vs-Erfi discriminator inside `erf.ts`, not a concern
// here.) Disambiguation:
//
//   1. `an = [1/2]`, `bm = [0]`, `bq = [-1/2]` → **Erf** (or **Erfi**
//      after z-sign check — the gamma bridge does not run that check;
//      we refuse this case and let `erf.ts` handle it).
//
//   2. `an = [1]`, `bm = [a]`, `bq = [0]` with `a` symbolic OR `a`
//      rational ≠ 1/2 → **IncompleteGammaLower(a, z)**. Recovered args:
//      `[a, z]` where `a = bm[0]` and `z` is the G-form's z-slot.
//
// The `an[0]` discriminator (`1/2` vs `1`) is structurally sharper than
// the `(2,0,1,2)` case's `bm[i]` discriminator: a single literal check
// decides the head, with no multiset ordering to worry about.
//
// **The `bm` multiset convention.** The `bm` parameter list is
// *unordered* — the G-function's defining Γ-product `∏ Γ(b_j - s)` is
// symmetric in `b_j`. The backward matcher therefore checks the
// **multiset** `{bm[0], bm[1]}`, not the ordered tuple. For
// `(2,0,1,2)`, both `[a, 0]` and `[0, a]` route to the same head with
// the same recovered args (we identify the non-zero entry as `a` and
// the zero entry as the literal `0`). This mirrors how `erf.ts`'s Erfc
// matcher accepts both orderings of `{0, 1/2}`.
//
// References
// ----------
//   * ADR-0042 §"Decision 5" — per-head gamma substrate; pins the bridge
//     contract: 2 bridgeable heads, 7 honest refusals.
//   * Gamma R4 — `docs/refs/gamma-research/R4-meijer-g-bridge.md`;
//     §A.3 / §A.4 canonical G-forms; §A.2 / §A.5 / §A.6 / §A.7 / §A.8
//     refusal rationales; §C.2 / §C.3 forward / backward API; §F.3 the
//     `(2,0,1,2)` collision triangulation.
//   * Phase 2 impl plan — `docs/refs/gamma-research/PHASE2-impl-plans.md`
//     lines 1009-1153 (this bead's spec).
//   * `packages/meijer-core/src/bridges/erf.ts` — first per-head bridge;
//     1-arg precedent for `argsInverse` and the `(2,0,1,2)` / `(1,1,1,2)`
//     Erfc / Erf rules this module must NOT shadow.
//   * `packages/meijer-core/src/bridges/bessel.ts` — second per-head
//     bridge; 2-arg precedent for `argsInverse` (`[nu, z]`); the
//     `(m,n,p,q)`-uniqueness-by-head pattern this bridge nearly follows
//     (with the `(2,0,1,2)` / `(1,1,1,2)` collisions as the exception).
//   * `packages/meijer-core/src/dispatch-rules/dlmf-16-17-e1.ts` (and
//     `erfc-forward.ts`) — the dispatcher-layer rules the backward
//     matcher must defer to.

import { int, rat, sym, type Value } from "@workbench/protocol";
import type { ForwardBridge, MeijerGForm } from "./types.js";

// Local touch-marker: `sym` is currently unused but is kept imported as
// a hint to maintainers extending this module (e.g., adding a future
// `a = -1/2` special-case to Erf-family disambiguation, which would
// emit a `sym("z")` placeholder for a symbolic recovery). Removing the
// import is fine if it stays unused.
void sym;

// -----------------------------------------------------------------------------
// Encoding helpers
// -----------------------------------------------------------------------------
//
// Builders for the literals the canonical G-forms use. Kept local (not
// re-exported) so the module's encoding choices stay byte-identical with
// the I4 gamma identity table (`cas-core/src/special-funcs/gamma-
// identities.ts`) without spreading the convention across the package's
// public surface.

const ZERO_INT: Value = int(0n);
const ONE_INT: Value = int(1n);

// -----------------------------------------------------------------------------
// Forward bridge
// -----------------------------------------------------------------------------

/**
 * Forward bridge: head name + arguments → canonical Meijer-G form.
 *
 * Returns:
 *   * `ForwardBridge` on success — exactly two heads:
 *     `IncompleteGammaLower(a, z)` and `IncompleteGammaUpper(a, z)`,
 *     each with arity 2.
 *   * `null` for the seven honestly-refused heads (`Gamma`, `LogGamma`,
 *     `Digamma`, `Trigamma`, `Polygamma`, `Beta`, `Pochhammer`,
 *     `BarnesG`). Each refusal's structural reason is documented in the
 *     file-top "Honest refusals" section. CLAUDE.md Rule 8: this null
 *     IS the correct refusal — silently emitting a wrong-shaped G-form
 *     would be inadmissible regardless of cleverness.
 *   * `null` for any other head not in this bridge module's scope —
 *     the caller can try the next bridge or fall back.
 *   * `null` for the wrong arity on a recognised head (e.g., calling
 *     `IncompleteGammaLower` with one argument). Same honest-scope
 *     contract as the Erf and Bessel bridges.
 */
export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null {
  switch (head) {
    case "IncompleteGammaLower": {
      // γ(a, z) = G^{1,1}_{1,2}(1; a, 0 | z)  — R4 §A.3
      //   (m, n, p, q) = (1, 1, 1, 2)
      //   an = [1], ap = [], bm = [a], bq = [0]
      //   z-sub: identity (the G-slot z IS the head's z, byte-identical)
      //   prefactor: 1 (identity wrap)
      // Source: Wikipedia Meijer-G §"Representation of other functions";
      // DLMF §8.6.10 Mellin-Barnes kernel matching.
      if (args.length !== 2) return null;
      const a = args[0]!;
      const z = args[1]!;
      const gForm: MeijerGForm = {
        an: [ONE_INT],
        ap: [],
        bm: [a],
        bq: [ZERO_INT],
        z, // identity substitution; no squaring, no multi-valued root
      };
      // Prefactor 1: γ's G-form IS the γ value directly.
      const wrap = (g: Value): Value => g;
      // Arity-agnostic closure (ADR-0041 §"Decision 5"): 2-element list
      // `[a, z]`. Identical surface to the Bessel bridge.
      const argsInverse = (): readonly Value[] => [a, z];
      return { gForm, wrap, argsInverse };
    }

    case "IncompleteGammaUpper": {
      // Γ(a, z) = G^{2,0}_{1,2}( ; 1; a, 0 | z)  — R4 §A.4
      //   (m, n, p, q) = (2, 0, 1, 2)
      //   an = [], ap = [1], bm = [a, 0], bq = []
      //   z-sub: identity
      //   prefactor: 1
      // Source: Wikipedia Meijer-G §"Representation of other functions";
      // DLMF §8.6.11 Mellin-Barnes kernel matching. The shape collides
      // with Erfc and ExpIntegralE; see file-top "Backward discrimination
      // lattice" for how the backward matcher disambiguates.
      if (args.length !== 2) return null;
      const a = args[0]!;
      const z = args[1]!;
      const gForm: MeijerGForm = {
        an: [],
        ap: [ONE_INT],
        bm: [a, ZERO_INT],
        bq: [],
        z, // identity substitution
      };
      const wrap = (g: Value): Value => g;
      const argsInverse = (): readonly Value[] => [a, z];
      return { gForm, wrap, argsInverse };
    }

    // -------------------------------------------------------------------------
    // Honest refusals — recognised, structurally unrepresentable
    // -------------------------------------------------------------------------
    //
    // Each case is documented at the file-top under "Honest refusals".
    // The head name is matched explicitly so a fresh reader of this
    // switch sees the structural-impossibility class enumerated, not
    // hidden inside a `default` fall-through. CLAUDE.md Rule 10
    // (literate programming): refusals are part of the bridge's
    // *content*, not boilerplate.
    //
    // The corresponding `argsInverse` is unimplemented because the
    // bridge returns null *before* constructing one. No prefactor, no
    // G-form, no closure — just the honest "no representation exists"
    // verdict. The dispatcher / caller falls back to the head's own
    // identity-table or numerical-evaluator surface.

    case "Gamma":
      // R4 §A.2: `t^{z-1}` in Γ's defining integral has z in the
      // exponent — cannot be encoded as a fixed `bm`-slot parameter.
      // SymPy has no `gamma._eval_rewrite_as_meijerg`.
      return null;

    case "LogGamma":
      // Logarithm of Γ; inherits Γ's exponent-position obstruction.
      return null;

    case "Digamma":
      // (d/dz) log Γ(z); inherits LogGamma's obstruction.
      return null;

    case "Trigamma":
      // (d²/dz²) log Γ(z); same obstruction. Note that `Trigamma` is
      // NOT in the ADR-0023 vocabulary (the workbench uses `Polygamma
      // (1, z)` for this); we still recognise the name for caller
      // friendliness — the refusal is honest either way.
      return null;

    case "Polygamma":
      // (d^{m+1}/dz^{m+1}) log Γ(z); generalised derivative. The 2-arg
      // signature `Polygamma(m, z)` is the vocab-pinned shape. Same
      // obstruction as Digamma / Trigamma.
      return null;

    case "Beta":
      // Γ-ratio Γ(a)·Γ(b)/Γ(a+b); not a single G-function. R4 §A.5:
      // expressible as a product of three G-forms via the Γ-product
      // channel, but the bridge contract emits ONE canonical G-form
      // per head — that's outside this bridge's scope.
      return null;

    case "Pochhammer":
      // (a)_n = Γ(a+n)/Γ(a); Γ-ratio, same category as Beta. R4 §A.7.
      // Pochhammer-INSIDE-pFQ has a G-form (via DLMF 16.18.1), but
      // Pochhammer-as-a-head does not.
      return null;

    case "BarnesG":
      // Entire function of order 2; its Mellin transform is not a
      // Γ-product ratio of the kind G-machinery requires. R4 §A.6.
      // The Glaisher-Kinkelin / Riemann-zeta dependencies of its
      // asymptotic expansion confirm: this is not in the G-class.
      return null;

    default:
      // Not in this bridge module's scope — caller can try the next
      // bridge or fall back. Null-return composes additively with the
      // Erf and Bessel bridges (a top-level dispatcher iterates over
      // every registered bridge module and returns the first non-null
      // hit).
      return null;
  }
}

// -----------------------------------------------------------------------------
// Backward bridge — standalone path (no forward-pass closure)
// -----------------------------------------------------------------------------
//
// This path runs when a user (or another tool) hands the bridge a
// `MeijerGForm` that wasn't produced by this module's own `headToMeijerG`.
// The matcher inspects the parameter quintuple structurally and, on hit,
// returns `{head, args}` with `args` reconstructed from the slot tuples
// and the z-slot.
//
// Two canonical Gamma-family shapes (R4 §A.3, §A.4):
//
//   * `(m,n,p,q) = (1,1,1,2)`, `an=[1]`, `bm=[a]`, `bq=[0]` →
//     `IncompleteGammaLower(a, z)`.
//   * `(m,n,p,q) = (2,0,1,2)`, `ap=[1]`, `bm={a, 0}` (multiset) →
//     `IncompleteGammaUpper(a, z)`.
//
// **Recovery is trivial** because the z-substitution is the identity:
// `a` is recovered directly from `bm` (the non-zero / non-special entry),
// and `z` is recovered byte-identically from `form.z`. No multi-valued
// root surface, no closure required — the standalone backward bridge
// recovers `[a, z]` byte-identically when the forward bridge built the
// form (and *structurally* recovers when a caller hand-built the form).
//
// **Discrimination from sibling-shape heads** is the load-bearing piece;
// see file-top "Backward discrimination lattice" for the full priority
// order. In short:
//
//   * `(2,0,1,2)`: defer Erfc (`bm = {0, 1/2}`) and `ExpIntegralE(1, z)`
//     (`bm = {0, 0}`) — return `null` so the caller routes to their
//     existing rules.
//   * `(1,1,1,2)`: defer Erf / Erfi (`an = [1/2]`) — return `null`.
//
// The deferral pattern matches how `bessel.ts` returns `null` on
// Erf-shaped inputs (its "cross-bridge isolation" property test). The
// caller's top-level dispatcher iterates over registered bridges in
// priority order; the gamma bridge's job is to not steal a form that
// belongs to a sibling head.

/**
 * Backward bridge: a Meijer-G form → originating head + args, when the
 * form matches one of the two canonical Gamma-family shapes AND the
 * shared shape does NOT belong to a sibling head (Erf / Erfc /
 * ExpIntegralE). Returns `null` otherwise.
 *
 * The optional `prefactor` parameter exists for API parity with
 * `erf.ts`'s backward signature (the R4 §3.a hybrid surface — kept for
 * forward compatibility; not currently verified). Round-trips that need
 * byte-identical preservation should call
 * `headToMeijerG(...).argsInverse()` directly.
 */
export function meijerGToHead(
  form: MeijerGForm,
  // `prefactor` is part of the R4 hybrid surface — kept for API
  // parity with erf.ts. See `erf.ts` for the same documentation.
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null {
  // Touch `prefactor` to signal intentional non-use without tripping
  // the linter; the parameter is part of the bridge API contract.
  void prefactor;

  const mnpq = mnpqOf(form);

  // ---------------------------------------------------------------------------
  // IncompleteGammaLower — shape (1, 1, 1, 2)
  //   an=[1], ap=[], bm=[a], bq=[0]
  // ---------------------------------------------------------------------------
  //
  // Discriminator: `an[0]` distinguishes Lower (=1) from Erf (=1/2). The
  // gamma bridge fires only when `an[0] = 1`; the Erf-shaped `an[0] = 1/2`
  // case returns null so `erf.ts`'s backward matcher handles it.
  if (mnpq.m === 1 && mnpq.n === 1 && mnpq.p === 1 && mnpq.q === 2) {
    if (
      form.an.length === 1 &&
      isIntegerEqual(form.an[0]!, 1n) &&
      form.ap.length === 0 &&
      form.bm.length === 1 &&
      form.bq.length === 1 &&
      isIntegerEqual(form.bq[0]!, 0n)
    ) {
      // bm[0] is `a` (the head's first argument). Recovery is direct;
      // the z-slot is the head's `z` byte-identically (identity z-sub).
      // We do NOT route a `bm[0] = 1/2` case here (that would be the
      // Erf shape with an=[1] — a hand-built collision; refuse honestly
      // rather than emit a wrong head).
      const a = form.bm[0]!;
      if (isRationalEqual(a, 1n, 2n)) {
        // bm=[1/2] with an=[1] is structurally the Erf parameter tuple's
        // multiset complement; refuse so the caller doesn't get a
        // wrong-shaped IncompleteGammaLower(1/2, z).
        return null;
      }
      return { head: "IncompleteGammaLower", args: [a, form.z] };
    }
    // Fall-through to null — Erf-shaped (1,1,1,2) is handled by erf.ts.
  }

  // ---------------------------------------------------------------------------
  // IncompleteGammaUpper — shape (2, 0, 1, 2)
  //   an=[], ap=[1], bm={a, 0} (multiset)
  // ---------------------------------------------------------------------------
  //
  // The discrimination lattice (file-top "Backward discrimination
  // lattice", priority order):
  //   1. `bm = {0, 1/2}` → Erfc (defer; return null).
  //   2. `bm = {0, 0}`   → ExpIntegralE(1, z) (defer; return null).
  //   3. `ap = [n]` rational ≠ 1 → ExpIntegralE(n, z) (the gamma matcher
  //      requires `ap = [1]`, so this case is naturally excluded by our
  //      `isIntegerEqual(form.ap[0]!, 1n)` guard; no explicit check
  //      needed here, but documented for completeness).
  //   4. `ap = [1]` and `bm = {a, 0}` with `a` symbolic OR `a` rational
  //      ≠ {0, 1/2} → IncompleteGammaUpper(a, z).
  //
  // The `bm` multiset check is order-agnostic: both `[a, 0]` and `[0, a]`
  // route to the same head with the same recovered `a`, matching how
  // erf.ts handles `{0, 1/2}` in either order.
  if (mnpq.m === 2 && mnpq.n === 0 && mnpq.p === 1 && mnpq.q === 2) {
    if (
      form.an.length === 0 &&
      form.ap.length === 1 &&
      isIntegerEqual(form.ap[0]!, 1n) &&
      form.bm.length === 2 &&
      form.bq.length === 0
    ) {
      const bm0 = form.bm[0]!;
      const bm1 = form.bm[1]!;

      // Rule 1 (defer to Erfc): bm = {0, 1/2}.
      const isErfcShape =
        (isIntegerEqual(bm0, 0n) && isRationalEqual(bm1, 1n, 2n)) ||
        (isRationalEqual(bm0, 1n, 2n) && isIntegerEqual(bm1, 0n));
      if (isErfcShape) {
        return null;
      }

      // Rule 2 (defer to ExpIntegralE(1, z)): bm = {0, 0}.
      const isE1Shape = isIntegerEqual(bm0, 0n) && isIntegerEqual(bm1, 0n);
      if (isE1Shape) {
        return null;
      }

      // Rule 4: bm = {a, 0} multiset — exactly one entry is the integer
      // `0`, the other is `a`. We accept either order. If neither entry
      // is `0`, the form is not a canonical IncompleteGammaUpper shape
      // (it would be a generalised case the bridge doesn't claim) and
      // we return null.
      let a: Value | null = null;
      if (isIntegerEqual(bm0, 0n) && !isIntegerEqual(bm1, 0n)) {
        a = bm1;
      } else if (isIntegerEqual(bm1, 0n) && !isIntegerEqual(bm0, 0n)) {
        a = bm0;
      }
      if (a !== null) {
        return { head: "IncompleteGammaUpper", args: [a, form.z] };
      }
      // bm = {x, y} with neither 0 nor matching Erfc/E_1 — out of the
      // canonical-Gamma-form claim; fall through to null.
    }
    // Fall-through to null — other (2,0,1,2) forms are not gamma.
  }

  // No rule matched — honest refusal (ADR-0003 boundary failure).
  return null;
}

// -----------------------------------------------------------------------------
// Value-shape predicates (local; mirror the helpers in erf.ts so each
// bridge module stays standalone and usable outside the dispatch
// pipeline)
// -----------------------------------------------------------------------------

function mnpqOf(form: MeijerGForm): { m: number; n: number; p: number; q: number } {
  return {
    m: form.bm.length,
    n: form.an.length,
    p: form.an.length + form.ap.length,
    q: form.bm.length + form.bq.length,
  };
}

function isIntegerEqual(v: Value, n: bigint): boolean {
  if (v.kind === "integer") return BigInt(v.value) === n;
  if (v.kind === "rational" && BigInt(v.den) === 1n) {
    return BigInt(v.num) === n;
  }
  return false;
}

function isRationalEqual(v: Value, num: bigint, den: bigint): boolean {
  // Reduce target to canonical form (gcd-reduced, sign in numerator).
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = bigintGcd(n < 0n ? -n : n, d);
  const tn = n / g;
  const td = d / g;
  if (v.kind === "rational") {
    return BigInt(v.num) === tn && BigInt(v.den) === td;
  }
  if (v.kind === "integer" && td === 1n) {
    return BigInt(v.value) === tn;
  }
  return false;
}

function bigintGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

// `rat` is unused but is imported to signal that any future literal-
// rational guard (e.g., a `bm[0] = -1/2` special case) would use it.
// Kept silent via void.
void rat;
