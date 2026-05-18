# 099 — qinfo v0.1 complete (choi-iso + partial-transpose) + canonicalize typed switch (2026-05-12)

> **Scope.** Close the qinfo v0.1 surface by shipping the two tools
> filed in shard 098 (`pk0c` choi-iso, `yjs9` partial-transpose) on top
> of the already-landed substrate. Each is a thin Value-↔-Matrix wrapper
> over a substrate operation that is pure index permutation. The two
> together unlock the Peres–Horodecki criterion as an end-to-end
> composition with `linalg-eigh`: on the *channel side* via the Choi
> matrix (transpose-map → `J = SWAP` → eigenvalue `−1`), on the *state
> side* via the partial transpose of a bipartite state (Bell state →
> `(1/2) SWAP` → eigenvalue `−1/2`). Small refactor in the same session:
> `packages/protocol/src/canonical.ts` rewritten as an exhaustive switch
> on `Value.kind`, replacing the `walks unknown` defensive form
> (`80i` resolved).

## Context

Shard 098 landed the qinfo substrate plus the two most-used wire tools
(`tensor-product`, `partial-trace`). The same shard *filed* but did not
ship two follow-up tools — `partial-transpose` and `choi-iso` — for two
reasons: (1) they were lower frequency than the partial-trace + kron
pair that the Wasserstein-1 dogfood needed first; (2) the substrate's
own `partialTranspose` and `choi` / `deChoi` functions were already
exercised by the substrate's own tests, so the only remaining work was
wire-shape + dim guard + goldens. That meant the session closing 098
could legitimately stop with the substrate in, knowing the wrappers
were a half-day of careful template-following with no novel decisions.

This session opened with the user inviting me to pick what to work on
("what attracts you, what would *you* desire to work on as a TS
expert?"). The qinfo v0.1 follow-ups were the obvious pull: the
substrate door was open, the bead bodies were already well-formed
(invariants enumerated, conventions pinned, ≥10 examples named), and
the two tools together would deliver a coherent CP/PPT testing tier
rather than a stranded substrate with no handles. The `80i`
canonicalize refactor was added as a palate-cleanser: small, satisfying
TS-discipline work where a fresh reader would benefit from the rewrite
even though the existing code worked.

Pre-implementation research: a Sonnet subagent verified that the
substrate's Choi convention (input-on-left, column-stacking vec) is
bit-identical with Watrous (TQI §2.2), QuTiP `to_choi`, Qiskit `Choi`,
and Wood–Biamonte–Cory Eq. 3.22 (the column convention). It also
flagged six classes of subtle sign / permutation pitfall (column- vs
row-stacking, normalised- vs unnormalised-`Ω`, Qiskit's `SuperOp` using
row-stacking while `Choi` uses column-stacking, etc.). All of those
were already locked correctly by ADR-0034 §D7; the research was
verification, not discovery.

## What changed

### `tools/choi-iso/` (new — bead `pk0c` closed)

Wraps `qinfo.choi` and `qinfo.deChoi`. The novel design point is the
input shape: the tool serves two directions (channel → Choi and Choi →
channel), and a TS expert would model that as a discriminated union.
The protocol vocabulary is `S.union([S.tagged(...), S.tagged(...)])` —
which has been used for *output* unions on every refusal-bearing tool
(`hypergeometric-pfq`, `integrate-1d`, `poly-factor`, `sdp-solve`, …)
but never on an *input* until now. The symmetry — same vocabulary on
input as on output — was the test for "does this read like something a
TS expert would type without thinking." It does.

- Input: `union[tagged "channel-to-choi" record{channel, dim_in, dim_out},
  tagged "choi-to-channel" record{J, dim_in, dim_out}]`.
- Output: `union[record{J, shape, warnings}, record{channel, shape,
  warnings}]`. The matrix-bearing field is named after what it *is* —
  `J` for Choi, `channel` for superoperator — rather than an opaque
  `result` (the caller chose the direction, so the named field reads
  more naturally and self-documents at the call site).
- Refusals: shape/dim/non-finite are `ToolError`. The bead originally
  proposed tagged-refusal categories (`shape-mismatch`,
  `non-square`, …); the partial-trace precedent under ADR-0003 had
  already collapsed all such cases to `ToolError` — *the Choi
  isomorphism has no "out of scope" branch of the math*, so any
  rejection is a contract violation by the caller, which is exactly
  what `ToolError` is for.

12 goldens cover: identity on qubit (both directions), identity on
qutrit (d ≠ 2), transpose map (canonical positive-but-not-CP witness),
depolarising at p = 1/2 and p = 1, amplitude-damping at γ = 1/2 and
γ = 1, replacement channel with d_in ≠ d_out, round-trip on
depolarising (forward-then-inverse exactness), and the zero channel
(trivial branch). The `--test` hook proves round-trip exactness on the
amplitude-damping channel, structural identity on the qubit identity
channel, and `J(transpose) = SWAP`.

### `tools/partial-transpose/` (new — bead `yjs9` closed)

Wraps `qinfo.partialTranspose`. Input shape mirrors `partial-trace`'s
`record{M, dims, transposeOn}` (uniform sibling-tool style). Output is
`record{M_pt, shape, warnings}`. All refusals → `ToolError` (same
reasoning as choi-iso; partial-trace precedent).

12 goldens cover: Bell state PT on each qubit (the canonical PPT
witness), singlet PT, product-state PT (a no-op), the PT-on-whole-system
= full-transpose identity, vacuous PT (transposeOn = []), qutrit ⊗ qubit
mixed dims, three-qubit cases including PT on the middle qubit and PT
on multiple subsystems simultaneously. The `--test` hook proves
`PT_B(|Φ+⟩⟨Φ+|) = (1/2) SWAP_4`, involution `PT_S(PT_S(M)) = M`,
whole-system-PT = full-transpose, and vacuous PT = identity copy.

### End-to-end composition demos (scripts/demo-scope.ts)

Two new sections `#21` and `#22`. Both run in this process via
`@workbench/compose`:

- `#21 choi-iso ∘ linalg-eigh — the transpose map is not CP`: builds
  the transpose map's superoperator (which is SWAP_4 in column-stacking
  vec), Choi-converts it (still SWAP_4 — fixed point), runs eigh,
  prints eigenvalues `[-1.0000, 1.0000, 1.0000, 1.0000]`. The single
  negative number is the not-CP witness.
