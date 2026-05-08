# `@workbench/hypergeometric`

Pure in-process surface for the generalised hypergeometric `pFq`
evaluator. Algorithmic core extracted from
`tools/hypergeometric-pfq/tool.ts`; the tool is now a thin wire-protocol
wrapper around this package.

## What this package exposes

```ts
import { evaluatePFq, type PFqResult } from "@workbench/hypergeometric";
import { cfromInts } from "@workbench/bigfloat";

// 0F0(;;1) = e
const r = evaluatePFq([], [], cfromInts(1n, 0n, 256), 50);

if (r.status === "success") {
  console.log(r.method);   // "closed-form-0F0"
  console.log(r.value);    // BigComplex ≈ 2.718281828...
}
```

Public API:

| Export               | Purpose                                                                         |
|----------------------|---------------------------------------------------------------------------------|
| `evaluatePFq`        | Top-level evaluator with closed-form fast paths + cancellation-driven retry.    |
| `pFqDirectSeries`    | Inner loop, exposed for callers that need to control working precision directly.|
| `cmagBits`           | `log2|z|` magnitude helper — useful for cancellation-tracking outer loops.      |
| `ParameterPoleError` | Thrown by the inner loop on exact non-positive integer in `b`.                  |
| Type exports         | `PFqResult`, `PFqSuccess`, `PFqRefusal`, `PFqOptions`.                          |

## Why a separate package

`@workbench/meijer-core`'s Slater path calls `evaluatePFq` `m` or `n`
times per MeijerG invocation; round-tripping through the value
protocol on every call would be a per-call overhead. Exposing the
algorithm as a typed in-process surface follows the standard
"library + thin wire wrapper" pattern (`packages/quadrature` →
`tools/integrate-1d`, etc.).

The `arbprec: true` determinism contract holds byte-identically
through both surfaces (`tools/hypergeometric-pfq/tool.ts` and direct
`evaluatePFq` calls) because both go through the substrate's
bit-deterministic `BigInt` arithmetic.

## What this package does *not* do (yet)

* `p > q + 1` (asymptotic-only series; needs Borel resummation).
* `p == q + 1` with `|z| ≥ 0.99` (analytic continuation via Pfaff /
  Euler / Bühring / Becken-Schmelcher).
* Recurrence-based shifts when integer-spaced parameters could be
  consolidated (Gil-Segura-Temme 2006).
* Automatic Pfaff/Euler transformations to reduce `|z|`.

These are filed as natural follow-ups; the current `non-convergent`
refusal is the honest behaviour for inputs in those regimes.

## References

* Slater, *Generalized Hypergeometric Functions* (1966), §4.1.
* Olver et al., *NIST Handbook of Mathematical Functions* (2010),
  §16.2 (definition), §16.11 (asymptotic).
* Pearson, Olver, Porter (2017), "Numerical methods for the
  computation of the confluent and Gauss hypergeometric functions".
