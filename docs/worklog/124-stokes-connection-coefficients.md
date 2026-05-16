# 124 — Stokes connection coefficients: 43i + egf via ADR-0039

**Date:** 2026-05-16
**Beads:** `scientist-workbench-43i` (closes — Fox-H algebraic prefactor / divergent-truncation for `n < p`), `scientist-workbench-egf` (closes — Stokes-line connection coefficients via `E_{p,q}(z)` and the multiplier table).
**Touches:** `docs/adr/0039-stokes-connection-coefficients.md` (new), `docs/refs/dlmf-16-11.md` (new — 827-line local canonical reference for DLMF §16.11), `packages/meijer-core/src/{asymptotic,dispatcher,index}.ts`, `packages/meijer-core/src/{exponential,stokes}.ts` (new), `packages/meijer-core/test/{asymptotic,asymptotic-mutations,dispatcher}.test.ts`, `packages/meijer-core/test/{exponential,stokes}.test.ts` (new), `tools/meijer-g-asymptotic-only/{tool,tool.test,goldens.spec}.ts`, 7 new goldens (09-15) for `43i`, 8 new goldens (16-23) for `egf`, 5 deleted κ=2 refusal goldens (re-pivoted to κ=1 + coverage-gap).
**Follow-ups filed:** `scientist-workbench-fc83` (κ=2 three-term connection), `scientist-workbench-ulze` (multiplier-table validation at moderate `|z|`), `scientist-workbench-ybrw` (`bigErfc` for Berry smoothing), `scientist-workbench-uaxz` (prefactor refactor in `series.ts`), `scientist-workbench-4kfz` (pre-existing contour-test timeout).

## Context

ADR-0026 §7 enumerated five deferred sub-tasks for the Braaksma asymptotic layer (`hv0.9.1`-`hv0.9.5`). The two highest-leverage were `hv0.9.1` (full `H^{m,n}_{p,q}` algebraic series for the `n < p` regime — filed as bead `43i`) and `hv0.9.2` (Stokes-line connection coefficients — filed as bead `egf`). The bead bodies described the work in slightly different vocabulary than ADR-0026 used, and clarifying that mismatch was the first work product of this session.

This shard documents an end-to-end orchestrated multi-subagent session: ten subagent invocations across audit / research / design / implementation / diagnosis / fix phases, serial execution only, single coordinator. The session ran ~6 hours of wall clock (mostly subagent work, not coordinator decisions). The deliverable is two beads' worth of arbprec-deterministic code, two foundational documents (ADR-0039 + dlmf-16-11.md), and five follow-up beads sized to be themselves discrete subagent-sessions.

## What changed

**ADR-0039 — "Stokes connection coefficients and the algebraic-asymptotic split"** is the decisional artefact. It:

1. **Settles the scope split between `43i` and `egf`.** Bead bodies originally read as overlapping (both citing `H_{p,q}` / `E_{p,q}` in DLMF 16.11). Audit subagent 2 surfaced the resolution from the bead JSONL: `43i` is the algebraic-series prefactor and divergent-truncation fix for `n < p` (purely algebraic, no exponentials); `egf` is the exponential series + Stokes multipliers for crossing `arg z = ±π/2` (κ=1) and the multi-line geometry for κ≥3. They are sequenced — `egf` depends on `43i` because the multiplier table is keyed on a correctly-truncated algebraic foundation.

2. **Specifies a coverage matrix.** `43i` covers `n < p` AND `κ ≥ 1`. `egf` covers `κ = 1` and `κ ≥ 3`. `κ = 2` (the three-term `H + E^- + E^+` formula of DLMF 16.11.8) is *out of v0.1 scope* — refused as `coverage-gap`, filed as `fc83`. The `κ ≤ 0 AND n < p` regime is refused at the dispatcher pre-filter (exponentials mandatory).

3. **Pins the wire-schema extensions** as additive: new `method` value `"braaksma-stokes"`, new `sector` value `"stokes"`, two new refusal tags (`stokes-band-refused`, `coverage-gap`). The pre-existing `stokes-line` refusal tag remains for defence-in-depth.

4. **Specifies the determinism contract.** Bigfloat `carg` replaces `Math.atan2` of float64-cast components; sign-of-Im(z) decisions for the connection-formula branch must run at BigFloat precision because the cost of misclassification is exponentially unbounded in `|z|`. Berry smoothing is *Option C* (sharp switch + refusal in sub-precision band, `c_W = 5`, band half-width `|z|^{-1/(2κ)}`) for v0.1 — the smooth version via `bigErfc` is `ybrw`.

**`docs/refs/dlmf-16-11.md`** is the local canonical reference written before any code. 827 lines of LaTeX-rendered DLMF equation numbers, Paris-Kaminski Theorem citations, the worked Bessel-K example, the principal-sector geometry per κ, and the determinism-implementation rationale. Written because Paris-Kaminski 2001 isn't on disk under `docs/refs/` and Law 1 says: if the canonical source isn't local, write it before the code.

