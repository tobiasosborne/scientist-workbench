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
| 081 | [`bench/meijer-g/` golden master battery shipped (`hv0.11`)](081-meijerg-bench.md) | 2026-05-09 | scientist-workbench-hv0.11 (closed) |
| 082 | [tstournament problem-13 staging shipped (`hv0.12`)](082-meijerg-tstournament-staging.md) | 2026-05-09 | scientist-workbench-hv0.12 (closed); campaign closed |
| 083 | [arbprec `--precision` flag wired through runner + compose (lc1 / rn2)](083-arbprec-precision-flag-wiring.md) | 2026-05-09 | scientist-workbench-{lc1, rn2} (closed); single source of truth in `mergedFlags` |
| 084 | [`bigfloat::div` precision-floor fix (`djp`) — substrate lifts the integrand contract from worklog 077](084-bigfloat-div-precision-floor-fix.md) | 2026-05-09 | scientist-workbench-djp (closed) |
| 085 | [Meijer G dispatcher coalescence fixes (`hv0.11.1`)](085-meijerg-coalescence-fixes.md) | 2026-05-09 | scientist-workbench-{7usr, fwsz} (closed); empirical precision estimator + ≥3-pole structured refusal |
| 086 | `bench/` → corpus migration COMPLETE: linalg trio (eigh + qr + svd) + ODE trio (ivp + stiff + symplectic) + real-root-isolate + poly-roots-radical + alg-num-arith + poly-factor-q + linsolve-q + solve + hypergeometric-pfq + meijer-g shipped — every workbench bench is now in the corpus; ~179 MB + ~4.3 MB + 1.3 MB other freed (ADR-0028, spup Pillar 2 closed); poly-roots-radical surfaced & fixed a canonicalisePolyTerms ascending-sort bug in packages/poly-factor; solve grades 94/100 with 6 pre-existing transcendental-lane drifts (3g9x; blocks b55); hypergeometric-pfq + meijer-g are arbprec-tier (platform_pinned=false; self-contained verify.ts on @workbench/bigfloat at 128 dps, no Python runtime) | 2026-05-10 | scientist-workbench-{uh2d, annr, dx0l, g6dn, ifng, yj80, 3pby, x18p, 5usl, 41yl, mnnm, upaz, 5gg5, gaih} (all closed; 3g9x open tracks the 6 transcendental-lane drift cases — blocks b55; si37 open tracks corpus schema extension for structured [meta.known_failures]); eigh 46/46, qr 56/56, svd 56/56, ivp 17/17, stiff 19/19, symplectic 17/17, real-root-isolate 37/37, poly-roots-radical 50/50, alg-num-arith 32/32, poly-factor-q 56/56, linsolve-q 46/46, solve 94/100 (rand-trans-{002,004,006,008,009,013} drift), hypergeometric-pfq 53/53, meijer-g 95/95 cases; meijer-g corpus@ecb7e05 |
| 087 | [Gröbner substrate + multivariate-poly `solve` lane (`x8d`)](087-groebner-substrate-and-multivariate-solve.md) — `packages/groebner/` (Buchberger 1965 + sloppy sugar (Giovini-Mora-Niesi-Robbiano-Traverso 1991) + Gebauer-Möller pruning in strict B/W93 §5.5 form + interreduction; FGLM order conversion (FGLM 1993); shape-lemma extraction (Becker-Mora-Marinari-Traverso 1994)) + `tools/groebner-basis/` (corpus bench `groebner-basis` 80/80 cases, 400/400 invariants) + `tools/solve` extended with the multivariate-poly lane via `solveGroebner`; ADR-0029 codifies the seven research-note decisions; `bench/solve` regrades 70/100 (24 mv-tier cases now correctly emit happy-path that the corpus verifier expects refusal — corpus-side follow-up filed as `ay4u`; 6 transcendental-drift unaffected = `3g9x` scope). | 2026-05-10 | scientist-workbench-x8d (Phase 3 ships); scientist-workbench-ay4u (filed for the corpus-side `multivariate-poly` lane in `bench/solve/golden/verify.ts` + reference) |
| 088 | [`solve` bench close-out: 100/100 cases, 354/354 invariants (`3g9x` + `ay4u`)](088-solve-bench-100-100-close-out.md) — Sub-shape D in `transcendental.ts`'s linear-arg decomposer (handles `head(c·varName − b)`); real-root count gate + alg-num `ROOT_VAR` rename in `groebner/shape-extract.ts`'s deg-2/3/4 path (closes complex-root leak through Cardano radicals); corpus-side `multivariate-poly` lane in `verify.ts` + reference's five-stage gate (lex GB → const-1 → Macaulay → shape-lemma → SymPy solve) mirroring `solveGroebner` bit-for-bit; verify.ts unary-after-binary `+`/`-` parser fix + `neg` head support + asymmetric grid window for transcendental completeness check.  Bench grade: 70 → 96 → 98 → 100/100. | 2026-05-10 | scientist-workbench-{3g9x, ay4u} (closed); -b55 (transcendental scope close-out, unblocked) |
| 089 | [LP bench onramp for Phase 1 (`eg9j`)](089-lp-bench-onramp.md) — Reading order + feedback-loop doc for an implementer landing on the convex-cone solver tier.  Phase 0 (the LP bench infrastructure in the corpus repo) closed; this shard is the bridge to Phase 1 (`cp9k` → `2ivi` / `wx3m`).  Names the v0.1 bench gate (21/21 lp-netlib + 29/29 lp-small, reframed from ADR-0030's nominal 98/114 + 110/114 pending v0.2 sparse wire format).  Phase-dependency chain documented. | 2026-05-11 | scientist-workbench-{1few, oz67} (closed -- corpus-side Phase 0 shipped); -{cp9k, 2ivi, wx3m, psuw} (Phase 1+ work ready to start; cp9k is the entry point) |
| 090 | [`tools/lp-solve` v0.1: arbprec rational engine (ADR-0031)](090-lp-solve-arbprec.md) — Exact-rational revised two-phase simplex over ℚ wrapped in the float64 wire (ADR-0030 §C/§D).  `packages/simplex-q` substrate: rat-cmp + product-form B⁻¹ + two-phase orchestrator with Bland-rule anti-cycling.  The killer claim: `achieved_precision ≈ ε_machine` on small dense, four orders past ADR-0030's 1e-12 ceiling, because the interior is exact ℚ and the only rounding is the wire encode.  Bench grade: 24/29 lp-small; netlib above scale ceiling (n ≥ 50 times out).  Original wx3m bead split into `wx3m` (arbprec, done today) + `hnyu` (float lane, future) + `prfp` (IPM lane, future).  Frictions: IEEE-754 sign-bit decode bug, row-negation dual sign-flip, exact vs ε-feasible float input. | 2026-05-11 | scientist-workbench-{wx3m, taui} (closed); -{hnyu, prfp} (registered as follow-ups) |
| 091 | [`@workbench/solver-ipm` substrate landing](091-solver-ipm-substrate-landing.md) — Phase 1 of landing a Mehrotra 1992 predictor-corrector primal-dual IPM substrate (LP + SDP, NT/AHO/HKM directions) alongside the same-day arbprec simplex ship.  Drops `packages/solver-ipm/` (17 src + 8 test files); substrate-only landing, no tool integration yet, simplex-q / lp-solve / ADR-0031 / worklog-090 untouched.  Adjustments: portable co-located `test/fixtures/sdp.dat-s`; `.ts` imports renamed to `.js` (workbench convention); 27 strict-null violations fixed (typed-array compound assignment under `noUncheckedIndexedAccess`).  Tests: 68/68 green.  Surfaced a pre-existing main-branch oracle failure on `lp-solve` golden 05 (filed as `2dhc`).  | 2026-05-11 | scientist-workbench-prfp (claimed, IPM lane dispatch); -{2zed, v4jd, 6or7, j1gd, 2dhc} (filed: ADR-0032, sdp-solve tool, contract hardening, algorithm hygiene, pre-existing golden bug) |
| 092 | [`tools/lp-solve` lane dispatcher (`prfp` closes)](092-lp-solve-lane-dispatcher.md) — Phase 2 of the parallel-agent merge.  Wires `@workbench/solver-ipm` into `tools/lp-solve` behind `--method=auto\|exact\|ipm` (default `auto`).  Free-variable splitting hoisted out of the engine call so both lanes see standard-form input.  Auto-dispatch threshold `m + splitN ≤ 50` → exact (bit-identical, world-first), else → IPM (NETLIB-scale).  Public wire schema unchanged; existing 12 goldens byte-identical (auto-dispatch routes all of them to exact).  Manual probe: `--method=ipm` on a 2-var LP returns `optimal` in 4 iters, `method: "solver-ipm"`.  Status taxonomy mapping: solver-ipm's `SolverStatus` collapses to ADR-0030 §A.3 wire taxonomy. | 2026-05-11 | scientist-workbench-prfp (closes) |
| 093 | [`solver-ipm` workbench-contract hardening (`6or7` closes)](093-solver-ipm-contract-hardening.md) — Phase 3 of the parallel-agent merge.  Substrate package hardened to workbench discipline: (1) NETLIB + lp-small tests rewritten from sweep-and-log to hard `expect()` assertions per case (Rule 7), `KNOWN_CONVERGENCE_GAPS = {brandy}` + `KNOWN_SUBSTRATE_GAPS = {H_malformed_cone, H_non_finite_input}` carved out with named-set comments tracking j1gd; (2) portable corpus path via `loadSuite()` (env `WORKBENCH_CORPUS` or sibling `../scientist-workbench-corpus`); (3) `--test` hook on `tools/lp-solve` exercising both lanes; (4) shared `toWireStatus` lifted to `packages/solver-ipm/src/solver/Status.ts` (single-source-of-truth between tool and tests), local `mapIpmStatus` in tool.ts deleted.  `numerical: true` + `--platform-fingerprint` already wired by the runner via `defineTool` annotation, no new code needed. 50/50 hardened tests pass with 142 `expect()` calls. | 2026-05-11 | scientist-workbench-6or7 (closes) |
| 094 | [`tools/sdp-solve` v0.1 + corpus `sdp-sdplib` bench (`v4jd` + `jkz6` close)](094-sdp-solve-and-corpus-bench.md) — Wraps `@workbench/solver-ipm`'s SDP IPM (NT primary, AHO A/B, HKM debug-only) into `tools/sdp-solve` behind ADR-0030 §C wire (PSDCone with strict-Mosek-format √2 off-diagonal scaling). v0.1 cone vocabulary: PSDCone + ZeroCone (NonNegCone deferred to v0.2 / bead `67nj`). 14 goldens, --test smoke hook, README. Corpus side: `benchmarks/sdp-sdplib/` shipped end-to-end with Mosek + COPT dual-witness oracle (Gurobi excluded — no SDP support; COPT runs in non-commercial size-limited free mode, n ≤ 2000 PSD dim covers all v0.1 cases with margin). 6 SDPLIB classics — control1/2/3, hinf2, theta1, mcp100. Tool grade: 3/6 cases, 63/66 invariants. The 3 failing cases (control2/3, hinf2) hit the substrate's SDP convergence gap — analog of LP NETLIB-`brandy`, filed as bead `qmrv`. Frictions: COPT writes license-banner to fd 1 from C library (fixed via `os.dup2` fd 1 → fd 2); COPT `getInfo(Dual, PsdConstraint)` returns wrong values (fixed via least-squares y reconstruction from KKT); `loadWorkbench()` cwd-walk fails when corpus runner spawns from non-workbench cwd (fixed by passing `toolsRoot` explicitly); `achieved_precision` must be computed in wire frame, not engine frame (svec scaling amplifies residuals). | 2026-05-11 | scientist-workbench-{v4jd, jkz6} (closes); -{qmrv, 67nj, tj6p} (registered/extended as follow-ups) |

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
