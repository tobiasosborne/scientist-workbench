# HANDOFF — Gamma v0.2 hardening: remaining beads

**Written:** 2026-05-20, at the wind-up of the v0.2 hardening session
(worklog 178). **Predecessor context:** worklogs 175 (epic close), 176
(idq1), 177 (o60c), 178 (v0.2 rollup).

The Gamma epic (`xqc7`) is closed. The v0.2 hardening session closed 9
of the 13 deferred P3 followups. **6 gamma-anchor beads remain open.**
This document hands them to the next agent.

## Orchestration model that worked

Fully serial: one Opus subagent at a time. The orchestrator (you)
validates each delivery **on disk** — re-run tests, spot-check values
against an independent oracle (mpmath / Wolfram), run the oracle
replay — *before* writing the `bd close` note and dispatching the
next. Never close on a subagent's self-report.

**Two lessons from this session, brief every subagent with both:**

1. **Probe the bead's premise first.** Three v0.2 beads (`d2ha`,
   `o60c`, and partly `idq1`) had premises that were materially wrong
   — a bit-shortfall that didn't exist, the wrong module named. The
   subagent that measures before building catches this.
2. **Retain-and-gate** (user-confirmed best practice, `bd memories
   retain-and-gate`): when a v0.2 alternative does not beat the v0.1
   substrate, keep it — fully implemented, mutation-tested,
   cross-validated, exported — but gated OFF the hot path behind a
   one-line documented re-enable point. Never delete it; never ship a
   non-winning path as default.

**One process miss to avoid:** do not background-launch the next
subagent onto a file the just-closed one touched — it creates a
commit-boundary hazard. Serial means serial.

## The 6 remaining beads

### `yev0` — Holoborodko digamma refits at 53-bit  (IN-FLIGHT, partial)

**State:** a subagent was dispatched and **stopped mid-probe** at
wind-up. It added a digamma-ULP **probe describe block** to
`packages/quadrature/test/special-funcs/gamma-float64.test.ts` (tests
pass, the file is green at 102/0) but reached **no decision** and the
probe block's assertions are **not orchestrator-validated**. It did
**not** touch the `digammaFloat64` implementation.

**Next agent:** re-dispatch fresh. Treat the committed probe block as
unvalidated starting material — verify its ULP measurements against
the arb-prec `digamma` oracle, then complete the bead's decision:
probe-first — measure the current `digammaFloat64` max/RMS ULP on
`[1,2]`; if it is already ≤0.5–1 ULP, **close as "already at the
bar"** (do not refit gratuitously); if ≥2 ULP, do the Remez refit
(generate the minimax coefficients with a committed reproducible
script — Route A in the original brief — do not hand-type
coefficients). Original brief is in this session's dispatch; the bead
body has the spec.

### `z3aq` — Cody-Stoltz NETLIB SPECFUN oracle adapter

New oracle adapter under `bench/gamma-anchor/oracles/specfun/`.
NETLIB SPECFUN (Cody/Stoltz ~1992, public-domain Fortran) as an
independent third voice for 1-ULP Cephes-vs-Boost-vs-FreeBSD
disagreements. ~200 LOC. Mirror the structure of an existing adapter
(`oracles/boost/` is the closest — it has `oracle.cpp` + `adapter.ts`
+ `README.md` + a build step). The G8 cross-agreement comparator
(`bench/gamma-anchor/cross-agreement.ts`) consumes adapter output;
check its expected schema. Pure tooling — no substrate risk.

### `9sqd` — Pari/GP oracle adapter

New oracle adapter, independent of the MPFR/mpmath/Arb lineage (Pari
uses its own `t_REAL` arithmetic). `sudo apt install pari-gp`
(2.15.4). ~150 LOC. **Landmine to tag in the adapter** (`L_pari_incgamc`):
Pari's `incgam`/`incgamc` convention — `incgamc` is the LOWER
incomplete gamma, not to be confused with SciPy `gammaincc` (upper
regularised). Same adapter-structure mirror as `z3aq`.

### `3qwy` — Boost igami full seed algorithm coverage  (RESEARCH)

A research bead. Read Boost `igamma_inverse.hpp` in full: the
multi-branch inverse-incomplete-gamma seed (Eq 21-25 small-`a` by
`b = q·Γ(a)` magnitude sub-regime; Eq 31 large-`a` Wilson-Hilferty
cubic-root). The workbench v0.1 uses a Cephes Newton+bisection
fallback. **Decide** whether v0.2 should port Boost's Halley path —
and *benchmark first* (this session found three v0.2 algorithm
"upgrades" that lost to v0.1; expect the same scrutiny). The bead's
deliverable is a documented decision + benchmark, possibly a new impl
bead. If the Cephes fallback is already accurate, retain-and-gate or
close as "v0.1 sufficient".

### `tool` — General Gauss formula ψ(p/q)  (DESIGN)

A design bead, labelled `needs-design`. v0.1 ships 7 clean closed
forms for `ψ(p/q)` at `q ∈ {2,3,4,6}`. General `q` needs the full
Gauss formula sum (DLMF §5.4.13-16) — symbolically expressible but
verbose. **The design question is open:** (a) full expansion to a
sum, or (b) introduce a `RationalDigamma` head that evaluates
symbolically. Decide the cognitive model before any code. This is the
one bead that genuinely needs a design decision up front — consider
2-3 research subagents if the choice is contested (the 3+1 pattern).

### `mmrn` — Γ(−n,z) at negative-integer `a` via E_n

Filed this session as the `7gq4` followup. `7gq4` shipped negative
non-integer `a` for `bigIncompleteGammaUpper`; the measure-zero
non-positive-integer set `{0,−1,−2,…}` is refused with a loud
`RangeError` pointing at the exponential-integral family. Closing the
sliver needs an **arb-prec `E_n` evaluator** in `packages/bigfloat`
(`Γ(0,z)=E_1(z)`, `Γ(−n,z) ∝ E_{n+1}(z)`; DLMF §8.4.15 / §8.19).
~120-180 LOC. Note `ExpIntegralE` is already a cas-core vocab head
with a Meijer-G bridge form — the arb-prec substrate is the missing
piece. P3.

## Suggested order

1. `yev0` first — it is in-flight and has committed partial work that
   should be either completed or cleanly resolved.
2. `z3aq` + `9sqd` — independent pure-tooling oracle adapters, low
   risk, can go in either order.
3. `mmrn` — a clean ~150-LOC substrate addition.
4. `3qwy` + `tool` — research/design beads; do last, and give them
   the probe-first / 3+1-research discipline they need.

## Non-gamma loose end

`m9ty` (filed this session by the `eoei` subagent, not gamma-labelled)
— a pre-existing `bessely.test.ts` asymptotic-band timeout flake that
surfaces under load. Unrelated to the gamma family; tracked
separately.
