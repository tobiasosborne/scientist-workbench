# 125 — ulze: the egf Stokes-band retraction (and atip δ=0 surprise)

**Date:** 2026-05-16
**Beads:** `scientist-workbench-ulze` (closes — egf multiplier-table validation became the egf Stokes-assembly *deletion*).
**Touches:** `docs/adr/0039-stokes-connection-coefficients.md` (Amendments 1+2, §D6, §D7, follow-up-bead reorganisation), `packages/meijer-core/src/asymptotic.ts` (Stokes assembly deleted, `classifyAroundLine` simplified), `packages/meijer-core/src/{exponential,stokes}.ts` (deleted — entire modules), `packages/meijer-core/src/index.ts` (exports trimmed), `packages/meijer-core/test/{exponential,stokes}.test.ts` (deleted), `packages/meijer-core/test/asymptotic.test.ts` (egf-era tests rewritten), `tools/meijer-g-asymptotic-only/{tool,goldens.spec}.ts` (`stokes-band-refused` removed; golden descriptions rewritten), `tools/meijer-g-asymptotic-only/goldens/` (8 deleted, 7 regenerated against mpmath truth).
**Follow-up filed:** `scientist-workbench-atip` (P1 bug — δπ algebraic-sector envelope; golden 17 silently broken).
**Net diff:** ~2000 LOC deleted, ~250 LOC added. Roughly the entire `egf` Part 1 (Stokes module + E-evaluator + their tests) gone.

## Context

`ulze` was filed at the end of the previous session (worklog 124) as the honest residue of `egf` v0.1: the `±i` Stokes multipliers in `stokes.ts` had been validated by structural reasoning + a fixed H-rotation bug, but never end-to-end tested at moderate `|z|` where the E contribution was numerically meaningful. The Option-C band guard refuses inputs near the Stokes line at moderate `|z|`, so the multipliers were "conjecturally correct by construction" and could not be probed through the tool surface.

The user picked `ulze` as the next bead, requesting continued multi-subagent orchestration.

## What changed

The session pivoted hard once the empirical probes ran.

**Phase 0 — orchestrator-direct empirical probe (~5 minutes).** Rather than spawning a subagent for what was a single experiment, I probed the kernel directly: take a moderate-|z| input that *escapes* the band guard (`|z|=10`, `arg z = π/2 + 1`, past the band cap at θ_S/2 = π/4), run it, compare to wolframscript. The kernel gave **2-6 dps agreement** vs 30 dps requested. The disagreement magnitude (~10⁻⁴) matched the leading-term magnitude of `E(z)` at that point — strong hint that the E contribution was being misapplied.

**Phase 0.5 — the load-bearing decomposition.** Asking mpmath to compute the closed-form `Γ(7/6) · z^(1/2) · (1+z)^{-7/6}` (which is `G^{1,1}_{1,1}([1/3]; ; [1/2]; ; z)` per the standard Slater reduction) showed `|G − H_workbench| < 10⁻³¹` at the same test point. **`H_workbench` already IS `G`.** No E contribution is needed; the kernel was adding one anyway, hence the disagreement.

Five further probes spanning different ν (-1/2, -1/6, 0), different |z| (3, 5, 10), and arg z values including upper/lower half-planes and near the negative real axis: `|G − H_workbench|` was at mpmath working precision (10⁻³¹ at dps=30) for every single one.

**Phase 1 — math-research subagent (Opus, ~40 min).** Charged with verifying the H_workbench = G claim across shapes beyond just p=q=1, and characterising the κ≥3 regime. The subagent extended the empirical work to multiple p=q=2 shapes (including n<p) and to κ=3 (where the situation is subtler — H_workbench equals G *asymptotically* with subdominant E remainder, not exactly). It also produced a precise per-(κ, n, p, q, δ) decision table for the fix.

**The math-research finding had three layers:**

1. **`H_workbench(z) = G(z)` exactly for κ=1, δ≥1.** This is not an asymptotic equality — it's an analytic identity on the principal Riemann sheet. For p=q=1, the workbench's H reduces to the closed form `Γ(1+b-a) z^b (1+z)^{a-b-1}`, which equals G everywhere on the principal sheet by Slater's theorem. For higher p=q with δ≥1, the inner pFq's analytic continuation makes the per-pole residue sum equal G in the same way.

2. **`H_workbench(z) ≈ G(z)` asymptotically for κ=3, δ≥1.** No principal-sheet Stokes-line crossings exist (E-Stokes lines sit at ±κπ/2 = ±3π/2 outside |arg z| ≤ π). The subdominant E correction decays as `e^{−κ|z|^{1/κ}}` and is below user precision at any reasonable |z|.

