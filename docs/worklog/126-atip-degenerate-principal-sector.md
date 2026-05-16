# 126 — atip: the δπ algebraic-sector envelope (narrowed to κ ≥ 3)

**Date:** 2026-05-16
**Beads:** `scientist-workbench-atip` (closes — δπ algebraic-sector envelope, the κ=3 δ=0 silent-wrong-answer fix surfaced by yesterday's `ulze` work).
**Touches:** `packages/meijer-core/src/asymptotic.ts` (`classifySector` adds `degenerate-principal-sector` verdict, κ=3 path uses `min(δπ, π)` boundary; `MeijerGAsymptoticRefusal.status` union extended; new refusal branch in `meijergAsymptotic`); `packages/meijer-core/src/dispatcher.ts` (`canUseAsymptotic` adds upstream δ≤0 ∧ κ≥3 refusal); `tools/meijer-g-asymptotic-only/tool.ts` (output-schema union + header comment + refusal-class enumeration); `tools/meijer-g-asymptotic-only/goldens.spec.ts` (deleted-golden-17 placeholder replaced with refusal golden); `tools/meijer-g-asymptotic-only/goldens/17-3-0-…-degenerate-principal-.golden.json` (regenerated); `packages/meijer-core/test/asymptotic.test.ts` (5 new tests: classifier κ=3 δ=0, classifier κ=3 δ<0 half-integer, classifier κ=1 δ=0 admission, layer refusal at deleted-golden-17 input, layer refusal at κ=4 δ=−1/2); `packages/meijer-core/test/asymptotic-mutations.test.ts` (mutation 4b: degenerate principal sector → refuse, not silently emit); `docs/adr/0039-stokes-connection-coefficients.md` (§D6 amendment 1 implementation note; §D7 post-amendment summary updated; status line + open-follow-ups entry).
**Net diff:** ~250 LOC added (mostly comments + tests), ~5 LOC structurally changed in `classifySector`.

## Context

`atip` was filed at the close of worklog 125 (the `ulze` egf-retraction session) as the residual P1 bug surfaced during empirical verification of the algebraic series. The bead description (written yesterday) said:

> Fix: replace κπ/2 with δπ in classifySector's principal-sector boundary; refuse δ≤0 shapes with new tag 'degenerate-principal-sector'.

Visible casualty: deleted golden 17 `G^{1,1}_{1,3}([1/3]; ; [1/2]; [2/3, 3/4] | 50)` had δ=0 and the kernel was silently emitting `+4.4×10⁻³` for an mpmath truth of `−0.5549…` — wrong by ~125× AND wrong sign.

## What changed

The bead's "refuse all δ≤0" specification was **narrowed during implementation to "κ ≥ 3 AND δ ≤ 0"** after the first implementation pass broke seven shipped, mpmath-verified bead-43i tests at κ=1 δ=0 (the `G^{1,1}_{2,2}` / `G^{1,2}_{3,3}` / `G^{1,3}_{4,4}` family). The narrowing is justified by the inner-pFq math; see §"Why these choices" below.

The implemented refusal:

- **κ = 1**: unchanged. The π/2 principal-vs-stokes boundary stays as a diagnostic for the E-Stokes line. δ has no role.
- **κ = 2**: unchanged — already refused upstream as `coverage-gap` (bead `fc83`).
- **κ ≥ 3**: `2δ = 2(m+n) − (p+q) ≤ 0` ⇒ refuse with `degenerate-principal-sector`. For δ > 0 the principal-vs-stokes boundary widens from the legacy π to `min(δπ, π)` — for the common case δ = 1 this matches the pre-`atip` code byte-for-byte; for higher κ with half-integer δ (κ = 4, 6, …; v0.1 has no tests) δπ < π becomes the active boundary.

The new `MeijerGAsymptoticRefusal.status === "degenerate-principal-sector"` carries the `2δ` value in its reason string (rendered as `n/2` for half-integer δ). The dispatcher's `canUseAsymptotic` adds a parallel upstream check so the integrated dispatcher surfaces the refusal cleanly without invoking the layer.

The regenerated golden 17 (`17-3-0-…-degenerate-principal-.golden.json`) exercises the new refusal class at the exact deleted-golden-17 input.

## Why these choices

**Narrow the refusal to κ ≥ 3 (not all δ ≤ 0).** The bead description was over-broad. The empirical signal was loud: the first implementation pass refused 7 tests that were *mpmath-verified to 30+ dps* at κ=1 δ=0 shapes. CLAUDE.md Rule 2 ("all bugs are deep") says investigate root causes; CLAUDE.md Law 1 ("ground truth before code") says the local source-of-truth is the relevant reference. Here the source-of-truth was the inner-pFq convergence story:

- **κ = 1** (p = q). The inner pFq in Slater Series 2 is `pFp-1(1/z)` with radius of convergence 1 (DLMF §16.2). For the asymptotic-regime gate `|z| > 1` the inner converges as a normal power series, and Slater 1966 §5.5's q ≥ p convergence theorem makes the right-closing residue series equal G as a *convergent* formula — not an asymptotic one. δ controls where the algebraic envelope sits in arg z, but it doesn't gate the formula's validity when the inner is convergent. So κ=1 δ=0 shapes are honestly correct.

- **κ ≥ 3** (p ≤ q − 2). The inner is `qFp-1(1/z)` with q ≥ p+2 upper > p−1 lower — formally divergent for any z. The algebraic series is asymptotic-to-G strictly inside the envelope `|arg z| < δπ` and breaks down outside it. With δ ≤ 0 the envelope is empty and the asymptotic has no valid sector → refusal is the honest path.

The §D7 amendment block (written yesterday during `ulze`) already noted "κ=1 with δ=0: probed empirically (`G^{1,1}_{2,2}` Test 1.3); appears to hold on the principal sheet. Not formally proven; deserves a probe if encountered as a regression." The bead-43i test suite *is* that probe at scale — the κ=1 δ=0 behaviour is empirically vetted across 7 (a, b, |z|, arg z) tuples spanning real and complex z and shapes p=2/p=3/p=4. Honoring those tests rather than deprecating them is correct under Rule 2.

The narrowed scope was confirmed via `AskUserQuestion` ("the bead description's 'refuse all δ≤0' breaks 7 shipped mpmath-verified tests; how should I narrow?"); the user delegated to senior-engineer judgment with explicit runway for slow excellent work. The narrowing is documented in ADR-0039 §D6 amendment 1.

**Preserve the κ=1 π/2 boundary as a diagnostic.** Even though for κ=1 δ≥1 shapes H_workbench=G everywhere on the principal sheet (worklog 125 verification), the π/2 boundary still has diagnostic value: it marks the E-Stokes line where the exponential representative `E_{p,p}(z) ~ e^z` switches dominance. A downstream caller reading `sector: "stokes"` on a κ=1 success record learns "the input crossed an asymptotic boundary; the formula is still numerically exact via the convergent-inner-pFq path, but the input is past the E-Stokes line and a tier-aware quality estimator should be told." Widening the boundary to δπ for κ=1 would have erased this distinction for no mathematical gain. The bead-18-23 goldens that depend on the "stokes" label are preserved unchanged.

**Use `2δ` as an integer rather than fighting half-integer δ.** δ = m + n − (p+q)/2 is half-integer when p+q is odd (κ = 2, 4, 6, …). Storing the verdict as `twoDelta: number` (an integer) and the reason string as `n/2` for odd 2δ keeps the BigFloat arithmetic exact (`(2δ · π) / 2`) and makes the comparison `2δ ≤ 0` trivially correct. Avoids representing rationals in a context where only the sign and the BigFloat embedding matter.

**The mutation-prove test (4b) asserts the refusal rather than re-exhibiting the bug.** The pre-`atip` kernel value `+4.4×10⁻³` at the deleted-golden-17 input is captured in a comment in `asymptotic-mutations.test.ts`. The test asserts the kernel now refuses; the *bug magnitude* (~125× wrong, wrong sign vs mpmath truth `−0.5549…`) lives in the comment as a witness for any future reader considering lifting the refusal. This mirrors mutation 4's pattern ("the sector classifier wrongly admits secondary sector ⇒ would silently produce a wrong value; the kernel currently refuses").

## Frictions surfaced

**The bead description overstated scope by one κ-regime.** Writing the bead at the end of yesterday's session, the description elided the inner-pFq convergence story that distinguishes κ=1 from κ≥3. Filing a bead with an incomplete math story is a hazard — the next session implements literally and either ships a regression or has to circle back to narrow. The right fix is what worklog 125's §D7 already did (note the empirical observation about κ=1 δ=0) and what this shard's §D6 amendment 1 codifies (write the math story explicitly in the ADR before resolving the bead). For future beads in this area: include the inner-pFq convergence regime in the bead body, not just the casualty description.

**No subagents.** Decision was made directly by the orchestrator after running the failing tests once and reading the relevant ADR sections + canonical reference. The math story is small and known (Slater 1966 §5.5 is one sentence; DLMF §16.2 is a paragraph). Spawning a subagent for this would have cost time without producing better signal — the failure mode and the relevant references were both already in the working set. Senior-engineer instinct: when the question is "which of two regime-specific math claims is right" and both claims are written in the reference doc, just read carefully and decide.

**Wire-label preservation is intentional, not a bug.** The bead text "replace κπ/2 with δπ in `classifySector`'s principal-sector boundary" reads as a unilateral widening for all κ. The narrowed implementation preserves the κ=1 boundary at π/2 specifically to preserve the diagnostic semantics of the "stokes" wire label on existing κ=1 goldens (18-23). A future bead could widen κ=1's boundary to δπ as a separate wire-label-change ADR (the numerics would be unchanged); that work is *not* atip's scope. Captured in §D6 amendment 1.

## Acceptance

- `atip`: closes. The κ=3 δ=0 silent-wrong-answer regime is now an honest `degenerate-principal-sector` refusal at both the classifier and the layer surface.
- New refusal class `meijer-g-asymptotic-only/degenerate-principal-sector` is exposed at the tool wire schema; the umbrella `tools/meijer-g` tool propagates through via its `S.any()` output (no schema enumeration needed).
- Replacement golden 17 (`17-3-0-…-degenerate-principal-.golden.json`) exercises the new refusal at the exact deleted-golden-17 input.
- 5 new tests in `asymptotic.test.ts` (3 classifier-direct + 2 layer-level) + 1 mutation-prove test pin the new behaviour and the κ=1 admission invariant.
- ADR-0039 amended: §D6 implementation note (Amendment 1 documents the κ=1 carve-out math story); §D7 post-amendment summary updated to reflect the implemented refusal scope.
- `bun test packages/meijer-core/ tools/meijer-g/ tools/meijer-g-asymptotic-only/ tools/meijer-g-slater-only/ tools/meijer-g-symbolic-only/`: 242 pass / 1 skip / 0 fail.
- `bun tools/meijer-g/tool.ts --test`: passes (3 dispatch lanes).

## Pointers

- ADR — `docs/adr/0039-stokes-connection-coefficients.md` (§D6 amendment 1; §D7 update)
- Math reference — `docs/refs/dlmf-16-11.md` §2.4 (algebraic-sector envelope), §2.2 (workbench-H definition); Slater 1966 §5.5 (q≥p convergence)
- Previous worklog (`ulze` retraction) — `docs/worklog/125-ulze-stokes-retraction.md`
- Post-fix `classifySector` — `packages/meijer-core/src/asymptotic.ts:300`
- Post-fix `canUseAsymptotic` — `packages/meijer-core/src/dispatcher.ts:388`
- Refusal class on the wire — `tools/meijer-g-asymptotic-only/tool.ts`
- Deleted-golden-17 replacement — `tools/meijer-g-asymptotic-only/goldens/17-3-0-…-degenerate-principal-.golden.json`
- Bead — `bd show atip`
