# Repo map — file layout, substrate corners, scope boundary

> **Tier 3 reference.** Orientation for an agent or contributor who needs
> the lay of the land: where every package and directory lives, the one
> install corner worth knowing, and what the workbench deliberately is
> *not*. Reached from the Tier-0 `README.md`. The design rationale is
> canonical in `PRD-v0.2.md`.

---

## Substrate

TypeScript on Bun. No build step — every tool runs as `bun
tools/<name>/tool.ts`.

```sh
bun --version       # 1.3+
bun install         # one-time, resolves workspace deps
bun run check       # full health check, ~25s
```

**Install corner.** On **snap-Bun** installs the wrapper at `/snap/bin/bun`
is not directly spawnable from inside another snap-confined Bun process. The
workbench's subprocess machinery handles this transparently via
`process.execPath` and `realpathSync`, so no `BUN_BIN` export is required.
If you ever see `resolveBunBinary: …` errors, set `BUN_BIN` to the
underlying binary (typically `/snap/bun-js/current/_bun/bin/bun`). See
`docs/adr/0001-subprocess-plumbing.md`.

---

## File layout

```
PRD-v0.2.md              design spec — canonical for design questions
README.md                Tier-0 bootstrap for an agent landing in the repo
wb.ts                    the `wb` discovery CLI (bun wb.ts); not a value-protocol tool
LICENSE                  AGPL-3.0-or-later

docs/
  CATALOG.md             generated tool catalog (do not hand-edit; bun scripts/gen-catalog.ts)
  protocol.md            the value protocol, schema language, invocation, provenance
  contract.md            the seven-artefact contract; writing a tool; hard requirements
  repo-map.md            this file
  adr/                   architecture decision records
  worklog/               sharded log of substantive iterations

packages/
  protocol/              value protocol; canonical encoder, parser, hash, validator, Schema
  contract/              runTool dispatcher, provenance store, registry helpers, GoldenSpec
  cas-core/              multivariate Q[x_1,…,x_n] / Q(x_1,…,x_n) arithmetic; symbolic
                         differentiator (closed elementary + ADR-0023 special-function
                         vocabulary, 38 heads); ring-generic Poly<T> / RatFn<T>; `Root[poly, k]`
  mod-core/              modular arithmetic (modPow, modInv) and Number-Theoretic Transform
  json-bridge/           translate between raw JSON and canonical Value, schema-hint-driven
  sturm-ir/              Sturm channel IR (ADR-0006): typed Channel/Op forms, schema, traversal
  sturm/                 TS-native frontend DSL (ADR-0009): trace, qbool, qreg, when, ry/rz, …
  sturm-lib/             Patterns library on top of @workbench/sturm: H, X, Z, S, T, cx, cz, …
  linalg-core/           First numerical-tier package (ADR-0014): dense Float64Array Matrix,
                         LU + partial pivoting, solve with iterative refinement, condition
                         estimator; ADR-0035 ComplexMatrix + eighComplex
  qinfo/                 Quantum-information substrate (ADR-0034); one Matrix type covers real
                         and complex via optional imaginary part; index-only operation surface
  quadrature/            Adaptive 1D Gauss-Kronrod quadrature (G7K15) + closed-vocabulary
                         numeric expression evaluator
  lbfgs-projected/       L-BFGS with active-set projection for box-constrained minimisation
  poly-factor/           Exact univariate polynomial factorisation over ℚ (Berlekamp-Zassenhaus)
  real-roots/            Real-root isolation over ℚ[x] (Vincent-Akritas-Strzebonski + LMQ)
  alg-num/               Algebraic-number substrate; `Root[poly, k]` primitive (ADR-0018) +
                         four-field arithmetic closure on it
  solve/                 Top-level `Solve[]`-class dispatcher substrate
  groebner/              Gröbner basis substrate over ℚ (Buchberger + FGLM + shape lemma)
  ode-core/              ODE integration substrates on Float64Array (RK45 / Radau / symplectic)
  compose/               In-process composition layer (ADR-0012): loadWorkbench, wb.run / wb.pipe
  bigfloat/              Arbitrary-precision binary floating-point (BigInt mantissa); first
                         arb-prec substrate (ADR-0020)
  hypergeometric/        Generalised hypergeometric pFq evaluator
  simplex-q/             Exact-rational LP simplex substrate (ADR-0031)
  meijer-core/           Meijer G-function algorithmic substrate (Slater / symbolic / contour)
  cone-core/             SCS-style convex-cone solver substrate (ADR-0030)

tools/
  <name>/
    tool.ts              entry point — calls runTool({...}); its `examples` are the golden source
    package.json         workspace manifest
    README.md            one-page tool reference
    goldens.spec.ts      OPTIONAL — supplementary GoldenSpec[] beyond examples
    goldens/             generated *.golden.json — folded from examples (do not edit by hand)

scripts/
  new-tool.ts            scaffold a new tool directory
  generate-goldens.ts    fold each tool's examples (+ optional goldens.spec.ts) into goldens
  gen-catalog.ts         regenerate docs/CATALOG.md from the registry
  gen-workbench-barrel.ts regenerate the @workbench/compose typed barrel from the registry
  check.ts               combined health check (run via `bun run check`)
  demo-scope.sh          worked examples covering the full v1 scope
  setup-device.sh        one-shot per-device setup: tracked git hooks + beads bootstrap

.githooks/               tracked git hooks (auto-export beads on commit, auto-import on pull);
                         activated per-clone via scripts/setup-device.sh
```

