# Sturm-TS — index

`Sturm-TS` is a TypeScript port of `Sturm.jl`, an operational-quantum-
mechanics programming language where functions are channels and the
quantum/classical distinction is type-level. This directory holds the
spec materials *as they are absorbed into scientist-workbench*.

## Contents

| File | Status | Purpose |
|---|---|---|
| [`principles.md`](principles.md) | landed (v3.1) | The nine non-negotiable design principles P1–P9 with the v3.1 amendment to P2. Ground truth for any Sturm-related design decision in this repo. |
| [`spec-v3.md`](spec-v3.md) | landed (v3 verbatim, with adapter preamble) | The full v3 PRD body, pasted verbatim from the source transcript on 2026-04-29. The §1 P2 row is the v3 framing; for the v3.1 amendment see `principles.md`. The file's preamble documents five open adaptation items at paste time — see beads issues `4xk` (library §8.1 verification), `r40` (when-body tracer constraints), `4iw` (run() bridge), q0b notes (Bennett-TS dependency), and the §12 Backend out-of-scope note. |

## v3.1 vs v3 — what's amended

The single substantive amendment from v3 to v3.1 is the framing of P2.
The reframe was forced by the design conversation that produced
`docs/worklog/009-sturm-ts-port-planning.md`. In short:

- **v3 framing.** "Boundary is a cast. `prepare(p)` and `observe(q)`
  are the only two boundary operations." This framing inadvertently
  elevated `prepare` and `observe` above other ops, which clashed with
  P3 (op-is-op).
- **v3.1 framing.** The classical/quantum boundary is *type-level* —
  the type system separates classical types from quantum types, and
  `Q<T>` is structurally unrelated to `T`. cq channels (`prepare`,
  `oracle`) and qc channels (`observe`) are the morphisms that cross
  the type distinction. `discard` is the qq → terminal channel
  (partial trace). **All of these are channels in the same category
  as `ry`, `rz`** — uniformly node-shaped, no separate "boundary"
  category.

The amendment sharpens P3 and is the framing that makes ADR-0006
(IR-as-Value) clean: in the IR, every op-node is a peer.

## Pointers

- `principles.md` — P1–P9, v3.1.
- `../adr/0006-sturm-ir-as-value.md` — the workbench-side IR encoding
  that realises these principles.
- `../adr/0005-externalised-entropy.md` — the determinism-contract
  amendment that allows quantum sampling.
- `../adr/0007-distribution-vs-sampling.md` — Born's rule made
  structural.
- `../worklog/009-sturm-ts-port-planning.md` — the 15-issue planning
  shard that this directory's content supports.