- `#22 partial-transpose ∘ linalg-eigh — Bell state is entangled`:
  takes `|Φ+⟩⟨Φ+|`, partial-transposes on one qubit (output is
  `(1/2) SWAP_4`), runs eigh, prints `[-0.5000, 0.5000, 0.5000, 0.5000]`.
  The −0.5 is the Peres–Horodecki witness.

These two demos exhibit the same criterion from two angles (channel-
side vs state-side); they make the qinfo tier *useful* as a coherent
surface rather than a list of disconnected wrappers.

### `packages/protocol/src/canonical.ts` (refactor — bead `80i` closed)

Replaced `encodeAny(x: unknown, path)` with an exhaustive
`encodeValue(v: Value)` switching on `v.kind`. Each of the ten kinds
gets a single branch that emits its fields in lexicographic order
(*not* declaration order — e.g. `rational` encodes as
`{"den":…,"kind":…,"num":…}`). `noFallthroughCasesInSwitch`
(tsconfig.json) gives compile-time coverage: adding a new kind to the
`Value` union will fail the build at this site.

The defensive `record`-field `val === undefined` skip is kept (cheap;
guards against optional-field assignment leaking `undefined` through
the type system). The `path` parameter is gone — no `ProtocolError`
paths remain to label.

What disappeared: branches for `typeof x === "number"`, `x === null`,
`typeof x === "bigint"`, `Array.isArray(x)` *as Value containers*.
None of those cases are reachable from a validated `Value` input;
upstream `parse()` / `validateValue` rejects them at the boundary.
Removing the branches removes the obscuring middle layer and lets the
encoding logic stand on its own. The function is ~30 lines shorter
overall (without comments) and reads top-to-bottom as the ten kinds in
the protocol; doc-comments explain the lexicographic ordering note
because the rational/float64 ordering is the easy stumble.

The protocol test suite (1000-trial random round-trip, 1000-trial
hash-determinism, key-reorder-on-parse, encoding-format spot checks)
all pass on the rewrite, and the 350+ tool goldens re-replay
byte-identically across `bun run check`.

## Why these choices

### Discriminated-union input as a TS-native primitive

The two principles were the deciding lens. A TS expert writing two
related operations that take different inputs reaches for a
discriminated union; the runtime narrowing on `input.tag` then keeps
the function body straight-line. The alternatives were:

1. Two separate tools (`choi-forward`, `choi-inverse`). Doubles the
   registry surface and forces the planner to know two tool names for
   what is morally one operation.
2. Single record with `mode: "forward" | "inverse"` discriminator and
   both `channel` and `J` as optional fields. Loses the compile-time
   guarantee that the right matrix accompanies each mode; introduces
   `optional: ["channel", "J"]` cosmetic friction.
3. Discriminated union over tagged inputs. What we shipped. The
   protocol's `S.union` + `S.tagged` is the exact vocabulary; the
   runtime check is `input.tag === FORWARD_TAG`; TS narrows. *This is
   the form a TS expert would type without thinking.*

### Bead text vs precedent (refusal categories)

Both bead bodies (`pk0c` and `yjs9`) listed tagged refusal categories
for shape/dim/non-square errors. The partial-trace precedent under
ADR-0003 had already resolved the same situation in favour of
`ToolError` for these cases: the math has no "out of scope" branch, so
every rejection is a contract violation by the caller. I diverged from
the bead text in line with the precedent. Both tool files contain a
prose comment block explaining the choice, so a future reader doesn't
re-litigate it.

### Canonicalize refactor scope