3. **`H_workbench ≠ G` for δ=0.** *Surprise finding.* For shapes like G^{1,1}_{1,3} (m=n=1, p=1, q=3, δ=0), the algebraic series simply doesn't converge to G — E is the dominant contribution. **Golden 17, shipped in egf v0.1 as a "κ=3 deep principal sector regression test", is wrong by ~125× AND wrong sign** (kernel +0.0044 vs truth -0.5549). This was independently confirmed by orchestrator probe before committing to the deletion.

**The vocabulary collision.** The reason the original `egf` design was wrong is structurally similar to (but worse than) the κ=1 H-rotation bug fixed in worklog 124. DLMF 16.11 and Paris-Kaminski §2.3 give a connection formula `G(z) ~ H(z·e^{∓πi}) + E(z) + Σ S_k E(z·e^{2πik/κ})` where the H on the RHS is the **DLMF-16.11.2 formal asymptotic series for `{}_qF_q(z)`** — call it $H_{\text{DLMF}}$. The workbench's `assembleAlgebraic` computes a different object — the **right-closing Slater residue series for G itself** — call it $H_{\text{workbench}}$. They share a confusingly-similar name and structure but are not the same thing. Worklog 124's fix corrected the H-argument rotation (`zArgForH = z` not `cneg(z)`); ulze's fix corrects the deeper mismatch: when you assemble `H_{\text{workbench}} + Σ S_k E_k`, you're double-counting. The E terms are the DLMF formula's way of repairing $H_{\text{DLMF}}$'s formal-divergent gap with G; $H_{\text{workbench}}$ has no such gap — it IS G — so adding E terms creates one rather than fixing one.

**Phase 2 — coding subagent (Opus, ~25 min).** Applied the deletion per the math-research spec. Three modules and their tests gone (`exponential.ts` 572 LOC, `stokes.ts` 428 LOC, `exponential.test.ts` 456 LOC, `stokes.test.ts` 336 LOC). The Stokes-band assembly block in `meijergAsymptotic` (~150 LOC) collapses to a single `if (verdict.kind === "stokes") return assembleAlgebraic(...)`. `classifyAroundLine` shrinks from a 100+ LOC band/cap/sub-precision/sharp-switch machine to a 20 LOC sign-comparison. The `stokes-band-refused` refusal class is deleted from `SectorVerdict`, from `MeijerGAsymptoticRefusal.status`, and from the wire-schema output union. Goldens 17, 19-23 regenerated against mpmath; golden 17 entirely deleted (pending `atip`).

**Verification at the math-research test point.** `G^{1,1}_{1,1}([1/3]; ; [1/2]; ; z)` at `z = 10·e^{i(π/2+1)}`, precision=30: post-fix kernel matches mpmath truth to **33-34 dps** (above the 30-dps request — the BigFloat working precision has slack over the user-stated target). Pre-fix was 5-6 dps. Wire labels preserved: `method="braaksma-stokes"`, `sector="stokes"`. The numerical formula is now identical to the principal branch, but the labels still record "where in arg-z the classifier put this input".

## Why these choices

**Probe before subagent for single experiments.** The Phase-0 manual probe took 5 minutes and immediately revealed the bug's existence. Spawning a subagent for that would have cost ~30 minutes minimum and produced the same finding. Senior-engineer instinct: when "the thing IS the experiment", don't delegate.

**Delete rather than fix the multipliers.** The math-research report explicitly warned against "proposing a 'correct' multiplier table that produces small/zero S_k values" — fitting noise. The formula `G = H_{\text{workbench}} + Σ S·E` is structurally not the right form; the right form for v0.1 scope is just `G = H_{\text{workbench}}`. Deleting the assembly is cleaner than fitting nonsense small multipliers to it.

**Surface the δ=0 finding as a separate bead (`atip`), don't bundle it into ulze.** The δπ envelope correction is a different mathematical problem from the multiplier-table retraction: the former is "the algebraic-sector envelope is δπ not κπ/2", the latter is "the multiplier table for the algebraic-vs-DLMF-H is empty". They're separable in code (the envelope fix is in `classifySector`'s principal-sector bound; the multiplier retraction is in `meijergAsymptotic`'s connection-formula branch). Bundling them would have made ulze's scope unclear; separating preserves the per-bead "one logical change" discipline.

