# ADR-0019 — Bench discipline for the solve epic

**Status:** Accepted (2026-05-06)
**Bead:** `scientist-workbench-u1u`
**Epic:** `scientist-workbench-98a` (solve-suite-v1)
**Depends on:** ADR-0017 (solution-set shape), ADR-0018 (`Root[]`)

## Context

The solve epic spans seven goldened benches —
`linsolve-q`, `poly-factor-q`, `poly-roots-radical`,
`real-root-isolate`, `alg-num-arith`, `groebner-basis`,
`groebner-zerodim-extract`, `solve`, `solve-transcendental`. They
inherit the workbench's existing bench skeleton (`bench/linalg-eigh`,
`bench/integrate-ode-ivp`, ...) and the tstournament discipline at
`../tstournament/ts-bench-infra/` (problem dirs with PROMPT,
DESCRIPTION, REFERENCES, golden/{inputs,expected,verify,generate}.{json,py},
reference/, run-candidate.ts).

What the existing pattern *doesn't* yet pin down for solve-class
problems:

1. **How is "correct" defined when the answer is exact-symbolic and
   admits multiple representations?** A candidate that returns
   `{x → (1 + Sqrt[5])/2}` and a reference that returns
   `{x → Root[x^2 - x - 1, 1]}` describe the same algebraic number;
   byte-equality fails, mathematical equivalence holds. The verifier
   must reject one only if it actually disagrees.
2. **How is a branched solution verified?** ADR-0017 requires
   `Sin[x] == 1/2` to emit two solutions parameterised by integer
   branch symbols. The verifier must instantiate those parameters
   and check the substituted equation, not just compare strings.
3. **Where does the golden master come from when the algorithm
   isn't deterministic in its representation?** Wolfram and SymPy
   sometimes return mathematically-equal answers in different forms.
   Choosing one as ground truth privileges its representation; the
   workbench needs an oracle protocol that's neutral.
4. **How do we know the verifier is *strict enough* to catch
   regressions?** A passing verifier proves the candidate satisfies
   the verifier; it does not prove the verifier is sensitive. The
   tstournament discipline of "mutation-prove" — perturb the
   reference, observe RED — is where this gets earned.

This ADR pins the four answers and is the contract every
`bench/<solve-tier-tool>/` follows.

## Decision

### 1. Mathematical-invariant verification, not byte-equality

Every solve-tier verifier checks the *defining mathematical
invariants* of the answer:

| Tool | Invariant |
|---|---|
| `linsolve-q` | `A·x = b` exactly in ℚ; rank reported correctly; free-variable parameterisation linearly spans the null space |
| `poly-factor-q` | product-of-factors = input; each factor irreducible over ℚ (delegated to oracle); content / leading-coefficient canonical |
| `poly-roots` (≤4 in radicals) | each claimed root substitutes to 0 *symbolically* under `cas-simplify`; count = degree with multiplicity |
| `real-root-isolate` | each interval contains exactly one real root (sign-change at endpoints); intervals disjoint; count matches Sturm-sequence ground truth |
| `alg-num-arith` | sum/product result is a `Root` whose interval contains the numerical sum/product of the input intervals (refined to common precision); equality-on-equal returns `true`, equality-on-distinct returns `false` |
| `groebner-basis` | bidirectional ideal containment (input ⊆ ⟨candidate⟩, candidate ⊆ ⟨input⟩); every S-polynomial reduces to 0 modulo the candidate |
| `groebner-zerodim-extract` | each claimed solution substitutes to 0 in *every* input polynomial; count = `dim_ℚ(Q[x]/I)`; no spurious solutions |
| `solve` (top-level) | union of all above, dispatched by classification |
| `solve-transcendental` | for each branched solution `x = expr(k_1, ..., k_n)`, substituting every integer tuple in `[-3, 3]^n` produces an equation that holds (numerically to `1e-12`) |

These invariants are necessary AND sufficient for correctness
modulo representation. Two representations that pass the same
invariant set are mathematically equal; the bench accepts both.

