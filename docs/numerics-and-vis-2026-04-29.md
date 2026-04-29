# Numerics and visualisation in sci-wb — 2026-04-29

A research note, not a decision. Preserves the analysis of sci-wb's
"symbolic-only" stance and what confronting numerics + visualisation
would mean. Companion to `julia-ecosystem-audit-2026-04-29.md`, which
surfaced the cliff this doc names.

## §0. Frame

Sci-wb is ~24 hours old. Stakes are not high; this is an experiment
in substrate design. **The premise of this note is not up for
litigation: numerics and visualisation *will* be confronted.** The
how, when, and in what order are open questions worth experimenting
with rather than deciding under pressure.

What this doc preserves: the shape of the cliff, the candidate
smallest-move, the load-bearing stress points it creates, and the
experiments worth running before committing an ADR.

## §1. What sci-wb is today, honestly

A typing-and-validation substrate for symbolic exact computation. The
10-kind value protocol covers Z, Q, F_p, Q[x_1,…,x_n], Q(x), and
algebraic extensions; tools reason *about* values rather than producing
bulk numerics. The Sturm IR family is symbolic; `cas-*` is exact-
rational; `mod-*` is integer-modular; `ntt` operates over F_p with
provable exactness.

This is roughly:
- ~5% of typical physics workflows (the symbolic plumbing)
- ~10% of ML (mostly the typing/validation slice)
- ~0% of data analysis

The other 90-95% is bulk numerics (matrix factorisation, ODE solving,
optimisation, FFT, Monte Carlo sampling) and visualisation (plots,
diagrams, LaTeX, 3D rendering). Sci-wb has nothing to say about either.

The audit's 12 sibling projects make the gap concrete: of the 12, four
(Lyr, fundingscape, vibefeld-ledger, FQHE) are *category errors* for
sci-wb in its current shape — not because their authors got something
wrong, but because their work is fundamentally numerical /
warehouse / ledger-shaped. Either sci-wb grows to meet them, or it
stays a useful fragment they reference but don't live in.

## §2. The two surfaces, mapped concretely

**Numerics — what's missing**:

| Capability | Current sci-wb | Examples from audit |
|---|---|---|
| Bulk floating-point arrays | None — `float64` is per-scalar `bits` | Lyr voxel grids, FQHE Hamiltonians, NJOY ACE XSS |
| Linear algebra (eigvals, SVD, QR) | None | FQHE ED+DMRG, Sturm density-matrix simulation, NJOY group-constants |
| Numerical integration / ODE | None | Any continuous-time evolution; Lindblad master equation |
| Float FFT | NTT (exact, mod p) only | Signal processing, time-series |
| Optimisation / fitting | None | Hardware calibration fits, ML training |
| Monte Carlo / MCMC | `entropy-source` + `sturm-sample` only | Path integral, Bayesian inference, pricing |

**Visualisation — what's missing**:

| Capability | Current sci-wb | Examples from audit |
|---|---|---|
| Plot rendering (data → SVG/PNG) | None | FQHE transport plot, Lyr volume render, fundingscape charts |
| LaTeX rendering of expressions | None — `expr-parse` consumes LaTeX is sister-tool work, no emitter | Math display in any notebook |
| Circuit diagrams | OpenQASM 3 *text* emission only (Sturm) | Sturm channels visualised, Feynfeld diagrams |
| Tensor-network / Feynman diagrams | None | TensorGR, Feynfeld, qgraf-port |
| 3D / volumetric | None | Lyr, FQHE wavefunctions |
| Interactive plots | None | Notebook surface (Phase 4 in roadmap) |

A demo today is `echo … | bun tool | jq`. That's adequate for tool
authors verifying contracts; inadequate for anyone else.

## §3. Candidate smallest-move

Three moves, each smaller than the value-protocol redesign that the
universal-protocol temptation pushes for. Documented for future-self,
not committed to.

**3.1 Blob-by-hash convention** — *not a new primitive kind*. A small
canonical-JSON descriptor of a stable shape:

```json
{"kind":"record","fields":{
  "blob_hash":{"kind":"string","value":"<sha256-hex>"},
  "dtype":{"kind":"string","value":"float64"},
  "shape":{"kind":"list","items":[{"kind":"integer","value":"1024"}, ...]},
  "layout":{"kind":"string","value":"row-major"}
}}
```

Bytes live in `$CAS_STORE/blobs/<hh>/<blob_hash>.bin` alongside the
existing `$CAS_STORE/provenance/<hh>/<output_hash>.json` records.
fundingscape's `CacheEntry` (`cache.py:62-71`) and QuantumHardware's
`Provenance.sha256` already do this for *source* bytes; the move is
generalising to *derived* bytes. The 10-kind value protocol stays
closed; this is a record convention, not a primitive.