**Keep `method="braaksma-stokes"` and `sector="stokes"` labels.** They no longer signal "different formula"; they signal "different classifier verdict". This is informational for downstream consumers without changing the wire shape, and it leaves room for the eventual `atip` fix to add a `degenerate-principal-sector` refusal that's distinguishable from the existing classes.

## Frictions surfaced

**Goldens 19, 20 truncation-cap precision.** The regenerated goldens at `|z|=10000` agree with mpmath to ~19-20 dps, not the 25 dps the brief targeted. Cause: the per-pole truncation cap `maxTermsPerPole = max(64, 4·precision) = 200` is 50× smaller than the Paris-Kaminski optimal `N* = ⌊|z|⌋ = 10000`. The kernel surfaces this honestly via two cap-hit warnings in the success record; the value is admissible per CLAUDE.md rule 8. The cap is a pre-existing kernel design choice (worklog 117/119 era), not a new bug. Filed implicitly: if a future bench tightens tolerance at `|z| ≥ 10000`, the cap will need to scale with `|z|`.

**Two pre-existing quadrature-test timeouts surfaced during `bun run check:quick`.** `packages/quadrature/test/tanh-sinh-bf.test.ts` and `packages/quadrature/test/quadrature-bc.test.ts` time out under bun-test's parallel workload. The coding subagent verified via `git stash` round-trip that these reproduce on unmodified main — pre-existing flakiness, not regressions from this session. They join the contour-test timeout (`4kfz`) as a sibling cluster of "long-running tests under bun-test parallel load." Worth filing collectively as a "bun-test parallel timeout hardening" bead at some point.

**The original `egf` v0.1 acceptance criterion was met for the wrong reason.** Goldens 19, 20 at |z|=10000 matched wolframscript to 17 dps under the pre-fix code — but this was *only because the spurious E contribution was 10⁻⁴³⁵ at that |z|*, below precision regardless of multiplier sign. The acceptance was not a verification of the formula; it was an accidental consequence of the test-input choice. Ulze's empirical probe at smaller |z| revealed this. **Lesson: when shipping a formula with multipliers, the acceptance bench must include inputs where the multipliers are numerically load-bearing**. The original `egf` bench would have caught the bug if it had included a `|z| ≈ 10` test, which the Option-C band guard would have refused — at which point the right question would have been "narrow the band guard until we can probe", not "ship with the band guard refusing everything-that-matters".

**Reconsidering follow-up beads.** `ybrw` (bigErfc for Berry smoothing) loses its primary motivation when the multiplier table is deleted. Updated its notes to record the retraction; the bead remains open but the scope is now "bigErfc as a general primitive, useful for unknown future cases", not "unblocker for egf Stokes-band-refused refusals". `fc83` (κ=2 three-term connection) may also collapse — if `H_workbench = G` holds for κ=2 (not yet probed), then `fc83`'s scope becomes "delete coverage-gap refusal, route to assembleAlgebraic". ADR-0039 §D7 notes this.

## Acceptance

- `ulze`: closes. The fix is verified at the math-research test point (33-34 dps) and via 7 regenerated goldens cross-validated against mpmath.
- `atip`: filed (P1 bug). Independently verified golden 17's error before committing to the deletion.
- `ybrw`: notes updated to reflect post-ulze status.
- ADR-0039: Amendment 1 (`43i` regime narrowing) + Amendment 2 (`ulze` retraction) + §D6 (δπ envelope, deferred to `atip`) + §D7 (post-amendment summary). The amendments are large; the original §D3 is struck-through verbatim with `~~text~~` markup so the diff between v0.1 design and v0.2 reality is visible to a future reader.
- `bun run check:quick`: 2032 pass / 4 fail, all 4 are pre-existing timeouts (2 quadrature, 1 contour, 1 contour mutation). None caused by this session.

## Pointers

- ADR — `docs/adr/0039-stokes-connection-coefficients.md` (Amendments 1+2, §D6, §D7)
- Math reference — `docs/refs/dlmf-16-11.md` §§ 2.2 (workbench-H definition), 2.4 (algebraic-sector envelope), 4.3 (the DLMF-H vs workbench-H distinction that this retraction is about)
- Previous worklog (43i + original egf) — `docs/worklog/124-stokes-connection-coefficients.md`
- Post-fix `meijergAsymptotic` — `packages/meijer-core/src/asymptotic.ts`
- Deleted (gone forever): `packages/meijer-core/src/{exponential,stokes}.ts`, `packages/meijer-core/test/{exponential,stokes}.test.ts`
- Pending bead — `bd show atip`
