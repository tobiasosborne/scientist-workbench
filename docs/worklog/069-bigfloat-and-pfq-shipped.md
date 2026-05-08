# Worklog 069 — `packages/bigfloat` + `tools/hypergeometric-pfq` shipped

**Date:** 2026-05-08.
**Beads:** scientist-workbench-hv0 (epic; in progress, 2/12 children closed),
-hv0.1 (✓ closed), -hv0.3 (✓ closed). Open follow-ups -hv0.5 (next),
-hv0.2, -hv0.4, -hv0.6 .. -hv0.12.
**Related ADRs:** ADR-0014 (first numerical tier), ADR-0015 (determinism
tier — the parallel additive-flag precedent), ADR-0020 (arbitrary-
precision tier — established this session).
**Lockstep with:** [`docs/worklog/068-arbitrary-precision-tier.md`](068-arbitrary-precision-tier.md)
(the ADR that motivated this work) and the tstournament campaign
worklog at `ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

The tstournament problem-13 "Meijer G mega-test" (epic
scientist-workbench-hv0, registered 2026-05-07) is a multi-month
campaign to implement Meijer G in pure TypeScript across symbolic
dispatch + arbitrary-precision numerical evaluation + honest out-of-
region tagging. Bar: better than Mathematica.

Worklog 068 established ADR-0020 (the arb-prec tier — the
`arbprec: true` flag, the `packages/bigfloat` substrate spec, the
`--precision` standard flag, the value-protocol encoding via
`tagged "bigfloat" / "bigcomplex"`). This shard is the
implementation: substrate + first arbprec tool, both shipped and
cross-validated against Wolfram byte-for-byte.

## What changed

### `packages/bigfloat` shipped — hv0.1 closed

Pure-TS arbitrary-precision substrate. ~5400 LOC across 9 source
files; 229 unit tests (100% pass; 606 assertions). All 50-dps values
cross-validated against `wolframscript -code 'N[..., 50]'` byte-for-
byte.

Files:

- `src/types.ts` — `BigFloat = { mantissa: bigint, exponent: number,
  precision: number }`; `normalise(...)` (round-half-to-even);
  `bitLength`; `validate`; `decimalToBinaryPrecision` (decimal → bits
  via `ceil(d · log2(10)) + safety`).
- `src/arithmetic.ts` — `add / sub / mul / div / sqrt / powInt`. `div`
  uses sticky-bit pattern for correct round-half-to-even on lossy
  divisions; `sqrt` uses Newton iteration on integer square root with
  pre-shift to ensure 2·prec working bits.
- `src/comparison.ts` — exact `cmp / eq / lt / le / gt / ge / sgn`
  plus `abs / neg / isZero`.
- `src/conversion.ts` — `fromInt / fromFloat64 / fromString /
  toFloat64 / toString` (decimal-string, round-half-to-even).
- `src/transcendental.ts` — `ln2 / pi / e` (cached per-precision);
  `exp / log / expm1 / log1p`; full trig (`sin / cos / tan / asin /
  acos / atan / atan2`) with argument reduction modulo π/2 and
  halving + Taylor on the reduced value; hyperbolics (`sinh / cosh /
  tanh / asinh / acosh / atanh`); general `pow`.
- `src/bernoulli.ts` — `bernoulliRational(n)` exact-rational with
  cache; computes B_n via `B_n = -(1/(n+1)) Σ C(n+1, k) B_k`.
- `src/special.ts` — `gamma / lgamma / digamma / trigamma /
  polygamma`. Stirling's asymptotic series + recurrence + reflection;
  working precision bumped to `prec + 96` to absorb cancellation in
  the recurrence path.
- `src/complex.ts` — `BigComplex` with full arithmetic, `csqrt /
  cexp / clog / cpow / cgamma / clgamma / cdigamma`. cdiv uses
  Smith's algorithm; cabs uses safe `max·sqrt(1 + (min/max)²)` form.
- `src/encoding.ts` — value-protocol encoding per ADR-0020:
  `bigfloatToValue / valueToBigFloat`, `bigcomplexToValue /
  valueToBigComplex`, `bigfloatSchema / bigcomplexSchema`.
- `src/index.ts` — barrel.

Cross-validation samples (all matched byte-for-byte):

- Γ(5.5) = 52.342777784553520181149008492418193679490132376114
- Γ(100) at 100 dps (full digit string in tests)
- log Γ(100) = 359.13420536957539877604401046028690961262171808563
- ψ(1) = -γ = -0.57721566490153286060651209008240243104215933593992
- ψ'(2) = π²/6 - 1 = 0.64493406684822643647241516664602518921894990120680
- exp(1+i).re = 1.4686939399158851571389675973266042613269567366290
- Γ(1+i).re ≈ 0.49801566811835604, Γ(1/2+i/2) cross-checked.

### Contract package wired for `arbprec: true`

- `ToolDefinition` gains `arbprec?: boolean` (parallel to
  `nondeterministic?`, `numerical?`).
- `executeToolDef` mutual-exclusion check generalised: at most one of
  the three tier flags may be declared; load-time contract violation
  otherwise. Old "numerical ∧ nondeterministic" check absorbed.
- `mergedFlags` conditionally adds `--precision=<int>` (decimal digits,
  default 50, soft cap 100_000) as a standard flag for `arbprec: true`
  tools. Tools may override the flag's bounds (tighten the cap) but
  cannot rename or retype it.
- Three new contract tests covering the three-way mutual-exclusion.

### `tools/hypergeometric-pfq` shipped — hv0.3 closed

The first arbprec-tier tool in the workbench. 15 unit tests (100%
pass; 30 assertions).

Surface:

```
input:   record { a: list<bigcomplex>, b: list<bigcomplex>, z: bigcomplex }
output:  record { value, achieved_precision, method, n_terms,
                  working_precision, warnings }
       | tagged "hypergeometric-pfq/non-convergent" { reason }
       | tagged "hypergeometric-pfq/parameter-pole" { which, which_idx }
