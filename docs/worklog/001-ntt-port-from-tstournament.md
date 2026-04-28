# 001 — NTT port from tstournament 02-NTT

**Date:** 2026-04-28
**Status:** complete
**Branches:** main
**Issues:** none directly; this iteration surfaced the nine frictions
captured under epic `scientist-workbench-rpb` and addressed in shards
002–007.

## Context

The `scientist-workbench` repo had landed at v0.2 MVP: a value protocol
(ten kinds), a `runTool` dispatcher, and six tools (`expr-parse`,
`cas-simplify`, `cas-verify`, `oracle`, `registry-list`,
`registry-search`) all fed by `cas-core`. The substrate was healthy
in isolation but had not yet absorbed an outside algorithm.

In a sibling repo `tstournament` lived ten algorithm ports, each a
self-contained tournament-shaped JSON-on-stdin/stdout TS solution. The
candidate for first port was 02-NTT — Number-Theoretic Transform over
F_p with `p = 998244353`, arbitrary length n via Bluestein chirp-z, with
Montgomery REDC inner loop. 417 lines of solution.ts plus 64 golden
master cases verifying both directions across pow-2 and non-pow-2 sizes.

## What changed

A new package and three new tools landed:

- **`packages/mod-core`** — modular arithmetic substrate. Generic
  `modPow` (square-and-multiply over `bigint`), `modInv` (extended
  Euclid; works for any modulus, returns `{invertible, inverse, gcd}`),
  and the NTT machinery (Montgomery context frozen for `p = 998244353`,
  power-of-two Cooley-Tukey, Bluestein chirp-z plan cache, top-level
  dispatch). 25 unit tests covering identities, Fermat, schoolbook
  agreement, round-trip, linearity, determinism.
- **`tools/mod-pow`** — modular exponentiation tool. 12 examples,
  32 goldens, `--test` hook with iterated-multiplication oracle for
  small exponents.
- **`tools/mod-inv`** — modular inverse tool. (Migrated to record-
  with-flag in shard 006.) 12 examples, 32 goldens.
- **`tools/ntt`** — the headline. Input `record { n, modulus,
  primitive_root, direction, x }` → `list<integer>`. v0.1 supports the
  one prime; rejects others as out-of-scope. 11 examples, 36 goldens,
  `--test` hook with independent O(n²) schoolbook DFT oracle.

Plus `scripts/validate-tournament-ntt.ts`, the cross-validator that
translates between tournament-shaped JSON and sci-wb canonical and pipes
through the new tool. **64 of 64 cases pass residue-for-residue.**

## Why these choices

**Three tools, not one.** The Unix-philosophy decomposition asked: are
`modPow` and `modInv` independently useful? Yes — RSA, primality
testing, ad-hoc number-theoretic queries. Splitting them off the NTT
gives them their own contract (schema, examples, invariants, goldens)
and keeps `ntt` focused on the transform itself.

**A new package, not extending `cas-core`.** `cas-core` is exact rational
arithmetic over `Q[x]`/`Q(x)`. Modular work is a different layer; mixing
them would muddle both. Future Buchberger / Gröbner work will sit on
`cas-core`; future graph algorithms (Stoer-Wagner, blossom) will get
their own `graph-core`.

**Single supported prime in v0.1.** The tournament tested only
`p = 998244353`; the Montgomery constants are pre-computed for that
prime and the inner kernel is Number-arithmetic with 16-bit limb splits
(no BigInt on the hot path). Generalising to arbitrary NTT-friendly
primes is genuinely more code (compute Montgomery constants per
modulus, cache by modulus) and isn't yet motivated. We took the v0.1
honesty hit instead.

**Tournament IO ≠ canonical IO.** The tournament passes `n` as a JSON
number, `modulus` as a JSON string, `x` as a string array. Sci-wb's
canonical encoding is "no raw JSON numbers; integers are decimal-string
inside `IntegerValue`." So the tool *cannot* accept the tournament's
shape directly without translation. The cross-validator script becomes
the translation layer — and the friction of writing one by hand
motivated shard 005's `json-bridge` package later in the day.

## Frictions surfaced

This is the iteration that produced the friction log. Nine items, in
priority order, each filed as a child of epic `scientist-workbench-rpb`:

- **F1+F2** spawn machinery silently fails on snap-Bun installs;
  several call sites swallow describeTool failures with bare
  `catch { continue; }`. Shard 002.
- **F3** scaffolder doesn't accept cross-package dependencies; every
  new tool with substantive content needed hand-edited package.json
  + manual `bun install`. Shard 003.
- **F4** the "≥10 examples" target clashes with structure-driven
  minimums; for `ntt` the natural set was 11 by code-path branches,
  not by quota. Shard 007.
- **F5** no standard pattern for error-flavoured tool outputs;
  `mod-inv` used `tagged` while `cas-verify` used record-with-flag.
  Shard 006.
- **F6** raw `{kind:"..."}` literals mixed with `record({...})` /
  `int(...)` helpers; no convention. Shard 007.
- **F7** tournament-shaped raw JSON doesn't survive a port without an
  adapter; every benchmark will need one. Shard 005.
- **F8** schema specification by sample-value loses element-kind
  information — `list([])` says nothing about what's inside. Shard 004.
- **F9** TDD discipline — port-and-verify isn't the same flow as
  spec-from-scratch; the codebase needed to acknowledge both. Shard 007.

## Acceptance

- 25 mod-core unit tests pass; mutation-proven (flipping `=== 1n` to
  `=== 0n` in `modPow`'s bit-mask check fails 8 tests).
- All three tool `--test` hooks pass.
- 32 + 32 + 36 goldens generated and re-checked via `oracle`.
- Cross-validation: 64 of 64 tournament cases match residue-for-residue.
- `bun run check` (then 13 phases): all green, 0 failed.

## Pointers

- The port itself: `packages/mod-core/`, `tools/mod-pow/`,
  `tools/mod-inv/`, `tools/ntt/`.
- Cross-validator: `scripts/validate-tournament-ntt.ts`.
- Tournament source: `../tstournament/test-2/02-ntt/{PROMPT.md,
  golden/{inputs,expected}.json,solution.ts}`.
- Friction log → epic `scientist-workbench-rpb` (now closed, all 9
  child issues complete).