The bead suggested keeping a `validateAndCanonicalize` companion for
"callers with truly unknown input." A grep of the codebase shows zero
such callers — every external user (`hash`, `schema.literal`,
`provenance.platform`, the json-bridge / contract / sturm-ir tests,
the alg-num / contract / json-bridge production sites) passes a
`Value`-typed argument. The speculation didn't materialize. Anyone
with `unknown` can call the existing `validateValue` from
`validate.ts` first — the canonical encoder doesn't need to dual-purpose.

## Frictions surfaced

### Lexicographic ordering is not declaration order

For the canonical-encoding rewrite I had to spot-check each of the ten
kinds' key orders. Two cases bit me before I caught them:
`rational`'s declared order is `kind, num, den` but lexicographic is
`den, kind, num`; `float64`'s declared order is `kind, bits` but
lexicographic is `bits, kind`. Easy to miss because every *other* kind
has `kind` first or order-equivalent. A doc-comment on the canonical
encoder now flags this explicitly. The 1000-trial property test would
have caught it instantly; the goldens would have caught it byte-for-
byte. So this was a "the test suite already exists and is excellent"
moment, not a near-miss.

### `tail -10` of a long background pipeline buffers to nothing

I ran `bun run check 2>&1 | tail -10` in `run_in_background` mode, and
the output file came back zero-bytes-and-empty even after the process
exited 0. The exit code is the source of truth; the file is whatever
`tail` decided to do under buffering. For future background checks:
either drop the `tail` (let the full log go through), or pipe through
`stdbuf -oL tail -10`, or `>` redirect to a file and `tail` it
separately. The pattern in this shard was a one-off; not worth a
helper.

### Two parallel section-numbering schemes in `scripts/demo-scope.ts`

`demo-scope.ts` mixes `header(N, ...)` calls (older sections #1–21)
with raw `console.log("=".repeat(60))` blocks (newer sections #15, #19,
#20, my new #21 and #22). The duplicate "#15 poly-factor" and "#21
choi-iso" don't actually collide at runtime because they print
different banners, but the file's organization has drifted. Not worth
unwinding in this session; flagging in case a future shard tidies up.

### `T_super = SWAP_4` is itself a worked example worth saving

The transpose map's superoperator-matrix in column-stacking is *the
SWAP matrix*. So is its Choi matrix. Both forms are fixed points of
the iso for this specific map. The two facts together let the
choi-iso `--test` hook structurally check both directions of the iso
on the most informative non-trivial channel without any tolerance
budget — every comparison is exact. Worth a sentence in the README and
in this shard because a future reader who wonders "why is the
canonical test the transpose map?" deserves to know that the answer is
"because every check is exact-equal, not bounded-by-eps."

## Acceptance

- `bun run check`: 83 phases passed, 7 skipped, 0 failed (full sweep,
  pre-commit gate). Three runs in this session (post-choi-iso, post-
  partial-transpose, post-canonicalize-refactor) all green.
- `bun test packages/protocol/test/protocol.test.ts`: 28 pass, 0 fail,
  3064 expect() calls — the 1000-trial random round-trip and hash-
  determinism tests covered the canonicalize refactor with zero drift.
- `bun scripts/demo-scope.ts`: 22 demo sections all run in-process;
  the new sections #21 and #22 print the expected eigenvalues
  (`[-1.0000, 1.0000, 1.0000, 1.0000]` for `choi(T)` and `[-0.5000,
  0.5000, 0.5000, 0.5000]` for `PT(|Φ+⟩⟨Φ+|)`); total wall-clock
  ≈ 1.1s for the whole demo with 46 tools loaded once.
- Three beads closed: `pk0c` (choi-iso), `yjs9` (partial-transpose),
  `80i` (canonicalize typed switch).
- Catalog rows in `README.md` updated for both new tools; qinfo
  paragraph in the File Layout updated from "queued" to "complete";
  ADR-0034's "v0.1" tool list now matches reality.

## Pointers

- Beads: `pk0c` (choi-iso), `yjs9` (partial-transpose), `80i`
  (canonicalize-typed-switch).
- ADRs: ADR-0034 (qinfo substrate, §D6 / §D7 design rationale for
  partial-transpose and Choi convention).
- Tool sources: `tools/choi-iso/tool.ts`, `tools/partial-transpose/
  tool.ts`. Substrate: `packages/qinfo/src/choi.ts`,
  `packages/qinfo/src/partial-transpose.ts`.
- Demo: `scripts/demo-scope.ts` sections #21 and #22.
- Canonicalize: `packages/protocol/src/canonical.ts` (full rewrite).
- Prior shard: 098 (substrate + tensor-product + partial-trace).
- External references for the convention check: Watrous, *Theory of
  Quantum Information*, §2.2; Wood, Biamonte, Cory,
  `arXiv:1111.6950v2`, Eq. 3.22 (column convention) + Eq. 4.1
  (reshuffling); QuTiP `superop_reps.py::kraus_to_choi`; Qiskit
  `quantum_info.operators.channel.choi`. Peres, *PRL* 77, 1413 (1996)
  for the PPT criterion; Horodecki³, *PLA* 223, 1 (1996) for
  necessity-and-sufficiency on 2×2 and 2×3.
