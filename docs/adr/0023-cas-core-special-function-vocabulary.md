# ADR-0023 — `cas-core` special-function AST vocabulary extension

**Status:** Accepted — 2026-05-08
**Beads:** scientist-workbench-hv0.2 (this ADR + the
`packages/cas-core/src/special-functions.ts` extension it specifies +
the matching `cas-diff` derivative-rule cascade); parent epic
scientist-workbench-hv0 (problem-13 Meijer G mega-test).
**Related:** ADR-0009 (TS-native idiom — the framework under which the
canonical encoding shape is decided); ADR-0010 (defineTool/runTool split
— why this lands as library extension, not as a new wire tool); ADR-0020
(arb-prec tier — the substrate that future per-head arbprec evaluators
will live in); the `cas-diff` design (worklog 041, ADR-implicit:
closed-vocabulary symbolic differentiator that refuses unknown heads).

## Context

The `cas-core` AST currently admits a closed *elementary* numerical
vocabulary aligned with `@workbench/quadrature::evalNumericExpr` and
`tools/cas-diff` / `tools/integrate-1d` /
`tools/optimize-lbfgs-projected` / `tools/integrate-ode-*`:

```
+ - * / ^ neg
exp sin cos tan sinh cosh tanh log sqrt abs
asin acos atan asinh acosh atanh
log2 log10
pi e
```

Every head is recognised as a closed-form differentiable expression
with rules expressible *within* the same vocabulary. Foreign heads are
refused at the cas-diff boundary with `tagged "cas-diff/out-of-scope"`.

Problem 13 (Meijer G mega-test) drives the next layer of the workbench:
the symbolic dispatcher (Adamchik-Marichev + Roach reduction rules,
hv0.6) and the asymptotic layer (Braaksma + Olde Daalhuis-Olver, hv0.9)
both work on a *broader* AST that names the special functions they
reduce *to* and *from*. Without a shared vocabulary table, those layers
cannot canonicalise their outputs nor pattern-match their inputs.

The vocabulary the campaign needs:

```
Gamma Digamma Polygamma                       (Γ, ψ, ψ⁽ⁿ⁾)
BesselJ BesselY BesselI BesselK               (cylindrical Bessel)
HypergeometricPFQ                             (generalised pFq)
WhittakerM WhittakerW                         (confluent Whittaker)
ParabolicCylinderD                            (parabolic-cylinder D_ν)
Erf Erfc                                      (error / complementary)
ExpIntegralEi ExpIntegralE                    (Ei, E_n)
FresnelC FresnelS                             (Fresnel cosine / sine)
LegendreP LegendreQ                           (Legendre P_ν, Q_ν)
LaguerreL HermiteH ChebyshevT ChebyshevU GegenbauerC
                                              (orthogonal-polynomial families)
Polylog                                       (polylog Li_s)
LerchPhi                                      (Lerch transcendent Φ)
MeijerG                                       (the recursive node)
```

These 27 heads cover every Wolfram-Functions-listed special function
that appears in problem-13's reduction tables and in the workbench's
forward roadmap (Bessel-bench, ODE special-function tests, transcendental
integration follow-ups). The list is *closed* — ADR-0009's
TS-expert-irresistibility test rules out an open registry; agents
reading the vocabulary set should see exactly what is admitted.

## Decision

Extend `cas-core` with a new module `packages/cas-core/src/special-
functions.ts` declaring:

1. **`SPECIAL_FUNCTION_HEADS`** — readonly array of the 27 head names,
   exhaustive. Backed by a `Set` for O(1) membership.
2. **`specialFunctionArity(head)`** — returns the *arity contract* per
   head. Three shapes:
   - **fixed** — exact `n` arguments (e.g., `Gamma`: 1; `BesselJ`: 2;
     `WhittakerM`: 3).
   - **list-head** — heads whose first/second arguments are themselves
     lists of parameters (`HypergeometricPFQ` is `(list, list, scalar)`;
     `MeijerG` is `(list-of-list, list-of-list, scalar)` with the
     Wolfram convention).
   - **rejected** — heads outside the table return `null`.
3. **`differentiateSpecialFunction(head, args, wrt)`** — symbolic
   derivative rule for each head where the rule is well-defined within
   the closed vocabulary. Returns the new derivative `Value`, or
   `null` if no rule applies (the head is recognised as AST-valid but
   not yet differentiable — caller falls through to the existing
   out-of-scope refusal path).

