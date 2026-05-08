# `@workbench/meijer-core`

Algorithmic substrate for arbitrary-precision numerical evaluation of
the Meijer G-function `G^{m,n}_{p,q}`. Layer 3 of the seven-layer
stack laid out in
`tstournament/ts-bench-infra/problems/13-meijer-g/PLAN.md`.

## What this package exposes

```ts
import { meijergSlater } from "@workbench/meijer-core";
import { cfromInts } from "@workbench/bigfloat";

// G^{1,0}_{0,1}(_; 1 | 2)  =  2 · e^{-2}
const r = meijergSlater(
  {
    an: [],
    ap: [],
    bm: [cfromInts(1n, 0n, 256)],
    bq: [],
  },
  cfromInts(2n, 0n, 256),
  50,                                    // target precision (decimal digits)
);

if (r.status === "success") {
  console.log(r.value);                  // BigComplex
  console.log(r.method);                 // "slater-series-1"
  console.log(r.cancellationDigitsLost);
}
```

Public API:

| Export                | Purpose                                                                  |
|-----------------------|--------------------------------------------------------------------------|
| `meijergSlater`       | Entry point. Series selection + perturbation + cancellation control.     |
| `evaluateSeries1`/`2` | Per-residue-line kernels. Useful for diagnostic / per-line introspection.|
| `selectSeries`        | The (p, q, m, n, |z|) selection rule alone.                              |
| `detectCoalescence`   | Integer-spaced-pair detection across the parameter sub-tuples.           |
| `perturbParameters`   | The deterministic odd-coefficient perturbation.                          |
| Type exports          | `MeijerGParameters`, `MeijerGSlaterOptions`, result discriminants.       |

## What this package does *not* do

- **Mellin-Barnes contour quadrature** (Layer 5 — `hv0.8`). Quarantine
  refusals from `meijergSlater` are intended to route to that layer
  once it lands.
- **Braaksma asymptotic / hyperasymptotic** (Layer 6 — `hv0.9`).
- **Symbolic dispatch** (Layer 4 — `hv0.6`). When the parameters
  match an Adamchik–Marichev or Roach reduction, the closed-form is
  the right answer; that lives upstream of this package in a future
  pattern-table dispatcher.
- **Top-level orchestration** (Layer 7 — `hv0.10`). `tools/meijer-g`
  will run symbolic → Slater → contour → asymptotic → refuse.

## Design points

* **Pure TypeScript on `BigInt` mantissas.** Inherits the substrate's
  `arbprec: true` determinism contract — bit-identical output across
  runtimes, given the precision dial. ADR-0020.

* **Per-value precision.** Every operation takes `precision` (decimal
  digits) explicitly; no ambient state. The orchestrator computes its
  working precision in bits internally.

* **Deterministic perturbation.** The standard "Johansson hmag"
  approach in textbooks/mpmath is randomly signed, which would break
  the bit-determinism contract. The deterministic odd-coefficient
  pattern (`δ_i = (2i+1) · 2^{-pertBits}`) breaks all integer-spaced
  pairs by construction and produces the same L'Hôpital limit value.

* **Cancellation-driven retry.** The `m` (or `n`) residue terms can be
  exponentially large with a sum exponentially small; the orchestrator
  tracks `max_h |term_h|` against `|sum|` and bumps working precision
  when the gap exceeds the safety margin.

* **Structured refusal.** Every input that cannot be evaluated within
  the Slater path's competence falls through to one of three tagged
  refusals (`quarantine-band`, `non-convergent-pfq`, `input-error`).
  The contract is "produce a numerically correct value, or tell the
  caller honestly *why* not".

## Tests

`packages/meijer-core/test/`:
* `series-select.test.ts` — 10 tests on the dispatcher across the
  decision boundaries.
* `slater.test.ts` — 19 tests cross-checking the Slater path against
  closed-form MeijerG identities (DLMF 16.18, Bateman 5.6) computed
  directly through the bigfloat substrate.

Achievable accuracy is currently capped at ~38–50 dps depending on
the input, by an upstream bug in `@workbench/bigfloat`'s `exp()`
function (filed as `scientist-workbench-4ne`). The Slater algorithm
itself is correct; once that substrate regression closes, assertion
widths can grow.

## References

* Slater, *Generalized Hypergeometric Functions* (1966), §5 (residue
  closure of the Mellin-Barnes contour).
* DLMF §16.17 (case structure), §16.18 (closed-form identities).
* Bateman, *Higher Transcendental Functions* Vol. 1, §5.6.
* F. Johansson 2009 blog post, "Numerical evaluation of MeijerG"
  (algorithm-level description; permitted source under the
  no-direct-porting clause).