This inherits the `bench/linalg-eigh` precedent ("the verifier
checks invariants, not byte-equality") verbatim.

### 2. Branch-honest verification semantics

A candidate solution `{bindings: [{var: x, value: expr}], branches:
[k_1, k_2]}` is verified by:

1. Substituting each integer tuple `(k_1, k_2) ∈ [-3, 3]^2`
   (49 tuples) into `expr`.
2. Substituting the result into the original equation.
3. Numerical evaluation of the substituted equation; pass if
   `|lhs − rhs| < 1e-12 · max(1, |lhs|, |rhs|)`.
4. Across all integer tuples in the test cube, all must pass.

The cube `[-3, 3]^n` is small enough to enumerate exhaustively for
`n ≤ 3` branches (~343 tuples), large enough that any "off-by-one
in the period" or "wrong branch sign" fault triggers on at least
one tuple. Tools requiring `n > 3` branches (mixed-trig sums under
half-angle) accept a stratified random sample of `[-10, 10]^n`
(1000 tuples) instead.

The numerical tolerance `1e-12 · max(1, |lhs|, |rhs|)` is consistent
with the workbench's existing numerical-tier tolerances
(ADR-0014 §"Tolerances"); the relative form catches near-zero
spurious passes.

**Completeness (no missing branches).** A candidate that emits *one
branch* of `Sin[x] == 1/2` passes the per-tuple substitution check
on all `k`, but misses the second branch family. The verifier
detects this: it sample-evaluates the original equation on a dense
1D grid of real `x` values, identifies the actual roots, and
verifies every grid root falls within `1e-6` of *some* candidate
solution's `expr` instantiated at *some* integer tuple. A grid root
that no candidate-tuple matches is a missed branch and the case
fails.

The grid for univariate transcendental: `2000` points uniform on
`[-50, 50]`. For multivariate (rare in v1): a Halton-sequence
sample of `5000` points in the bounding hypercube derived from the
equation's natural scale.

### 3. Triple-witness oracle protocol

A golden case is admitted iff ≥ 2 independent oracles agree on the
expected output, modulo the equivalence relation defined by the
verifier's invariants. The oracles in priority order:

1. **`wolframscript`** — Wolfram `Solve[]`, `Factor[]`,
   `GroebnerBasis[]`, `RootIntervals[]`, `Reduce[]`. Activated on
   the workbench host (TIB-Hannover-VPN).
2. **SymPy** — `solve`, `solveset`, `factor`, `groebner`,
   `Poly.real_roots`, `Poly.is_irreducible`. Local install,
   `python3 -c "import sympy"`.
3. **SageMath** *where licensed* — `qqbar`, `QQbar`, `solve`,
   `Ideal.groebner_basis`. Local install (when added to the bench
   environment); preferred third witness for algebraic-number
   problems where Wolfram and SymPy disagree on representation.

Disagreement protocol: if all three oracles disagree, the case is
*dropped from the golden set* (logged in `bench/<tool>/golden/
oracle-disagreements.log` for retrospective). If two of three agree,
the agreed answer is the golden, the third's output is logged with
the disagreement classification. If two disagree and the third is
unavailable, the case is dropped.

The agreement check is per-invariant, not per-byte. Wolfram's
`Root[#^2 - 2 &, 1]` and SymPy's `CRootOf(x^2 - 2, 0)` both name
the same algebraic; the agreement layer compares via the bench's
verifier invariants — substitute, simplify, equate.

### 4. Mutation-prove requirement

Every `bench/<tool>/golden/verify.py` ships with a sibling
`test_mutations.py` that demonstrates **RED on at least five
characteristic perturbations** of the reference implementation:

```python
# bench/poly-factor-q/golden/test_mutations.py
def test_dropped_factor():
    ref = load_reference()
    output = ref(input_case)
    output['factors'].pop()             # dropped factor
    assert verify(input_case, output)['pass'] is False

def test_off_by_one_multiplicity():
    ...
def test_content_leak():
    ...
def test_sign_flip_leading_coeff():
    ...
def test_returned_reducible_factor():
    ...
```

The five mutations are tool-specific. The discipline is "the
verifier has caught at least one *real* regression before the suite
is admitted to the bench" — exactly the workbench's TDD-shape "B"
(port-and-verify; CLAUDE.md Rule 6). Without mutation-prove, a
verifier that always returns PASS would be admitted; with it, the
verifier's *sensitivity* is on the record.

The mutations are run as part of `bun run check` via
`bench/_corpus/run-mutation-tests.sh`; failure to demonstrate RED
fails the gate.

### 5. Tagged-refusal admission

Cases whose expected output is a `tagged 'solve/<class>'` refusal
(per ADR-0017) are admitted by setting

```jsonc
"expected": {
  "kind": "tagged",
  "tag":  "solve/<class>",
  "payload_predicate": "<class-specific check>"
}
```

The verifier matches on tag exactly; the payload is checked
against `payload_predicate` (e.g., for `solve/multivariate-non-zero-dim`,
"the `dimension_estimate` field is a positive integer"). Strict tag
equality plus loose payload predicate, mirroring the existing
`tagged "linalg-X/non-symmetric-input"` admission style.

Refusal-class cases participate in the triple-witness protocol the
same way as happy-path cases: "Wolfram refuses with `$Failed` AND
SymPy refuses with `NotImplementedError`" is the consensus that
admits a refusal-class golden.

### 6. Bench infrastructure (shared)

`bench/_corpus/oracle/` (P0-6) provides:

- `wolfram.py`: `wolfram_query(code: str, timeout=30) -> dict`
  with parsed `InputForm` output. Returns `{'status': 'ok', 'result':
  ...}` or `{'status': 'failed', 'reason': ...}`.
- `sympy_bridge.py`: thin wrappers standardising representation
  (e.g., always returning `dict[var → expr]` for `solve`, never the
  legacy `list-of-tuples`).
- `agreement.py`: `agree(wolf, sympy, kind: 'solution-set' | 'factor-list'
  | 'groebner-basis' | 'root-list' | 'refusal') -> bool`. Per-kind
  comparison via the verifier invariants.
- `test_oracle_agreement.py`: ≥ 20 self-test cases proving the
  agreement layer doesn't false-positive on Wolfram /SymPy
  representation drift (e.g., `Root[]` vs `CRootOf` for the same
  algebraic).

Each `bench/<tool>/golden/generate.py` takes a seeded RNG. Re-running
`generate.py` produces byte-identical `inputs.json` + `expected.json`.
Per the tstournament precedent, this is enforced by including a
seed (`SEED = 0xfeedface`-style) at the top of every generator.

### 7. Tier structure (per-tool-customised)

Every solve-tier bench follows the seven-tier skeleton:

| Tier | Probes |
|---|---|
| A | shape edges (deg-1, deg-2, single-var, single-eqn, identity) |
| B | random well-conditioned (per-tool natural scale) |
| C | classical / textbook stress (Hilbert, cyclotomic, cyclic-n, Katsura-n) |
| D | ill-conditioned (large coefficients, near-degenerate cases) |
| E | structural / pathological (Swinnerton-Dyer-like, casus irreducibilis) |
| F | refusal classes (one case per documented refusal tag) |
| G | industrial / literature (matrices from Harwell-Boeing, polys from MGH) where applicable |

Per-tool deviations are documented in the bench's
`verifier_protocol.md`. Total cases per bench: 30–60 (a few percent
of which are tier-F refusals).

### 8. CI integration

`bun run check` runs `bench/_corpus/run-bench.sh bench/<tool>` for
every solve-tier tool that has shipped. Mutation-prove runs as part
of the same gate. Failure of any tier — not just regressions on
previously-passing cases — fails the gate.

There is no GitHub CI (CLAUDE.md Rule 11). All gates are local.

## Examples

### A bench/solve happy-path case (linear)

```jsonc
// inputs.json[0]
{
  "id": "linear-2x2-unique",
  "tier": "A",
  "input": {
    "kind": "record",
    "fields": {
      "equations": <list of two expressions>,
      "vars":      <list with x, y>
    }
  }
}

// expected.json[0]
{
  "id": "linear-2x2-unique",
  "expected": {
    "kind": "record",
    "fields": {
      "vars":         <list with x, y>,
      "solutions":    [<one solution with x→2, y→1, branches=[]>],
      "completeness": <"complete">,
      "warnings":     <[]>
    }
  },
  "oracle_agreement": {
    "wolfram":   "ok",
    "sympy":     "ok",
    "sage":      "skipped",
    "consensus": "wolfram + sympy"
  }
}
```

### A bench/solve-transcendental branched case

```jsonc
{
  "id": "sin-equals-half",
  "tier": "A",
  "input": <Sin[x] == 1/2>,
  "expected": {
    "completeness": "finite-rep-of-infinite",
    "n_branches":   2,
    "verification": "branched-substitution-cube",
    "verification_cube": [-3, 3],
    "completeness_grid": "univariate-50-50-2000pts"
  }
}
```

The verifier doesn't check string-equality of the returned
expressions; it instantiates the candidate's branch parameters and
substitutes, then runs the completeness grid sweep.

### A bench/solve refusal case

```jsonc
{
  "id": "fateman-1991-multi-cosine",
  "tier": "F",
  "input": <Cos[x] + Cos[3*x] + Cos[5*x] == 0>,
  "expected": {
    "kind": "tagged",
    "tag":  "solve/transcendental-multibranch",
    "payload_predicate": {
      "vocabulary":  <list-non-empty>,
      "suggestion":  <string-non-empty>
    }
  },
  "oracle_agreement": {
    "wolfram":   "$Failed (Solve::ifun)",
    "sympy":     "NotImplementedError",
    "consensus": "both refuse"
  }
}
```

This is Fateman 1991's transcript case verbatim. Both v1/v2
Mathematica and Macsyma 1991 refused; modern oracles still
disagree on a clean answer; the workbench refuses with a
class-tagged boundary.

## Why these specific choices

**Why not byte-equality on canonical-form output?** Because two
mathematically-equal answers can have different canonical-form
bytes — `(1 + Sqrt[5])/2` vs `Root[x^2 - x - 1, 1]` are both
valid representations of the golden ratio, both canonical in
their respective forms. Insisting on one privileges either
the radicals path or the algebraic-number path; both are
correct.

**Why a hard `[-3, 3]^n` cube for branch verification?** It's
small enough to enumerate (`7^3 = 343` tuples), large enough
to catch period-off-by-one or sign-flip faults (a `2π·k`-vs-`π·k`
mistake fails on `k = 1` and `k = 2`). Stratified random for
larger `n` keeps the cost bounded.

**Why mutation-prove rather than coverage?** Coverage measures
*lines exercised*, not *invariants captured*. A test that
calls every line but asserts only "didn't throw" passes
coverage but catches no regressions (CLAUDE.md Rule 7).
Mutation-prove operationalises "the verifier *would have*
caught this perturbation" with concrete examples.

**Why three oracles and not just Wolfram?** Single-oracle ground
truth privileges that oracle's representation. When the oracle
is wrong (rare but real — SymPy has shipped factor() bugs,
Wolfram has had `Solve` regressions), single-oracle benches
silently propagate the wrong answer. Two-of-three consensus
catches single-oracle drift.

**Why dropping disagreements rather than picking?** Picking
biases the bench toward whichever oracle's representation
the picker prefers. Dropping is honest: the workbench refuses
to commit to a golden the field can't agree on, and the
disagreement log is a research artefact (these are exactly the
edge cases where the workbench's TS-native implementation
might *be* the third-witness in a future generation).

## Acceptance for this ADR

- This document committed under
  `docs/adr/0019-solve-bench-discipline.md`.
- `bench/_corpus/oracle/` populated per §6 (tracked under P0-6
  bead).
- Every Phase-1+ bench follows the tier structure (§7), the
  invariant-verification discipline (§1), the mutation-prove
  requirement (§4), and the triple-witness admission protocol
  (§3).
- The first bench (`bench/linsolve-q`, P1-1..P1-3) is the
  template; subsequent benches are reviewed against it.

## Sources

- **`tstournament` README + `ts-bench-infra/README.md`** — the
  language-neutral JSON-I/O verifier protocol; mathematical-
  invariant verification; seeded-RNG generator discipline; PDF/
  reference-stripping. The solve epic inherits and extends.
- **`bench/linalg-eigh/PROMPT.md`, `bench/integrate-ode-ivp/`** —
  the workbench-side bench skeleton this ADR is consistent with.
- **CLAUDE.md Rule 6** (port-and-verify; mutation-proving) and
  **Rule 7** ("runs without errors" is not a passing test) —
  the discipline this ADR operationalises.
- **CLAUDE.md Rule 11** (no GitHub CI) — gates are local; the
  bench fits.
- **ADR-0003** — output / error patterns; refusal-class taxonomy
  (tagged `<tool>/<class>`).
- **Fateman 1991** transcripts of `Solve` and Macsyma `solve`
  failures — the source for several Tier F refusal cases.
- **Wolfram, SymPy, SageMath documentation** — for the oracle
  query surface and disagreement-mode expectations.