The cascade into `cas-diff`:

- `differentiate(e, wrt)` first checks the existing elementary heads
  table; on miss, consults `differentiateSpecialFunction(head, args,
  wrt)`. A non-null return is the result. A null return raises
  `CasDiffOutOfScopeError("head", head)` (the existing refusal path),
  which the tool layer maps to `tagged "cas-diff/out-of-scope"`.
- `DIFF_ADMITTED_HEADS` documents the *differentiable* subset; the
  README's "what cas-diff knows" table cites the source of each rule.
  Heads in `SPECIAL_FUNCTION_HEADS` but absent from the differentiable
  subset are honest refusals — admitted in the AST, refused on diff.

The differentiable subset shipped in v0.1:

| Head | d/dz rule | Source |
|---|---|---|
| `Gamma(z)` | `Digamma(z) · Gamma(z)` | DLMF §5.4.2 |
| `Digamma(z)` | `Polygamma(1, z)` | DLMF §5.7.1 |
| `Polygamma(n, z)` | `Polygamma(n+1, z)` (var = z; n integer) | DLMF §5.15.3 |
| `Erf(z)` | `2/√π · exp(-z²)` | DLMF §7.7.1 |
| `Erfc(z)` | `-2/√π · exp(-z²)` | DLMF §7.7.1 |
| `ExpIntegralEi(z)` | `exp(z) / z` | DLMF §6.2.6 |
| `ExpIntegralE(n, z)` | `-ExpIntegralE(n-1, z)` (var = z) | DLMF §8.19.13 |
| `FresnelC(z)` | `cos(π·z²/2)` | DLMF §7.2.7 |
| `FresnelS(z)` | `sin(π·z²/2)` | DLMF §7.2.7 |
| `BesselJ(ν, z)` | `(BesselJ(ν-1, z) − BesselJ(ν+1, z))/2` (var = z) | DLMF §10.6.1 |
| `BesselY(ν, z)` | `(BesselY(ν-1, z) − BesselY(ν+1, z))/2` (var = z) | DLMF §10.6.1 |
| `BesselI(ν, z)` | `(BesselI(ν-1, z) + BesselI(ν+1, z))/2` (var = z) | DLMF §10.29.1 |
| `BesselK(ν, z)` | `−(BesselK(ν-1, z) + BesselK(ν+1, z))/2` (var = z) | DLMF §10.29.1 |
| `HermiteH(n, z)` | `2n · HermiteH(n-1, z)` (var = z) | DLMF §18.9.27 |
| `Polylog(s, z)` | `Polylog(s-1, z)/z` (var = z) | DLMF §25.12.4 |

Heads recognised in the AST but *not* yet differentiable (refuse
honestly on `cas-diff`):

| Head | Why deferred |
|---|---|
| `HypergeometricPFQ`, `MeijerG` | Rule requires shifting list parameters by an integer; needs a list-shift smart constructor that lives in a follow-up bead. |
| `WhittakerM`, `WhittakerW` | Three-parameter recurrence; rule emits multiple Whittaker terms with non-trivial coefficient arithmetic. |
| `ParabolicCylinderD` | Two-form recurrence (`-z/2 · D_ν + ν · D_{ν-1}`); doable but boilerplate-heavy. |
| `LegendreP`, `LegendreQ`, `LaguerreL`, `ChebyshevT`, `ChebyshevU`, `GegenbauerC` | Closed-form derivatives introduce associated polynomials (`P_n^m`, `L_n^{(α)}`) that would expand the vocabulary further than this bead's scope. |
| `LerchPhi` | Three-parameter recurrence; not a problem-13 critical path. |

Each deferred head ships with a follow-up bead pinning the rule and
its source. The honest refusal is correct (PRD §6.1; ADR-0003
boundary-class) — agents see `tagged "cas-diff/out-of-scope"` with the
head name in the payload, and route around or refuse upstream.

## What we will not decide here

* **Numerical evaluation of these heads.** Per-head `evalAt(args,
  prec)` calling `@workbench/bigfloat` primitives is a separate
  effort. Most heads reduce to `pFq` (already shipped in
  `@workbench/hypergeometric`) plus a `Γ`-prefactor — the natural
  landing site is `packages/special-eval` (or per-head extensions of
  the existing packages) in a follow-up bead. Not in this ADR's scope.