flag:    --precision=<int>  (inherited from arbprec; default 50 dps)
```

Algorithm v0.1: direct power series with cancellation detection
(re-evaluates at higher working precision when summands cancel beyond
a safety margin); closed-form 0F0 (= exp) and 1F0 (= binomial) fast
paths; honest refusal for `p > q+1` (asymptotic-only — Borel
deferred to v0.2) and for `|z| ≥ 0.95` with `p == q+1` (analytic
continuation deferred to v0.2).

Cross-validated identities at 50 dps:

- 0F0(;;1) = e
- 1F0(2;;1/2) = 4
- 1F1(1;1;2) = e²
- 2F1(1,1;2;1/2) = 2 log(2)
- pFq(a;b;0) = 1 (general invariant)

## Why these choices

### Per-value precision (MPFR semantics) over ambient (mpmath)

Compositional clarity. Every BigFloat operation takes its precision
as an explicit argument; reading composed code reveals every precision
decision at the call site. mpmath's `mp.prec` ambient is invisible at
use; MPFR's per-value precision is visible. The TS expert reading the
code wants to see the precision at every operation; the agent
planner generating the code wants to set it explicitly. Both align on
MPFR.

### `BigInt` mantissa, not `Uint32Array`

`BigInt` arithmetic is bit-identical across all JS runtimes by language
specification — every operation in the substrate is bit-deterministic
for free. A `Uint32Array` mantissa with custom add/multiply/divide
would also be bit-identical but would cost ~1500 LOC of substrate to
write and prove correct. The bit-determinism is the load-bearing fact
behind ADR-0020's "stronger than ADR-0015" determinism contract.

### Working-precision bump in Stirling-based gamma family

For `lgamma(z)` at moderate `z`, the recurrence path subtracts
`Σ log(z+k)` from `lgamma(z+N)` — values of comparable magnitude with
catastrophic cancellation in the result. Empirically a 32-bit margin
loses ~30 digits at `z=100`; bumping to 96 bits absorbs the loss with
plenty of safety. Same pattern in `digamma` and `trigamma`.
`shiftThreshold = ceil(work/8)` (rather than `prec/4`) keeps the
recurrence's term count bounded.

### `tagged "bigfloat"` encoding, not new primitive kind

Adding an 11th primitive to PRD §2.2 would be a breaking change. The
`tagged` primitive *is* the protocol's mechanism for "complex types
built from primitives" (cf. ADR-0006: Sturm IR is also tagged); bigfloat
fits the same pattern. Tools that operate on bigfloat declare
`S.tagged("bigfloat", ...)` schemas and validate; tools that don't,
foreign-pass-through.

### Direct power series for `pFq` v0.1 — defer Borel and connection

The MeijerG benchmark's Slater path needs `pFq` evaluation in a
specific regime: `p ≤ q + 1` with `|z|` away from the unit circle.
Direct series with cancellation detection covers that regime cleanly.
The harder cases (`p ≥ q+2` Borel resummation; `2F1` connection at
z near 1) land as v0.2 follow-ups when the MeijerG asymptotic /
contour layers force them. Premature optimisation otherwise.

## Frictions surfaced

- **mpmath's `print(x)` truncates, doesn't round.** Cost me 6 test
  failures across `transcendental.test.ts`, `special.test.ts`, and
  `complex.test.ts`. The values from `mp.dps=50; print(...)` round
  *down* to 50 decimal digits; the bigfloat substrate's `toString`
  does correct round-half-to-even, so they disagree at the last
  digit when the true 51st digit is ≥ 5. **Always cross-check against
  Wolfram (`wolframscript -code 'N[..., 50]'`)** which rounds correctly.
- **Stirling working-precision bump cost two iterations to land.** First
  attempt at `prec + 32` gave 19-digit accuracy on `lgamma(100)`. Diagnostic
  print showed the algorithm itself was correct; the loss came from
  cancellation in the recurrence. Bumping to `prec + 96` resolved.
  Documented in shard for future readers — don't lose this.
- **The atan boundary case |x|=1 needed an explicit branch.** `atan(1)`
  goes through the reciprocal-reduction path (since `|x| ≥ 1`), which
  ends up calling `atanSmall(1/1) = atanSmall(1)` — which throws by
  design. Fix: short-circuit at the boundary to return `±π/4`.
- **`bd dependencies` table is not initialised in this DB.** `bd create
  --deps=...` prints a warning (`Error 1146: table not found:
  wisp_dependencies`) but creates the bead. Dependency info is
  captured in each bead's body text instead, which is good enough for
  `bd ready` (it doesn't enforce blocking) and `bd show` (the body is
  the source of truth for context). If we want true dependency
  enforcement, run `bd doctor` or `bd bootstrap --yes` to recreate
  the schema.

## Acceptance

- Two beads closed: hv0.1 (`packages/bigfloat`), hv0.3
  (`tools/hypergeometric-pfq`).
- 9 commits pushed to `origin/main` between 2026-05-07 and 2026-05-08.
- 244 new tests added across 10 test files, 100% pass rate.
- `bun run check:quick` passes all 4 phases (codegen, typecheck,
  workspace tests, conventions) at session-end commit.
- All 50-dps values byte-for-byte against Wolfram (`wolframscript`
  was the oracle of record; mpmath's display rounding made it
  unreliable as a comparison target).
- ADR-0020 + lockstep PRD/README/CLAUDE.md/worklog 068 already in
  place from the 2026-05-07 session.

## Pointers

- ADR-0020: `docs/adr/0020-arbitrary-precision-tier.md`
- Substrate: `packages/bigfloat/`
- First tool: `tools/hypergeometric-pfq/`
- Campaign plan: `../tstournament/ts-bench-infra/problems/13-meijer-g/PLAN.md`
- Campaign worklog: `../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`
- Bead overview: `bd list -l ts-bench-meijer-g --limit 0`

## Next pickup

`hv0.5` — `packages/meijer-core` Slater residue evaluator. The
algorithmic spec is at the tstournament side
(`sub-problems/13c-meijerg-numerical-slater/DESCRIPTION.md`). Composes
`@workbench/bigfloat` + `tools/hypergeometric-pfq` into a numerical
MeijerG. After it lands, MeijerG is computable across the bulk of the
parameter space (`p ≤ q + 1` with `|z|` away from the unit circle) at
arbitrary precision.

The Slater path is itself a substantive piece (~1000 LOC + tests +
cross-validation against Wolfram `MeijerG`). Plan for a focused
session.
