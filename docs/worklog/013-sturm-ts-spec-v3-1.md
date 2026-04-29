# 013 — Sturm-TS v3.1 spec amendment

**Date:** 2026-04-29
**Status:** complete (P2 amendment captured under repo control;
 full v3 PRD body remains pending an external paste)
**Branches:** main
**Issues:** scientist-workbench-0lo (closed; with note about pending
 spec-v3.md body paste)

## Context

The Sturm-TS v3 PRD lives in the user's session transcript and was
the basis for shard 009's planning. During the planning conversation
the user pushed back on one specific claim — that prepare and observe
were "boundary primitives" categorically distinct from `ry` and `rz`.
The pushback sharpened to:

- The classical/quantum distinction is **type-level** (`Q<T>` is
  structurally unrelated to `T`), not channel-level (some channels
  being privileged over others).
- `prepare` and `observe` *are* channels (cq and qc respectively),
  not "boundary primitives." They sit in the same category as `ry`,
  `rz`, with specific input/output type-shapes.
- The "boundary is a cast" framing in v3's P2 inadvertently elevated
  prepare and observe in a way that clashed with P3 (op-is-op).

This called for a v3.1 amendment to P2, with a knock-on prose update
in §3.2 (the channels section), and the spec living under repo
control rather than in transcripts only.

## What changed

A new directory **`docs/sturm-ts/`** was created with two files:

- **`docs/sturm-ts/README.md`** — index and orientation. Documents
  what `Sturm-TS` is, lists the contents of the directory, explains
  the v3 → v3.1 amendment in two paragraphs, and points at the ADRs
  that realise the principles at the workbench layer (0005, 0006,
  0007).

- **`docs/sturm-ts/principles.md`** — the nine principles P1–P9
  with the v3.1 reframing of P2. Each principle has a short prose
  body covering both the TS-surface meaning and the IR-layer
  realisation (where ADR-0006 makes a structural claim, the
  principle text references it).

The v3.1 P2 text:

> The type system separates classical types from quantum types. cq
> channels (`prepare`, `oracle`) and qc channels (`observe`) are the
> morphisms that cross the type-level distinction. `discard` is the
> qq → terminal channel (partial trace). All of these — including
> `prepare`, `observe`, and `discard` — are channels in the same
> category as `ry`, `rz`. They are uniformly node-shaped in the IR.
> There is no separate "boundary primitive" category that elevates
> them above other ops. The boundary is a type-level fact (which
> arrows the type system admits), not a channel-level distinction.

The §3.2 prose followup is the explicit clarification that observe is
a qc channel (same category as ry, just with different input/output
type-shapes), captured in `principles.md` under §1.1's P2 body.

The implicit-cast warning convention is preserved verbatim from v3:
an implicit assignment `let x: bool = q;` where `q: QBool` triggers
a compiler warning, by analogy with float-to-int truncation. P2 is
type-level; the warning is the surface-level safety net.

The full v3 PRD body (other sections beyond §1 axioms and §3.2
channels) is *not* in this commit. The README documents the status:
"pending external paste." The core v3.1 amendment is captured in
`principles.md`; the rest of the PRD body remains a follow-up paste
when the transcript is at hand.

Cross-references landed in:

- `docs/adr/0006-sturm-ir-as-value.md` — explicitly references the
  v3.1 reframing ("prepare and observe are uniformly node-shaped;
  P3 is realised exactly. The v3.1 amendment to P2 (cf.
  `docs/sturm-ts/principles.md`) is reflected in the IR by *not*
  having a separate 'boundary' category").

## Why these choices

**Capture the amendment now, defer the full PRD paste.** The
amendment is the substantive change; the rest of the v3 PRD is text
the user can paste from transcript when convenient. Blocking the
Phase 0 close on the full paste would gate ADR-0006's downstream
(Phase 1) work on a paste-from-transcript step. Honest status
reporting — "amendment landed, rest of body pending" — keeps Phase 0
moving.

**`principles.md` rather than embedding in the ADR.** Considered
folding the principles into ADR-0006 directly. Rejected: the
principles are the *Sturm-TS spec*'s axioms, not a workbench design
decision. They live in `docs/sturm-ts/`; the ADRs cross-reference
them. That separation matches CLAUDE.md Law 1 (ground truth lives
where it conceptually belongs).

**Document both the TS-surface meaning and the IR-layer
realisation.** Each principle has a body explaining the TS surface
(what the language demands of the source code) and, where relevant, a
"At the IR layer (ADR-0006)" sub-paragraph noting how the principle
is structurally enforced at the workbench layer. This double-vision
is what the workbench port adds; capturing it in `principles.md`
means a future agent reading the principles sees both layers.

## Frictions surfaced

- **The full v3 PRD body is not yet under repo control.** Issue
  scientist-workbench-0lo's first acceptance criterion ("Sturm-TS
  spec lives under docs/sturm-ts/ in this repo") is partially
  satisfied — the directory exists, the principles are captured, the
  README documents the status. The remaining acceptance (full §3.2
  prose updated, cross-reference from `spec-v3.md` to ADR-0006) is
  blocked on the external paste. The issue is closed with a note;
  the follow-up will be a small subsequent shard when the paste
  lands.

- **Open Question Q5 (Classical<T> truthiness).** The v3 PRD has
  open questions; Q5 in particular is unaffected by this amendment
  but isn't resolved here. `principles.md` notes this in the P2
  body. Q5 is its own design decision, parked.

- **TS-surface details (decorators, Q<T>'s implementation, the
  `@quantum_lift` macro analogue) are described at the level needed
  for cross-reference, not implementation.** The Phase 2
  `sturm-trace` issue (scientist-workbench-q0b) will need the full
  v3 surface details when the trace runtime lands; the principles
  doc is enough for the IR-layer work in Phase 1.

## Acceptance

- `docs/sturm-ts/` directory exists and is under repo control.
- `docs/sturm-ts/principles.md` captures P1–P9 with the v3.1
  amendment to P2.
- `docs/sturm-ts/README.md` documents the status of the spec
  materials, including the pending paste of the full v3 PRD body.
- ADR-0006 cross-references `docs/sturm-ts/principles.md`.
- `docs/worklog/README.md` index updated.
- Issue scientist-workbench-0lo closed with a note about the
  remaining external-paste work (no follow-up beads issue filed
  yet — that's a small enough piece of work it can be a one-line
  addendum to a future shard rather than a tracked issue).

## Pointers

- `docs/sturm-ts/principles.md` — P1–P9, v3.1.
- `docs/sturm-ts/README.md` — directory index and v3 → v3.1 summary.
- ADR-0006 — the workbench-side IR encoding that realises the
  principles.
- Issue scientist-workbench-0lo — the beads-tracked work item.
- Shard 009 — the planning shard where the v3.1 amendment was
  motivated by the design conversation.
- `Sturm.jl/Sturm-PRD.md` §1 — the original Julia-side principles
  text; the v3.1 amendment in `docs/sturm-ts/principles.md`
  aligns with that source on P1, P3–P9 and amends P2 only.