**Fresh clone setup:** run `sh scripts/setup-device.sh` once after `git
clone`. Idempotent. See `CLAUDE.md` Rule 9 for the multi-device beads
discipline.

(For the substrate-package one-liners above abbreviated, the authoritative
detailed descriptions live in each `packages/<name>/README.md`.)

---

## What this is *not*

- Not a BLAS-scale numerics library — see PRD §1.2 (no PDE-class solvers, no
  GPU, no distributed). The bounded numerical tier (ADR-0014/0016:
  `linalg-{solve,qr,svd,eigh}`, plus `integrate-1d`, `integrate-ode-ivp`,
  and `optimize-lbfgs-projected`) lives alongside the symbolic core. Per
  ADR-0016 the previous `n ≤ 200` cap is *withdrawn* — large inputs run with
  measurement-driven scale warnings and OOM as the only physical refusal.
  Phone deployment (Bun-in-browser-on-mobile, where Python/SciPy aren't
  available) is the design forcing function; FFI to OpenBLAS is a future
  option (bead `e7y`) for production-scale workloads.
- Not Mathematica replication — the legacy stack's failure mode (composition
  through global mutable state) is exactly what is being moved away from.
- Not (yet) a notebook surface — Phase 4 of the roadmap.
- Not (yet) proof-carrying — Phase 5; the v1 ecosystem is the *substrate*
  that makes proof-carrying outputs possible.

The discipline that does not bend is the contract. Everything else iterates
freely — duplication of tools is exploration, not waste.

---

## Pointers

- **Design questions:** `PRD-v0.2.md`. Sections marked `[SETTLED]` are not
  up for debate without strong reason.
- **Per-tool detail:** `tools/<name>/README.md`.
- **Worked examples covering the v1 scope:** `bun scripts/demo-scope.ts`
  (in-process, typed; ~0.6s for the full demo suite). The shell version
  `bash scripts/demo-scope.sh` runs the same demos through subprocess pipes
  and is preserved as a sanity-check / fallback (~4.5s).
- **The substrate decision (TS/Bun) is settled.** Re-read PRD §1.3 before
  relitigating; four pillars all need to change before the question
  reopens.
- **CAS trajectory:** `docs/cas-core-roadmap.md` — the working document for
  `packages/cas-core`.
- **Numerics + vis research:** `docs/numerics-and-vis-2026-04-29.md` — the
  precursor note naming the symbolic-only coverage gap. Cited by
  ADR-0014/0015 and `packages/linalg-core`.