**`43i` implementation** is a single function split in `asymptotic.ts`: `findOptimalTruncation` now dispatches between `findTruncationScan` (Olver §3.7 scan-for-smallest-term, all `n = p` cases) and `findTruncationParisKaminski` (analytical `N* = ⌊|κ z^{1/κ}|⌋` from P&K Theorem 2.2, `n < p AND κ ≥ 1` only). The PK branch keeps a defence-in-depth scan that emits a `truncation-disagreement` warning if scan-empirical and PK-analytical indices diverge by more than 2×. Plus one new dispatcher refusal in `canUseAsymptotic` for `κ ≤ 0 AND n < p`. Seven triple-witness goldens (mpmath @ 35dps, wolframscript @ 30dps).

**`egf` implementation** is two new pure-math modules (`exponential.ts`, `stokes.ts`) plus connection-formula wiring in `asymptotic.ts`. `evaluateEpq` implements DLMF 16.11.3 with the 16.11.4-5 coefficient recurrence at BigFloat precision; branch rotation via principal-value `cpow` on `z^{1/κ}`. `stokesMultiplier` is a pure table-lookup function returning multipliers from `{0, ±1, ±i}` per Paris-Kaminski §2.3 Table 2.1. `classifySector` becomes κ-aware (principal sector widens to `κπ/2`) and returns a structured `SectorVerdict` with `sectorIndex` and `signOfImZ` derived from BigFloat `carg`. The connection-formula loop assembles `G(z) = H(z) + Σ_k S_k · E_k(z·e^{2πik/κ})` for k ∈ {−1, 0, +1}.

## Why these choices

**Audit-first, code-last.** Three Sonnet read-only audits (asymptotic.ts Stokes path; pfq.ts + series.ts regime gap; tool wire schema + goldens) preceded any Opus coding. The audits surfaced the bead-vs-ADR vocabulary mismatch, the absence of any `E_{p,q}` code in the substrate, and the fact that `residuePrefactor` (asymptotic.ts:457-494) *already* computed the correct full `B_h` — making `43i`'s scope narrower than the bead title suggested (only the truncation logic was wrong, not the prefactor).

**Combined research + reference into one subagent.** Tasks 4, 5, 6 in the plan (write `dlmf-16-11.md`; research Stokes-multiplier table; research Fox-H `n < p` spec) overlapped heavily; one well-briefed Opus research subagent produced all three deliverables in one pass, with wolframscript + mpmath triple-witness cross-checks embedded inline. Senior-engineer optimisation.

**ADR drafted by coordinator, not subagent.** ADR-0039 is the load-bearing design decision; delegating it dilutes the call. Drafted directly using the audit + research outputs.

**Subagent caught an ADR error.** During `43i` implementation the Opus coder narrowed the PK trigger from the ADR's "n < p OR κ ≤ 1" to "n < p AND κ ≥ 1". Reasoning documented in the implementation comment: the `n = p AND κ = 1` boundary case has a *convergent* inner pFq at moderate `|z|` (the existing anchor 5 at `z = 10+5i`, 25 dps target, needs ~25 terms; PK's `N* ≈ 11` would have failed it). The ADR was amended after-the-fact. This is the right pattern — the implementing engineer with empirical contact with the test suite catches design errors the designer cannot.

**Triple-witness validation caught a one-line bug.** During `egf` Part 2 the connection-formula assembly produced values disagreeing with wolframscript by ~10⁻³ at golden 19's input. The Part-2 subagent marked the offending goldens as *regression fixtures, not oracle-validated truths* per CLAUDE.md rule 8 (honest scope), recommended further investigation, and stopped. A dedicated Opus math-research subagent localised the bug to a single line: the κ=1 `zArgForH = cneg(z)` rotation was a literal transplant of DLMF 16.11.7's `H(z·e^{∓πi})` convention that applies to DLMF's `H_{q,q}` (the formal divergent asymptotic for `{}_qF_q`), but the workbench's `assembleAlgebraic` computes the *right-closing Slater residue series for G itself* (ref doc §2.2) which equals `G(z)` directly on the principal Riemann sheet — no rotation needed. Proof: `H_workbench(−z) = e^{i·2π/3} · G(z)` at the test point, matching the kernel's wrong output `(1.11e-3, +1.66e-3 i)` to bit precision. Fix: delete the rotation, leaving `zArgForH = z` for all κ.

## Frictions surfaced

**Bead vs ADR wording divergence.** The bead `43i` title ("Full H_{p,q} algebraic series for n < p regime") and ADR-0026 §7 entry ("Full Braaksma theorem with E_{p,q} exponential terms — needed for p ≤ q − 2 regimes") read as describing different mathematics. Audit subagent 2 resolved it: they are two distinct sub-tasks in different vocabularies. `43i` is the algebraic `H^{m,n}` prefactor + truncation correction; `egf` is the exponential `E_{p,q}` + multipliers. ADR-0039 documents the resolution.

