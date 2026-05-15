# 123 — `NTTContext`: instance-scoped NTT plan caches (`nip`)

**Date:** 2026-05-15
**Bead:** `scientist-workbench-nip` (closes)
**Touches:** `packages/mod-core/src/ntt.ts` (refactor), `packages/mod-
core/src/index.ts` (re-exports), `packages/mod-core/test/mod-core.test.ts`
(new `NTTContext` test block).

## Context

`packages/mod-core/src/ntt.ts` carried three module-level mutable
`Map<number, …>` plan caches — power-of-two twiddles, Bluestein chirp
plans, and pow2-`n⁻¹` Montgomery scalars. The bead's three
named problems:

1. **Unbounded.** Fuzz tests with arbitrary `n` leak memory for the
   process lifetime.
2. **Process-global.** Currently safe because the modulus is frozen at
   `NTT_SUPPORTED_MODULUS = 998244353`, but a future generalisation to
   other NTT-friendly primes would collide on `n`-only keys across
   moduli.
3. **Hidden timing-coupling.** `ntt(x, opts)` was pure on its return
   value but its *timings* depended on which `n` values had been seen
   before — a footgun for anyone benchmarking the tool.

A small, sharp TS-expert refactor — exactly the third-pass piece I
named earlier in the session as the runner-up to `q0b`.

## What changed

**`NTTContext` class** owns the three Maps as private fields, plus a
public `clear()` and `size()` API. Construction is zero-arg
(`new NTTContext()` gives fresh caches); the modulus and primitive
root are exposed as readonly fields for future-generalisation use, but
the v0.1 caches are still keyed by the fixed `P_BIG` constants
module-internally.

**`defaultNTTContext()`** returns a lazy process-singleton. This is
the historical (pre-`nip`) behaviour — clearing it from one call site
clears it everywhere. The four-arity helpers (`powerOfTwoTwiddles`,
`bluesteinPlan`, `pow2InvNMont`, `nttPow2InPlace`) all take a `ctx:
NTTContext` parameter; the top-level `ntt(x, opts, ctx?)` accepts the
context optionally and routes to the default singleton when omitted.

**Backwards compatibility preserved.** The `ntt(x, opts)` two-arg
shape works exactly as before — same outputs byte-identical, same
goldens (36/36 still pass), same `tools/ntt/tool.ts` consumer
unchanged. The third optional parameter is the only public-surface
change.

**Test block — four properties pinned:**

1. Two contexts have independent caches (`size()` advances only on
   the context that ran the work; a follow-up run on the *other*
   context confirms the first stays untouched).
2. `clear()` empties the caches; a cold-cache re-run produces
   byte-identical output (plan builds are deterministic, so cache
   state is purely a memory/timing concern).
3. `ntt(x, opts)` ≡ `ntt(x, opts, defaultNTTContext())` — pins the
   default routing.
4. `defaultNTTContext()` returns the same instance every call — pins
   the singleton property so a future refactor that drops the
   default doesn't break callers silently.

## Why these choices

- **Class with package-private accessor methods, not directly-exposed
  Maps.** The plan structures hold `Uint32Array`s that the kernel
  reads as-is; a caller mutating a cached value via direct Map access
  would corrupt every subsequent `ntt(...)` invocation. The `_*`-
  prefixed methods are the only sanctioned route, and `clear()` is
  the only sanctioned mutator. (TS's `private` would have hidden the
  methods from package-internal call sites too; the `_*` prefix is
  the JS convention for "external code shouldn't touch this," with
  package-internal code free to use them.)

- **Optional `ctx` parameter, not a required one.** The bead's
  acceptance criterion is "module-level Maps removed or marked
  private to the default ctx; tests pass." A required `ctx` would
  break every call site including `tools/ntt/tool.ts` and the test
  file's 25-test suite. Optional + default-singleton routes preserves
  the public surface — `nip` lands as a pure addition that retires
  the global Maps without churn elsewhere.

- **`size()` exposed publicly.** Two reasons: the tests need it to
  assert cache scoping (without it, the only way to verify "context A
  cached, context B didn't" is to time the runs — fragile), and fuzz
  loops want it to cap context size without resorting to wall-clock
  estimation. Cheap to expose, useful in non-test contexts.

- **No modulus parameter on the constructor yet.** The bead foresees
  a future where `NTTContext(modulus, primitiveRoot)` lets one
  process work in multiple NTT-friendly primes. The shape of this
  refactor admits that constructor without breaking any v0.1 caller
  — the readonly `modulus` / `primitiveRoot` fields are already
  there. Doing the full generalisation requires also threading
  Montgomery constants through the kernel (`P_INV`, `R_MOD_P`,
  `R2_MOD_P` are currently module-level `const`s tied to `P = 998244353`),
  which is deeper than `nip` asks for. v0.1 lands the *shape* of the
  generalisation; the *behaviour* of the generalisation is a separate
  bead.

- **The historic "module-level singleton" behaviour is preserved as
  `defaultNTTContext()`, lazy.** No global `new NTTContext()` at
  import time — only constructed on first use. Saves the 256-byte
  three-Map allocation for processes that import `@workbench/mod-core`
  but never call `ntt(...)`. (Marginal — but the same idiom shows up
  often enough that "module-level state lazily constructed" is the
  right default.)

## Frictions surfaced

- **None of substance.** This is the smallest worklog shard of the
  three I've shipped this session. The bead was well-specified, the
  helper functions all had the same shape (`(n, invert) → cached-or-
  built`), and threading `ctx` through them was mechanical. The only
  micro-decision was whether to expose `size()` — settled in favour
  of yes for testability + fuzz-loop bookkeeping.

- **Worth noting: existing tests' "determinism" test (line 247) is
  *not* testing what its description claims.** "no caches leak state"
  reads as if it's checking the caches are clean; what it actually
  checks is that `ntt(x)` twice returns the same array. That's the
  *correctness* statement (caches that did leak state would still
  return the same array because the plan structures are immutable).
  The new test block's property 2 (`clear()` doesn't change output)
  is the actual "caches don't corrupt output" assertion. Left the
  existing test as-is — its assertion is real, just mis-named.

## Acceptance

- `packages/mod-core` tests: **29 pass** (was 25; +4 in the new
  `ntt: NTTContext (bead nip)` describe block).
- `tools/ntt` goldens: **36/36 still pass** — byte-identical output.
- `bun tools/ntt/tool.ts --test`: green.
- Full `bun run check`: **97 passed, 7 skipped, 0 failed**.
- Public surface: `NTTContext` and `defaultNTTContext` re-exported
  from `@workbench/mod-core`.
- Module-level Maps removed: `POW2_TWIDDLE_CACHE` /
  `BLUESTEIN_CACHE` / `POW2_INV_N_MONT_CACHE` no longer exist.

## Pointers

- `packages/mod-core/src/ntt.ts` — the refactored core. The doc-
  comment block above `NTTContext` is the literate-programming
  surface: read it top-to-bottom for the rationale.
- `packages/mod-core/test/mod-core.test.ts` — new `NTTContext` test
  block at end of file pins the four properties.
- worklog 001 — original NTT port from `tstournament`, which
  introduced the module-level caches this shard retires.