**3.2 Numerical-tool category** with relaxed contracts. Manifest
annotation `numerical: true` declaring:
- Cold-start <100ms still required (the wrapper); processing time
  unbounded.
- Bridges to LAPACK / Julia / Python via the existing `spawnBun`-shaped
  subprocess machinery (ADR-0001).
- **Determinism contract weakens**: deterministic given `(input_hash,
  blob_input_hashes, BLAS_version, platform_pin, tool_version)`. The
  cross-platform-bit-identity guarantee that PRD §6.1 currently asserts
  applies only to symbolic tools.
- Output is typically a blob descriptor.

**3.3 Visual-tool category**. Manifest annotation `visual: true`:
- Output is a blob descriptor with `mime: "image/svg+xml" | "image/png" |
  "application/x-latex" | "application/openqasm" | …`, OR a `string`
  for symbolic vis (LaTeX of an expression, OpenQASM of a circuit).
- The notebook surface (Phase 4 in the roadmap) consumes these.
- Symbolic-vis tools (`cas-to-latex`, `sturm-to-openqasm`) are *not*
  blob-bound — their output is a `string`. No new machinery.

This is the smallest move that adds the missing 90% without growing
the value-protocol's 10-kind closure.

## §4. The stress points it creates

Ranked by severity. Documented honestly because future-self should
not be surprised by them.

**4.1 [LOAD-BEARING] Cross-platform IEEE-754 bit-identity is
impossible.**
LAPACK on x86_64-Linux vs ARM-macOS produces different last bits on
factorisations of ill-conditioned matrices. Sci-wb's PRD §6.1 hard
requirement — "same input bytes ⇒ bit-identical output bytes" —
**does not hold** for numerical tools. Either the rule weakens to
"deterministic given (input, BLAS_VERSION, platform)" or numerical
tools sit outside the determinism guarantee with a different manifest
contract. There is no third option. **This is the load-bearing
relaxation; everything else in the candidate path flows from it.** It
needs an explicit ADR before the first numerical tool ships.

**4.2 Hash equality bifurcates.**
For symbolic outputs: `same hash ⇒ same value` (provenance lookup is
strong). For numerical blob outputs: `same hash ⇒ same specific
computation` (two algorithms producing equivalent answers within
1e-15 ULP have *different* hashes). Equivalence-checking becomes a
separate tool's job — same as `cas-verify` is for symbolic
expressions, but for numerical blobs the analogue would be e.g.
`numeric-allclose` with explicit tolerance.

**4.3 Cold-start rule cracks for the numerical tier.**
Spawning a Julia subprocess per call is ~3-5s overhead. Either:
(a) numerical tools relax cold-start (manifest tier);
(b) sci-wb grows long-lived daemons (breaks the no-shared-state rule);
(c) compile via PackageCompiler.jl (heavy, inflexible).
Path (a) is the path of least resistance and the implied default of
the candidate move.

**4.4 The symbolic / numerical line needs to be drawn.**
Working hypothesis: anything in IEEE-754 with rounding is numerical;
anything in exact rings (Z, Q, F_p, Q[x], Q(x), algebraic) is
symbolic. NTT stays symbolic; FFT becomes numerical. Probably clean.

**4.5 Notebook becomes load-bearing.**
Vis tools produce blobs nobody can see without the notebook surface
(Phase 4). Sequencing implication: numerics-before-notebook works
(numerical results compose with other tools); vis-before-notebook
produces SVGs in a directory. The natural order is therefore
numerics → notebook → vis, not vis → notebook.

**4.6 Licensing matrix expands.**
AGPL-3.0-or-later. LAPACK is fine. Mathematica via subprocess is
problematic. Per-tool license metadata becomes a real concern, not
hypothetical.

**4.7 Test discipline forks.**
Symbolic tools test via property-based mutation-proof (PRD §4.3).
Numerical tools need golden-fingerprint comparison against a reference
on a fixed BLAS — a different discipline. Probably wants its own ADR
section or a §4.3 extension.

**4.8 The subprocess bridge is a transitive contract.**
A numerical tool's purity is gated on the bridged Julia/Python code's
behaviour. Updating the underlying numerical library can change tool
output; sci-wb's provenance must capture this in the
`environment-pin`. Maintenance burden is real but bounded.

## §5. Experiments worth running before committing the ADR

The right move is probably to **run the candidate convention through
existing tooling and see what breaks**, rather than ADR-then-implement.
Concrete prototypes worth trying:

1. **Blob-by-hash for `oracle` goldens.** Some Sturm IRs have large
   goldens; the current pattern stores them inline as JSON. Try storing
   the JSON inline *and* the canonical bytes in a sibling
   `$CAS_STORE/blobs/` location keyed by content hash. Verify the
   provenance lookup pattern extends naturally. **Does not require any
   new tool — it's a store-side convention test.**

2. **One LaTeX-rendering tool** — `cas-to-latex` consuming an
   `expression` and emitting a `string` of LaTeX. **No blob
   machinery needed**; output is a primitive. This tests the
   "symbolic vis = string output" boundary cleanly. If it works, the
   `visual: true` annotation might be unnecessary for symbolic vis.

3. **One numerical-tool prototype** — `numeric-eigvals` (or simpler:
   `numeric-norm-2`) over a `record { matrix: blob-descriptor,
   options: ... }`. Bridge to Julia via subprocess. **Force the
   determinism contract to be defined by writing the property test.**
   The shape of the test will tell you what the ADR needs to assert.

4. **One vis-blob prototype** — `sturm-to-svg` over a Sturm IR.
   Output is a blob descriptor with `mime: "image/svg+xml"`. **Reveals
   how much of the notebook surface is needed for the demo loop to
   close.** If the answer is "almost all of it," the sequencing
   argument in §4.5 becomes a hard constraint.

Each experiment is small. Each tells you something the ADR can't tell
you in advance.

## §6. The non-negotiables that survive

These hold regardless of the candidate move:

- **10-kind value protocol stays closed.** No `blob` primitive. The
  blob-by-hash convention is `record` + a stable shape + the store. The
  discriminator is not extended.
- **Foreign-pass-through invariant (PRD §2.3) unchanged.** Numerical
  tools that don't recognise a subterm wrap it in `tagged
  "<tool>/out-of-scope"` exactly as symbolic tools do.
- **Provenance pattern extends, doesn't redesign.** Bulk bytes get a
  sibling slot in `$CAS_STORE`; the existing provenance record format
  is unchanged.
- **Honest scope.** Numerical tools that can't compute on a given
  input fail loud with `ToolError`, same as symbolic tools.
- **Fail fast, fail loud (Rule 1) unchanged.** Numerical noise (1e-15
  ULP drift) does not become an excuse for silent fallbacks.

The thing that *does* change is the determinism guarantee, and only
for the explicitly-marked numerical tier. That relaxation is the one
load-bearing concession.

## §7. Sequencing, if and when

Not a plan. A natural order if/when the experiments converge:

1. Blob-by-hash convention experiment (§5.1). Outcome: confidence
   that the store extends naturally.
2. Symbolic-vis experiment (§5.2): `cas-to-latex`. Outcome: knowledge
   of whether `visual: true` is needed for the symbolic case.
3. ADR for the determinism-tier split. Forced by §5.3 when the
   property test asks "what does deterministic *mean* here?"
4. First numerical tool ships (§5.3 promoted to production).
5. Notebook surface (Phase 4 in `PRD-v0.2.md` §10).
6. First bulk-vis tool ships (§5.4 promoted to production), backed
   by the notebook surface.

Numerics-before-notebook is the natural order; vis-before-notebook
inverts the demo loop and isn't useful.

## §8. What this note explicitly does NOT do

- Does not commit any code change.
- Does not propose adding any value kind.
- Does not draft the determinism-tier ADR (the forcing experiment
  hasn't run).
- Does not commit to the blob-by-hash convention's exact descriptor
  shape (the §5.1 experiment will inform that).
- Does not decide whether `interval` / `datetime` (from the audit's
  §4) get promoted; those are separate questions that may or may not
  intersect with this one.

Sci-wb is 24 hours old. Acting on first synthesis here would be
exactly the trap the audit warned about. **The cliff is real, the
candidate path is plausible, the experiments are cheap.** Run them
before drafting the ADR.

---

## Pointers

- `julia-ecosystem-audit-2026-04-29.md` §3 (Tier 3 dismissal that §4.2
  acknowledged was probably too eager) and §4.4 (the surviving
  open question on `blob-by-hash` descriptor) — the immediate
  precursors to this doc.
- `PRD-v0.2.md` §6.1 — the determinism rule that bifurcates.
- `PRD-v0.2.md` §10 — the roadmap; notebook surface is Phase 4.
- `docs/adr/0005-externalised-entropy.md` — the closest precedent for
  a manifest-annotated tier (`nondeterministic: true`); the
  numerical/visual annotations would extend the same pattern.
- `docs/adr/0001-subprocess-plumbing.md` — the existing subprocess
  machinery numerical tools would bridge through.