* **Pretty-printer.** No general human-readable pretty-printer exists
  in `cas-core` today (`canonicalize` is the canonical-JSON form;
  `formatRat` / `affineToString` are ad-hoc string utilities for their
  specific consumers). A pretty-printer for the special-function
  vocabulary lands together with one for the elementary vocabulary, in
  a separate bead, when a consumer needs it.
* **expr-parse syntax extension.** The parser already admits any
  identifier followed by `(` as an expression head (worklog 042; tier-1
  vocabulary extension). `BesselJ(0, z)` parses to
  `expr("BesselJ", [int(0n), sym("z")])` today. Mathematica-style
  square brackets `BesselJ[0, z]` are a *separate* syntax decision
  (PRD §9.2 LaTeX-and-friends sister-tool territory) and are not
  required for the AST extension.
* **`cas-simplify` pattern matching for special functions.** That is
  hv0.6's territory (Adamchik-Marichev + Roach reduction tables). The
  vocabulary table this ADR ships is consumed by hv0.6 — but
  `cas-simplify`'s rewriter does not change in this bead.

## Why these choices

### Closed vocabulary, not open registry

The TS-expert-irresistibility test (ADR-0009; the Two Principles): a
TS expert reading the vocabulary list wants a finite, enumerable
table. A `registerSpecialFunction(head, rules)` API would push the
question one level up — when an agent sees an unfamiliar head, what
does it mean? With the closed table, the answer is unambiguous: the
head is admitted iff it's in the table. Future expansions add to the
table via a new ADR, not via runtime registration.

### Extension to `differentiate`, not a new function

`cas-diff` callers already invoke `differentiate(e, wrt)`. Branching
to a new `differentiateExtended(e, wrt)` would force every consumer
(`tools/cas-diff`, `optimize-lbfgs-projected`'s gradient generator,
the integrate-ode-stiff Jacobian builder) to choose between the two —
for no benefit, since the elementary vocabulary is a strict subset of
the extended one. The single entry point is the TS-expert reach.

### Diff-rule output stays in the closed vocabulary

The Bessel rules (`(J_{ν−1} − J_{ν+1})/2` etc.) emit expressions whose
heads are themselves in the special-function vocabulary. The output
is well-formed AST, recursively differentiable. The Erf/Erfc/Fresnel/
ExpIntegralEi rules emit expressions in the *elementary* vocabulary
(`exp`, `cos`, `sin`, `*`, `/`, `^`) — they reduce the problem to
existing rule territory. Both shapes are consistent; both round-trip
through cas-diff.

### Wolfram convention for list-parameter heads

`HypergeometricPFQ[{a₁,…,aₚ}, {b₁,…,b_q}, z]` and
`MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z]` are the canonical
Wolfram encodings, well-known to any user of Mathematica's Functions
site. Following the convention is irresistible to the TS expert who
already knows the Wolfram encoding (and Wolfram's Functions site is
the load-bearing reference for problem 13's reduction tables; matching
the convention lets a port lift formulae verbatim). The encoding lives
inside `expression.args` as `list` / `list-of-list` Values; no new
primitive kind is added to the value protocol.

### Deferred-rule honest refusal

Heads in `SPECIAL_FUNCTION_HEADS` but not yet differentiable refuse
via the existing boundary tag — same path foreign heads take today.
This is the honest scope discipline: an agent that sees the refusal
knows exactly what it knows (the head exists; cas-diff cannot yet
differentiate it). A future bead can add the rule without breaking
callers — adding to `differentiateSpecialFunction`'s dispatch is
purely additive.

## Acceptance

- `packages/cas-core/src/special-functions.ts` shipped with the 27-head
  vocabulary table + arity contracts + diff-rule dispatcher.
- `packages/cas-core/src/diff.ts` extended to consult the dispatcher
  on heads outside the elementary table.
- `packages/cas-core/src/index.ts` re-exports the new surface.
- Per-head unit tests for arity + diff rules + deferred-head refusal
  in `packages/cas-core/test/special-functions.test.ts`.
- `tools/cas-diff` admits the new heads with rules; existing 8-corpus
  FD cross-check continues to pass byte-identically (the new rules
  emit special-function heads that the elementary FD evaluator does
  not handle, so they're not in the FD corpus — they're verified by
  structural unit tests instead).
- `bun run check` green.
- ADR pinned (this file).
- Documentation lockstep (Law 2): `packages/cas-core/README.md`,
  `tools/cas-diff/README.md`, main `README.md` catalog row,
  worklog shard 074.