**ADR-0039 §D1 needed amendment after implementation.** The original PK regime trigger (`n < p OR κ ≤ 1`) would have broken existing test anchor 5. Implementing engineer caught it, narrowed correctly to `n < p AND κ ≥ 1`, documented inline. The ADR was amended with the rationale paragraph + a status note ("Amended 2026-05-16"). This pattern — empirical contact with the test suite revealing a design error — is *good engineering*, not a process failure. The audit + design phases couldn't have caught it because the empirical evidence (anchor 5's specific precision-vs-z requirement) was only visible at code time.

**The multiplier table residual concern.** The math-research subagent's diagnosis localised the one-line bug to the H-rotation, but flagged a *separate* concern: at `|z|=10000` (goldens 19, 20) E is `O(10⁻⁴³⁵)` so the multipliers are numerically irrelevant; the `±i` entries in `stokes.ts` were never end-to-end-validated. At moderate `|z|` (5-20) E becomes `O(1)` and the multipliers become load-bearing. The stress-test goldens (21, 22, 23) at small `|z|` hit the Option-C band guard (band half-width capped at `θ_S/2 = π/4`, larger than the 0.05-0.1 rad angular offset) before reaching the connection formula. **Multiplier-table validity at moderate `|z|` is unverified through the current tool surface.** Filed as `ulze`. The honest mitigation is bead `ybrw` (implement `bigErfc`, narrow the band guard, then re-validate).

**Pre-existing contour-test flakiness.** `bun run check:quick` on the final state reports `1 fail / 2085 pass` — a 60s timeout in `packages/meijer-core/test/contour.test.ts` for `G^{1,0}_{0,1}(_; 0 | 0.5)`. Investigation: runs standalone (filter pattern matched) in 48.74s, passing 1/0. Test file dates to commit `7ee8397` (Mellin-Barnes layer, predating asymptotic work). Worklog 076 set precedent for bumping a sibling contour test's timeout on 2026-05-08. Conclusion: pre-existing flakiness under bun-test's parallel workload, *not* a regression from this session. Filed as `4kfz` with three remediation options.

**File overlap blocked clean per-bead commit split.** The user's intent was to commit `43i` and `egf` as separate logical commits. `asymptotic.ts`, `dispatcher.ts`, `asymptotic.test.ts`, and `goldens.spec.ts` each contain intermixed hunks from both beads. With `git add -p` harness-blocked, the only clean split is at file level — which doesn't work here because the implementation logic is intermixed inside individual files. Shipped as one implementation commit naming both beads, with a pure-docs prelude commit for ADR-0039 + `dlmf-16-11.md`.

## Acceptance

- `43i`: 7 new goldens, mpmath @ 35dps + wolframscript @ 30dps triple-witness, all passing. `findOptimalTruncation` now regime-aware with defence-in-depth scan. Dispatcher refuses `κ ≤ 0 AND n < p` with new reason citing `egf v0.1`.
- `egf`: 1792 LOC of new pure-math substrate (`exponential.ts` + `stokes.ts` + their tests); connection-formula wiring in `asymptotic.ts`; `coverage-gap` + `stokes-band-refused` refusal classes; wire-schema extensions in `tools/meijer-g-asymptotic-only/tool.ts`. Goldens 19, 20 match wolframscript to 17 dps (capped by 200-term asymptotic limit at `|z|=10000`, not by fix correctness — pre-fix error was 50 orders of magnitude).
- `bun run check:quick`: convention OK, codegen OK, typecheck OK, bun test 2085 pass / 1 fail (the pre-existing `4kfz` contour timeout, verified unrelated).
- ADR-0039 amended with implementation reality (PK regime narrowing) and follow-up beads referenced by ID.
- Five follow-up beads filed: `fc83`, `ulze`, `ybrw`, `uaxz`, `4kfz`.

## Pointers

- ADR — `docs/adr/0039-stokes-connection-coefficients.md`
- Math reference — `docs/refs/dlmf-16-11.md`
- 43i implementation — `packages/meijer-core/src/asymptotic.ts` (`findTruncationParisKaminski` + `findTruncationScan`), `packages/meijer-core/src/dispatcher.ts` (new `κ ≤ 0 AND n < p` refusal)
- egf modules — `packages/meijer-core/src/exponential.ts`, `packages/meijer-core/src/stokes.ts`
- egf wiring — `packages/meijer-core/src/asymptotic.ts` (κ-aware `classifySector`, Stokes connection-formula path), `tools/meijer-g-asymptotic-only/tool.ts` (wire schema)
- Bench — `tools/meijer-g-asymptotic-only/goldens/` 09-23 (43i + egf goldens, wolframscript-validated)
- Open follow-ups — `bd show fc83 ulze ybrw uaxz 4kfz`
