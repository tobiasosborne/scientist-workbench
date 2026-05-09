# Worklog

A sharded log of substantive work on `scientist-workbench`. One shard per
discrete iteration; each is self-contained so a reader landing cold on a
shard understands what changed and why.

The point is **continuity**: future-you, future agents, and future
collaborators reach for the worklog when "git blame says I changed this
line, but why?" That's what these shards are for. Keep them honest —
write the frictions and the dead ends as well as the wins.

| #   | Title                                                                     | Date       | Issues                          |
|-----|---------------------------------------------------------------------------|------------|---------------------------------|
| 001 | [NTT port from tstournament 02-NTT](001-ntt-port-from-tstournament.md)    | 2026-04-28 | (port; surfaced 9 frictions)    |
| 002 | [F1+F2 — subprocess plumbing centralised](002-spawn-machinery.md)         | 2026-04-28 | scientist-workbench-rpb.1       |
| 003 | [F3 — scaffolder accepts `--uses`](003-scaffolder-uses.md)                | 2026-04-28 | scientist-workbench-rpb.2       |
| 004 | [F8 — schema `kindOf` annotations](004-schema-kind-annotations.md)        | 2026-04-28 | scientist-workbench-rpb.7       |
| 005 | [F7 — `@workbench/json-bridge` package](005-json-bridge.md)               | 2026-04-28 | scientist-workbench-rpb.6       |
| 006 | [F5 — output error patterns + mod-inv migration](006-error-patterns.md)   | 2026-04-28 | scientist-workbench-rpb.4       |
| 007 | [F6 + F4 + F9 — lint, example-count, TDD shapes](007-conventions-and-docs.md) | 2026-04-28 | scientist-workbench-rpb.{5,3,8} |
| 008 | [Schema as a first-class type](008-schema-as-first-class-type.md)         | 2026-04-28 | scientist-workbench-{ktd,73m,7q0,1d9} |
| 009 | [Sturm-TS port: planning shard](009-sturm-ts-port-planning.md)            | 2026-04-29 | scientist-workbench-{i8m,x9x,cdz,0lo,dwg,z8w,tkx,564,kw1,bir,q0b,733,8e8,o1q,can} (planned) |
| 010 | [ADR 0005: externalised entropy](010-externalised-entropy.md)             | 2026-04-29 | scientist-workbench-i8m         |
| 011 | [ADR 0006: IR-as-Value encoding](011-ir-as-value.md)                      | 2026-04-29 | scientist-workbench-x9x         |
| 012 | [ADR 0007: distribution-vs-sampling](012-distribution-vs-sampling.md)     | 2026-04-29 | scientist-workbench-cdz         |
| 013 | [Sturm-TS v3.1 spec amendment](013-sturm-ts-spec-v3-1.md)                 | 2026-04-29 | scientist-workbench-0lo         |
| 014 | [packages/sturm-ir](014-packages-sturm-ir.md)                             | 2026-04-29 | scientist-workbench-dwg         |
| 015 | [tools/sturm-simplify](015-sturm-simplify.md)                             | 2026-04-29 | scientist-workbench-z8w         |
| 016 | [cas-core ring-generic refactor](016-cas-core-ring-generic.md)            | 2026-04-29 | scientist-workbench-{but,t87}   |
| 017 | [cas-core algebraic numbers](017-cas-core-algebraic-numbers.md)           | 2026-04-29 | scientist-workbench-1s4         |
| 018 | [tools/sturm-execute (v0.1 float64)](018-sturm-execute.md)                | 2026-04-29 | scientist-workbench-tkx (jfj filed) |
| 019 | [tools/sturm-equivalent (Phase 1 killer demo)](019-sturm-equivalent.md)   | 2026-04-29 | scientist-workbench-564             |
| 020 | [tools/entropy-source (Phase 2 kick-off)](020-entropy-source.md)          | 2026-04-29 | scientist-workbench-kw1             |
| 021 | [tools/sturm-sample (Born's rule applied)](021-sturm-sample.md)           | 2026-04-29 | scientist-workbench-bir             |
| 022 | [Sturm-TS v3 spec absorbed; §8.1 H verified buggy](022-spec-v3-absorption-and-h-verification.md) | 2026-04-29 | scientist-workbench-{4xk closed; 1td, r40, 4iw filed} |
| 023 | [Channel combinators (sturm-controlled, sturm-then, sturm-tensor)](023-channel-combinators.md) | 2026-04-29 | scientist-workbench-o1q             |
| 024 | [TS-native frontend DSL: agents-as-TS-experts is the spec](024-ts-native-frontend-dsl.md) | 2026-04-30 | (none — beads db not initialised; ADR-0009 is the spec) |
| 025 | [Grover end-to-end via @workbench/sturm + sturm-lib + sturm-find](025-grover-end-to-end.md) | 2026-04-30 | (none — beads db not initialised) |
| 026 | [Code-health pass: protocol DRY, dead code, literate ntt](026-code-health-protocol-dry.md) | 2026-05-02 | scientist-workbench-{9s4, cji, y8p, 10w, hgc, 61s} |
| 027 | [Multi-device beads sync via tracked git hooks](027-multi-device-beads-sync.md) | 2026-05-02 | (infra; closes the worklog 024/025 tracker drift) |
| 028 | [defineTool / runTool split, registry without spawning](028-define-runtool-split.md) | 2026-05-03 | scientist-workbench-yth |
| 029 | [Typed flag declarations on ToolDefinition](029-typed-flags.md) | 2026-05-03 | scientist-workbench-rej (5gl filed as follow-up) |
| 030 | [Polynomial GCD in cas-core](030-polynomial-gcd.md) | 2026-05-03 | scientist-workbench-djr (6uc filed as v0.2 modular follow-up) |
| 031 | [First numerical tier — linalg-core + linalg-solve (ADR-0014)](031-first-numerical-tier.md) | 2026-05-03 | scientist-workbench-n2a (epic), -abj (ADR), -0ky (pkg), -ynd (tool), -gyb (docs), -bf0 (this shard); follow-ups -71f -wmm -0ck -e7y -va1 |
| 032 | [Composition layer MVP (`@workbench/compose`) + provenance lockstep (ADR-0012)](032-composition-layer-mvp.md) | 2026-05-03 | scientist-workbench-{c24, inm, 9n1, 23i, o8t} closed; remaining: -46z, -4t5, -mtw, -csa, -e0h |
| 033 | [Typed barrel for `@workbench/compose` (`wb.modPow({...})`)](033-typed-barrel.md) | 2026-05-03 | scientist-workbench-4t5 |
| 034 | [`Workbench.lookup` + `runMemoized`: cache by input hash](034-lookup-and-runMemoized.md) | 2026-05-03 | scientist-workbench-{mtw, csa} |
| 035 | [Fluent `wb.pipe(...)` + demo-scope.ts migration (full DAG closed)](035-pipe-and-demo-migration.md) | 2026-05-03 | scientist-workbench-{46z, e0h} |
| 036 | [ADR-0015: determinism tier (numerical contract relaxation)](036-determinism-tier.md) | 2026-05-04 | scientist-workbench-0ck (closes); -auz, -2t4 filed |
| 037 | [ADR-0015 implementation: numerical tier wired end-to-end](037-determinism-tier-implementation.md) | 2026-05-04 | implementation behind 0ck (already closed); 24 new tests, 3 mutations proven |
| 038 | [oracle: return record on every path; CI exits via output inspection](038-oracle-throw-not-exit.md) | 2026-05-04 | scientist-workbench-qf1 |
| 039 | [`integrate-1d` ships; orchestration meta-experiment yields code-vs-summary divergence](039-integrate-1d-and-orchestration-experiment.md) | 2026-05-04 | (none — meta-experiment + tool ship) |
| 040 | [`optimize-lbfgs-projected` ships: third numerical-tier tool, L-BFGS-B class](040-optimize-lbfgs-projected.md) | 2026-05-04 | (none filed) |
| 041 | [`cas-diff` ships: symbolic differentiation over the closed numerical vocabulary](041-cas-diff.md) | 2026-05-04 | scientist-workbench-cnv |
| 042 | [tier-1 vocabulary extension: inverse trig + hyperbolics + log bases](042-tier1-vocab-extension.md) | 2026-05-04 | scientist-workbench-0jn |
| 043 | [`linalg-qr` via the tstournament-protocol bench (49/49, 343/343)](043-linalg-qr-via-bench.md) | 2026-05-05 | scientist-workbench-3jq |
| 044 | [`linalg-svd` via the tstournament-protocol bench (49/49, 392/392)](044-linalg-svd-via-bench.md) | 2026-05-05 | scientist-workbench-c03 |
| 045 | [Numerical-tier `n` cap lift (ADR-0016) + NIST industrial benchmarks](045-numerical-tier-cap-lift-and-industrial-bench.md) | 2026-05-05 | scientist-workbench-32s |
| 046 | [`linalg-svd` Golub-Reinsch path (dual-algorithm dispatch by size)](046-svd-golub-reinsch.md) | 2026-05-05 | scientist-workbench-y9u |
| 047 | [`linalg-eigh` via the tstournament-protocol bench (46/46, 316/316)](047-linalg-eigh-via-bench.md) | 2026-05-05 | scientist-workbench-evb |
| 048 | [`integrate-ode-ivp` via the tournament-protocol bench (29/29)](048-integrate-ode-ivp.md) | 2026-05-05 | scientist-workbench-l6p |
| 049 | [`integrate-ode-stiff` via the tournament-protocol bench (19/19)](049-integrate-ode-stiff.md) | 2026-05-05 | scientist-workbench-09g |
| 050 | [`integrate-ode-symplectic` via the tournament-protocol bench (17/17)](050-integrate-ode-symplectic.md) | 2026-05-05 | scientist-workbench-4gr |
| 051 | [`poly-factor-q` bench + first substrate (Yun square-free, 17 tests / 607 expects)](051-poly-factor-bench-and-squarefree.md) | 2026-05-06 | scientist-workbench-{4nz, 3s2, 153} |
| 052 | [`poly-factor` end-to-end: Hensel + Berlekamp + recombination + tool ship (Phase 2 closes)](052-poly-factor-end-to-end.md) | 2026-05-06 | scientist-workbench-{0fy, p3d, 5k6, v13, d0o} |
| 053 | [`poly-roots`: closed-form radical roots for deg ≤ 4 (Cardano + Ferrari)](053-poly-roots.md) | 2026-05-06 | scientist-workbench-{1yu, 58q} |
| 054 | [`solve`: top-level dispatcher (linear + univariate-poly v0.1)](054-solve-dispatcher.md) | 2026-05-06 | scientist-workbench-{77b, cfd, fij, 80x} |
| 055 | [`solve` transcendental invert layer + linear-arg compound (sin(2x+1)…)](055-transcendental-invert.md) | 2026-05-06 | scientist-workbench-{ii0, 37r} |
| 056 | [`bench/solve` headline bench (yq2)](056-bench-solve-headline.md) | 2026-05-07 | scientist-workbench-yq2 |
| 057 | [`bench/poly-roots-radical` (iyj) + demo-scope solve entries (b22)](057-bench-poly-roots-radical.md) | 2026-05-07 | scientist-workbench-{iyj, b22} |
| 058 | [`bench/real-root-isolate` (q8q): VAS-LMQ bench](058-bench-real-root-isolate.md) | 2026-05-07 | scientist-workbench-q8q |
| 059 | [`packages/real-roots` + `tools/real-root-isolate` (rra): VAS-LMQ ship](059-real-roots-vas-lmq.md) | 2026-05-07 | scientist-workbench-rra |
| 060 | [alg-num: `Root[poly, k]` type + canonicalisation (xyt)](060-alg-num-root-type.md) | 2026-05-07 | scientist-workbench-xyt |
| 061 | [alg-num: `refineRoot` (xkz) + `makeRootByIndex` (6cd)](061-alg-num-refine-and-byindex.md) | 2026-05-07 | scientist-workbench-{xkz, 6cd} |
| 062 | [alg-num: resultant arithmetic on Roots (rti)](062-alg-num-arithmetic.md) | 2026-05-07 | scientist-workbench-rti |
| 063 | [`tools/poly-roots` deg-≥5 lift: `Root[]` for irreducible quintics+ (yoc)](063-yoc-poly-roots-deg5.md) | 2026-05-07 | scientist-workbench-yoc |
| 064 | [`tools/solve` deg-≥5 Root[] wiring (yoc follow-on)](064-solve-deg5-root.md) | 2026-05-07 | (unbeaded; logical follow-on of yoc) |
| 065 | [`tools/alg-num-arith` ships: wire envelope for `Root[poly, k]` field arithmetic](065-alg-num-arith-tool.md) | 2026-05-07 | (substrate for bead `iay`) |
| 066 | [`bench/alg-num-arith/` ships: cross-validate against SymPy `qqbar` (iay)](066-iay-bench-alg-num-arith.md) | 2026-05-07 | scientist-workbench-iay |
| 067 | [algNumInv `reverseCoefficients` term-order fix (5zh)](067-palindromic-minpoly-inv-fix.md) | 2026-05-07 | scientist-workbench-5zh |
| 068 | [ADR-0020: arbitrary-precision tier (bigfloat substrate; tstournament problem-13 forcing)](068-arbitrary-precision-tier.md) | 2026-05-07 | scientist-workbench-hv0 (epic), -hv0.1 (substrate; in-progress) |
| 069 | [`packages/bigfloat` + `tools/hypergeometric-pfq` shipped (hv0.1, hv0.3 closed)](069-bigfloat-and-pfq-shipped.md) | 2026-05-08 | scientist-workbench-hv0.1 (closed), -hv0.3 (closed); next: -hv0.5 |
| 070 | [`packages/meijer-core` Slater path + thin wire tool shipped (hv0.5 closed; bigfloat::exp regression filed)](070-meijer-core-slater.md) | 2026-05-08 | scientist-workbench-hv0.5 (closed), -4ne (P1 bug filed) |
| 071 | [`bigfloat::exp` "P1 regression" was a false alarm; principled hardening applied](071-bigfloat-exp-false-alarm-and-hardening.md) | 2026-05-08 | scientist-workbench-4ne (closed as false alarm) |
| 072 | [`packages/quadrature` arb-prec generalisation shipped (`gaussKronrodAdaptiveBF`)](072-quadrature-arbprec.md) | 2026-05-08 | scientist-workbench-hv0.7 (closed); ADR-0021 |
| 073 | [`packages/meijer-core` Mellin-Barnes contour layer + BigComplex G7K15 driver shipped (`hv0.8`)](073-meijer-contour.md) | 2026-05-08 | scientist-workbench-hv0.8 (closed); ADR-0022 |
| 074 | [`cas-core` special-function AST vocabulary extension shipped (`hv0.2`)](074-cas-core-special-functions.md) | 2026-05-08 | scientist-workbench-hv0.2 (closed); ADR-0023 |
| 075 | [Tanh-sinh quadrature WIP — driver shipped, smooth-analytic floor unresolved](075-tanh-sinh-wip.md) | 2026-05-08 | scientist-workbench-6f8 (claimed, **not closed**); ADR-0024 (partial) |
| 076 | [`meijer-core` Adamchik–Marichev symbolic dispatch shipped (`hv0.6`)](076-meijerg-symbolic-dispatch.md) | 2026-05-08 | scientist-workbench-hv0.6 (closed); ADR-0025 |
| 077 | [Tanh-sinh quadrature precision floor resolved — substrate-div integrand-contract bug](077-tanh-sinh-fixed.md) | 2026-05-08 | scientist-workbench-6f8 (resolved); ADR-0024 (shipped) |
| 078 | [`meijer-core` Braaksma asymptotic (Layer 6) shipped (`hv0.9`)](078-meijerg-asymptotic.md) | 2026-05-08 | scientist-workbench-hv0.9 (closed); ADR-0026 |
| 079 | [`bench/hypergeometric-pfq` tier-graded battery shipped (`hv0.4`)](079-bench-hypergeometric-pfq.md) | 2026-05-09 | scientist-workbench-hv0.4 (closed) |
| 080 | [`tools/meijer-g` top-level dispatcher (Layer 7) shipped (`hv0.10`)](080-meijerg-dispatcher.md) | 2026-05-09 | scientist-workbench-hv0.10 (closed); ADR-0027 |

## How to add a new shard

1. Pick the next number (`00N-<short-slug>.md`).
2. Use the structure: **Context → What changed → Why these choices →
   Frictions surfaced → Acceptance → Pointers**.
3. Aim for ~200 lines. Prose-dominant, code blocks for diff highlights only.
4. Add a row to the table above.
5. If the shard introduces an architectural decision, file a paired ADR
   under `docs/adr/` and reference it.

## Cross-references

- ADRs: `docs/adr/`
- Issue tracker: `bd list --status open` (beads, stealth-installed)
- Memory (cross-session): `~/.claude/projects/.../memory/`
- Agent guidance: `CLAUDE.md` at repo root
