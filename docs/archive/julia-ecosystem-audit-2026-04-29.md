# Julia ecosystem audit — 2026-04-29

A snapshot, not a plan. This document records what the user's sibling Julia
(and adjacent) projects look like *today* on seven axes that matter to
`scientist-workbench` (sci-wb): value taxonomy, on-wire shape, binders,
context carriage, canonicalisation, foreign-node handling, and the load-bearing
regret of each IR. The final section asks honestly what should — and what
should not — try to fit into sci-wb's microservice-tool model.

This is **not an ADR**. It informs ADRs that may follow; it is not itself
a decision.

## Scope and method

Twelve sibling projects in `~/Projects/` were audited:

| Project | Path | Verdict |
|---|---|---|
| Sturm.jl | `~/Projects/Sturm.jl` | emits structured values |
| Bennett.jl | `~/Projects/Bennett.jl` | in-memory IR only |
| Feynfeld.jl | `~/Projects/Feynfeld.jl` | in-memory IR only |
| NJOY.jl | `~/Projects/NJOY.jl` | emits structured values |
| TensorGR.jl | `~/Projects/TensorGR.jl` | in-memory IR only |
| Lyr.jl | `~/Projects/Lyr.jl` | emits structured values (binary) |
| Abstractfeld.jl | `~/Projects/Abstractfeld.jl` | empty (PRD only) |
| Integralis | `~/Projects/Integralis` | emits structured values |
| QuantumHardware.jl | `~/Projects/QuantumHardware.jl` | emits structured values |
| fundingscape | `~/Projects/fundingscape` | emits structured values |
| vibefeld | `~/Projects/vibefeld` | emits structured values |
| FQHE | `~/Projects/FQHE` | numerical pipeline, no IR wire |

Each project was inspected by an independent research agent reading struct
definitions, serialisers, and any spec docs; reports are reproduced verbatim
in §1. The disagreement matrix in §2 collates positions across the seven
axes. §3 is an analysis of where sci-wb would come under tension if it tried
to absorb the lot — and which absorptions are honest extensions vs. category
errors.

The user asked specifically for "Alethfeld" — no project of that name exists
in the parent folder. Abstractfeld.jl is the closest "feld"-family project
and is currently empty (PRD + AGENTS docs only); it is included in the index
above for completeness and excluded from the matrix.

---

## §1. Per-project audits

### Sturm.jl

**Path:** `/home/tobiasosborne/Projects/Sturm.jl`

**Emits/consumes structured values?** Yes — in-memory DAG IR + OpenQASM 3
text + hand-rolled NDJSON wire protocol for hardware sessions.

#### 1. Value kinds
- `WireID` — opaque `UInt32` qubit-wire reference.
- `DAGNode` (abstract) → `PrepNode`, `RyNode`, `RzNode`, `CXNode`, `ObserveNode`, `CasesNode`, `DiscardNode`. `HotNode` is the isbits union of all but `CasesNode`.
- `Channel{In,Out}` — typed wrapper of DAG + input/output wire tuples.
- `ClassicalRef` — symbolic measurement-outcome handle in tracing mode.
- Quantum register types (subtypes of `Quantum`): `QBool`, `QInt{W}`, `QMod{d,K}`, `QCoset{W,Cpad,Wtot}`, `QRunway{W,Cpad,Wtot}`, `QRunwayMid{...}`.
- `QROMTable{Ccmul,W,Nentries}` / `QROMTableLarge{Ccmul,W}` — classical lookup tables for QROM.
- `PauliOp` (enum), `PauliTerm{N}`, `PauliHamiltonian{N}` — operator-valued kinds.
- `BlockEncoding{N,A}`, `QSVTPhases` — algorithm IR records.
- `ProtocolOp` + JSON envelopes (`open_session`, `close_session`, `submit`, `ok`/`err`) — hardware wire kinds.
- Algorithm-strategy singletons (`Trotter1`, `Trotter2`, `Suzuki{K}`, `QDrift`, `Composite`, `QSVT`).

#### 2. On-wire shape per kind

DAG node structs (`src/channel/dag.jl`):
```julia
src/channel/dag.jl:47   struct PrepNode <: DAGNode
                          p::Float64; wire::WireID; ctrl1::WireID; ctrl2::WireID; ncontrols::UInt8
src/channel/dag.jl:62   struct RyNode <: DAGNode
                          angle::Float64; wire::WireID; ctrl1::WireID; ctrl2::WireID; ncontrols::UInt8
src/channel/dag.jl:114  struct CasesNode <: DAGNode
                          condition_id::UInt32; true_branch::Vector{DAGNode}; false_branch::Vector{DAGNode}
src/channel/dag.jl:131  const HotNode = Union{RyNode,RzNode,CXNode,PrepNode,ObserveNode,DiscardNode}
```

`WireID` (`src/types/wire.jl:7`): `struct WireID; id::UInt32; end`.

`Channel` (`src/channel/channel.jl:10`): `dag::Vector{HotNode}` + `input_wires::NTuple{In, WireID}` + `output_wires::NTuple{Out, WireID}`.

Hardware NDJSON `ProtocolOp` (`src/hardware/protocol.jl:26`): `verb::Symbol; fields::Dict{String,Any}`. Emission rule (`:53-57`): `d = copy(op.fields); d["g"] = String(op.verb)`.

#### 3. Binders
None. IR is a flat `Vector{HotNode}` indexed by globally-unique `WireID` (`fresh_wire!` via `_wire_counter::Ref{UInt32}`); `CasesNode` is the one structural construct (two child `Vector{DAGNode}`). Lexical scope exists in Julia (`when` push/pops a control stack inside a context), but the IR captures only the post-flattening op stream.

#### 4. Context carriage
Mostly **type parameters**, with global TLS for backend and one anomaly:
- `WireID` is globally unique, context-free.
- Active backend held in task-local storage by `@context` (`src/context/abstract.jl:233`).
- Quantum register dimensions encoded in Julia type parameters (`QInt{W}`, `QMod{d,K}`).
- **Exception**: `QCoset.modulus::Int` is a runtime field, not a type parameter (`src/types/qcoset.jl:48`).
- Pauli operator count `N` is a type parameter on `PauliTerm{N}`.
- Hardware envelope carries `"v": PROTOCOL_VERSION` per message.

#### 5. Canonicalisation
None. Hand-rolled JSON encoder iterates `AbstractDict` in insertion order (`src/hardware/protocol.jl:181-192` — no key sort). Numerics on the wire as raw JSON numbers. No hash-stable bytes. OpenQASM emission orders qubits by `WireID.id` for register layout (presentation only).

#### 6. Foreign / unknown nodes
**Hard error**, no pass-through. `Channel` rejects any non-`HotNode` (`src/channel/channel.jl:23-34`); OpenQASM emission has no fallback method. Hardware protocol decoder rejects unknown verbs explicitly (`src/hardware/protocol.jl:67`).

#### 7. Most regrettable design decision
Carrying `modulus` as a non-type runtime field on `QCoset` (`src/types/qcoset.jl:48`) while every other dimension/width parameter (`W`, `Cpad`, `Wtot`, `d`, `K`, `N`, `Ccmul`) lives in the type — this asymmetry breaks the otherwise uniform "context lives in type parameters" rule and forces special cases in any future serialiser, equality test, or dispatch table that wants to treat all `Quantum` registers uniformly.

---

### Bennett.jl

**Path:** `/home/tobiasosborne/Projects/Bennett.jl`

**Emits/consumes structured values?** No on-wire format — Bennett is a Julia-internal LLVM-IR-to-reversible-circuit compiler whose types live only as Julia structs in process memory; consumes LLVM IR via `LLVM.jl` but emits no JSON/TOML/custom wire format.

#### 1. Value kinds (in-memory only)
- `IROperand` — SSA-name reference or integer constant.
- `IRInst` family — `IRBinOp`, `IRICmp`, `IRSelect`, `IRRet`, `IRCast`, `IRPtrOffset`, `IRVarGEP`, `IRLoad`, `IRStore`, `IRAlloca`, `IRInsertValue`, `IRExtractValue`, `IRCall`, `IRBranch`, `IRSwitch`, `IRPhi`.
- `IRBasicBlock`, `ParsedIR`, `PtrOrigin` / `MemSSAInfo`.
- `ReversibleGate` (`NOTGate` / `CNOTGate` / `ToffoliGate`) and `ReversibleCircuit`.
- `LoweringResult`, `SoftFloat` (UInt64-bits Float64 wrapper).

#### 2. On-wire shape per kind
N/A — nothing serialised. Struct definitions at `src/ir_types.jl:16-323` and `src/gates.jl:7-111`. Only "external" format consumed is opaque LLVM IR via `LLVM.jl` (`src/ir_extract.jl:125,178`).

#### 3. Binders
N/A — flat SSA over `Symbol` names. `IRPhi.incoming::Vector{Tuple{IROperand,Symbol}}` joins values across labelled blocks (`src/ir_types.jl:223-236`). No lambda binders, no de Bruijn — names globally unique within a `ParsedIR`.

#### 4. Context carriage
**Per-instruction fields, duplicated.** Bit-`width` is repeated on essentially every instruction (`IRBinOp.width`, `IRICmp.width`, `IRSelect.width`, `IRCast.{from_width,to_width}`, etc., `ir_types.jl:34-236`). `ParsedIR.args::Vector{Tuple{Symbol, Int}}` for arg widths; `ret_width` + `ret_elem_widths` for return shape. Constants live in `ParsedIR.globals::Dict{Symbol, Tuple{Vector{UInt64}, Int}}` side-table.

#### 5. Canonicalisation
N/A — nothing serialised. `print_circuit` (`src/diagnostics.jl:102-114`) emits human-readable summary. Benchmark JSONL via `string` interpolation (`benchmark/sweep_cell.jl:87`) for telemetry only.

#### 6. Foreign / unknown nodes
**Loud error.** Construction validates against closed enumerations (`_IR_OPERAND_KINDS`, `_IR_BINOP_OPS`, `_IR_ICMP_PREDS`, `_IR_CAST_OPS` at `ir_types.jl:5-12`); unknown LLVM opcodes rejected by `ir_extract.jl` dispatch; `_lower_inst!` falls through to `MethodError` on unrecognised `IRInst` subtype.

#### 7. Most regrettable design decision
Bit-`width` duplicated on every instruction, with sentinels (`width == 0` for pointer-typed, `width == 1` for booleans). The entire `_narrow_ir` / `_narrow_inst` family in `Bennett.jl:247-287` exists solely to walk every instruction and rewrite its width — any future "i1 boolean is logical, not numeric" rule has to be re-implemented per `_narrow_inst` method (the comment at `Bennett.jl:264-265` admits this).

---

### Feynfeld.jl

**Path:** `/home/tobiasosborne/Projects/Feynfeld.jl`

**Emits/consumes structured values?** No — pure in-process Julia computation library; no JSON/TOML/wire-format code in `src/` or `scripts/`.

#### 1. Value kinds (in-memory only)
- `DimPoly` — polynomial in spacetime dimension D with `Rational{Int}` coefficients.
- `Coeff = Union{Rational{Int}, DimPoly}`.
- `LorentzIndex`, `Momentum`, `MomentumSum` — kinematic atoms.
- `Pair{A,B}` — universal Lorentz bilinear; aliases `MetricTensor`, `FourVector`, `ScalarProduct`.
- `Eps` — 4-index Levi-Civita.
- `AdjointIndex`, `FundIndex`, `SUNT`, `SUNDelta`, `FundDelta`, `SUNF`, `SUND`, `ColourChain` — SU(N) colour algebra.
- `AlgFactor` — closed 6-element union of scalar factor types; `FactorKey` — sorted multiset; `AlgSum = Dict{FactorKey, Coeff}`.
- `DiracSlot` hierarchy, `DiracGamma{S}`, `Spinor{K}`, `DiracChain`, `DiracExpr`.
- `SpinorKind` (`UKind`, `VKind`, `UBarKind`, `VBarKind`).
- `DimSlot` (`Dim4`, `DimD`, `DimDm4`) — BMHV dimension tags.
- `PaVe` integrals (`A0`, `B0`, `B1`, `B00`, `B11`, `C0..D3`).
- `Field{S}`, `GaugeGroup` (`U1`, `SU{N}`), `AbstractModel`, `FeynmanRules`, `VertexRule`.
- qgraf-port IR: `Partition`, `EquivClass`, `FilterSet`, `TopoState`, `FeynmanTopology`, `InternalEdge`, `EdgeMomenta`, `Propagator`, `FermionLine`, `AmplitudeBundle`, `ExternalFactor`.

#### 2. On-wire shape per kind
N/A — never serialised. In-memory canonical struct definitions:
- `DimPoly` — `coeff.jl:6-17`.
- `Coeff = Union{Rational{Int}, DimPoly}` — `coeff.jl:121`.
- `LorentzIndex` — `types.jl:29-33`: `name::Symbol; dim::DimSlot`.
- `Momentum` — `types.jl:41-45`.
- `MomentumSum` — `types.jl:53-59`: `terms::Vector{Tuple{Rational{Int}, Momentum}}`.
- `Pair{A,B}` — `pair.jl:7-19` (constructor canonicalises ordering).
- `FactorKey` — `expr.jl:41-48` (sorted on construction).
- `AlgSum` — `expr.jl:56-58`: `terms::Dict{FactorKey, Coeff}` (no zero-coeff entries).
- `DiracExpr` — `dirac_expr.jl:7-9`: `terms::Vector{Tuple{AlgSum, DiracChain}}`.
- `Propagator` — `qgraf/propagator_assemble.jl:31-40`.

#### 3. Binders
None in the variable-binding sense. Indices are `Symbol`-named atoms with structural `==`/`hash`. Trace dummy indices minted with Julia's `gensym` (`_fresh_adj() = AdjointIndex(gensym(:c))` in `colour_types.jl:122`) — globally-unique fresh names rather than de Bruijn or locally-nameless.

#### 4. Context carriage
Mixed:
- **Dimension** (4 vs D vs D−4): per-value `DimSlot` field on every `LorentzIndex` / `Momentum`.
- **Scalar-product values**: Julia `ScopedValue` (`CURRENT_SP = ScopedValue(SPContext())`, `sp_context.jl:25`).
- **Gauge group / N**: type parameter on the model (`SU{N}`).
- **Model / Feynman rules**: explicit function arguments.
- No global registry.

#### 5. Canonicalisation
Rich **in-memory** canonicalisation; no byte-level since nothing serialised. `MomentumSum` factory combines like terms, drops zeros, sorts. `Pair` constructor sorts arguments. `FactorKey` sorts factors via `_factor_isless`. `AlgSum` invariant: no zero-coefficient entries. `SUNDelta/F/D` sort indices on construction with explicit antisymmetric-permutation `sign::Int`. qgraf canonicality: lex-largest representative per equivalence class.

#### 6. Foreign / unknown nodes
Never thought about it (no IR import path). `AlgFactor` is closed; `DiracSlot` is sealed; unhandled cases error loudly. No pass-through, no opaque-payload hatch.

#### 7. Most regrettable design decision
`AlgFactor = Union{Pair, Eps, SUNDelta, FundDelta, SUNF, SUND}` as a **closed concrete union** (`expr.jl:17`). Every new physics structure (Wilson coefficients, form factors, Goldstone tags, EFT operators, two-loop master integrals) requires editing the union, every dispatch table, the `_factor_type_tag` cascade, and `FactorKey` ordering — and the project's own `src/v2/DESIGN.md:63` already flags it as load-bearing tech debt.

---

### NJOY.jl

**Path:** `/home/tobiasosborne/Projects/NJOY.jl`

**Emits/consumes structured values?** Yes — consumes ENDF-6 80-column text, emits PENDF (ENDF), ACE (Type-1 ASCII for MCNP), and CCCC binary (ISOTXS/MATXS).

#### 1. Value kinds
- ENDF wire records: `MaterialId`, `ContRecord`, `ListRecord`, `Tab1Record`, `Tab2Record`, `InterpolationTable`, `InterpolationLaw` (enum), `TabulatedFunction`.
- Resonance IR: `AbstractResonanceFormalism` → `SLBWParameters`, `MLBWParameters`, `ReichMooreParameters`, `AdlerAdlerParameters`, `SAMMYParameters` (+ `SAMMYParticlePair`, `SAMMYSpinGroup`), `UnresolvedParameters`, parametric `ResonanceRange{P}`.
- Material containers: `IsotopeData`, `MF2Data`, `MF3Section`, `ENDFMaterial`, `PointwiseMaterial`, `CrossSections{T}`.
- Tape IR: `TapeManager`, `PENDFSection`, `PENDFMaterial`, `PENDFTape`, `ENDFTapeSection`, `ENDFTapeMaterial`, `TapeDirectory`.
- ACE IR: `ACEHeader`, `ACETable` (flat NXS/JXS/XSS), `ACENeutronTable` (`ReactionXS`, `EquiprobableBins`, `TabulatedAngular`, `AngularBlock`).
- CCCC binary IR: `Hollerith8`, `ISOTXSFileIdB`, `ISOTXSFileControlB`, `IsotopeControlB`, `PrincipalXSB`, `ScatterSubBlockB`, `IsotopeDataB`, `ISOTXSFileB`; analogous MATXS-B.
- Domain-specific: `KERMAResult`, `SABData`, `BraggData`, `ProbabilityTable`, `MultiGroupXS`, `CovarianceBlock/Matrix/Data`, `WIMSMaterial`, `DTFMaterial`.

#### 2. On-wire shape per kind

**ENDF CONT** (`src/endf/types.jl:43-51`):
```julia
struct ContRecord
    C1::Float64; C2::Float64
    L1::Int32; L2::Int32; N1::Int32; N2::Int32
    id::MaterialId
end
```
80-col layout (`parse_endf_line` at `src/endf/io.jl:92-100`): `p[1..66]` = 6×11-char fields, `p[67:70]`=MAT, `p[71:72]`=MF, `p[73:75]`=MT, `p[76:80]`=NS. Floats use compact ENDF notation `1.234567+8` (no E).

**ACE Type-1 ASCII** (`src/formats/ace_writer.jl:31-72`): printf-driven, `nxs::NTuple{16,Int32}` + `jxs::NTuple{32,Int32}` + `xss::Vector{Float64}` (`src/formats/ace_types.jl:131-149`).

**CCCC binary** (`src/formats/ccccr_b.jl:100-107`): Fortran-style records with leading+trailing length markers, native-endian (B-variant) or `htol` (legacy):
```julia
function _write_cccc_rec_b(io::IO, buf::Vector{UInt8})
    n = Int32(length(buf)); write(io, n); write(io, buf); write(io, n)
end
```
`Hollerith8 = NTuple{8,UInt8}`.

**PENDF tape** (`src/orchestration/types.jl:63-67`): raw 75+ char ENDF lines with sequence numbers regenerated on write:
```julia
struct PENDFSection
    mf::Int; mt::Int
    lines::Vector{String}
end
```

#### 3. Binders
N/A — there are no binders. The closest thing is the closure returned by `build_evaluator(mf2)`, which captures `MF2Data` lexically in Julia.

#### 4. Context carriage
**Per-value field**: ENDF triple `(MAT, MF, MT)` reified as `MaterialId` and embedded in every record (`src/endf/types.jl:30-34, 50, 98, 116, 141`). Material-level context (ZA, AWR, isotope abundance) on `MF2Data`/`IsotopeData`. Per-section nuclear context (Q-values, AWR) on `MF3Section`. Temperature/processing context as explicit function arguments — no global state. ACE bundles temperature/ZAID/AWR into `ACEHeader`.

#### 5. Canonicalisation
**Bit-identity to NJOY2016 Fortran output is canonical.** ENDF floats use exact `a11` 9-sigfig formatting matching `endf.f90:882-981` (`src/endf/io.jl:31-88`). ACE XSS values right-justified `i20`/`1pe20.11`. Sequence numbers regenerated on write. CCCC binary uses Fortran record markers. No JSON/TOML/hash-stable bytes — success metric is "byte-identical MF3 output" against the Fortran reference.

#### 6. Foreign / unknown nodes
**Mixed**: skip-with-`@warn` for unsupported MF2 formalisms (push zeroed `SLBWParameters` placeholder, `src/resonances/reader.jl:121-134`); MF3/MF10/MF12/MF13/MF23 parse failures: `@warn` + skip to SEND. Redundant MTs (1,3,4,18,27,101) tracked separately. URR upper-boundary "shading" nodes silently dropped (`_drop_unsupported_urr_plus_boundary!`). No "unknown node round-trip" — non-MF3 sections preserved only because PENDF is `Vector{String}` raw lines.

#### 7. Most regrettable design decision
Storing PENDF tapes as `Vector{String}` of raw 80-column lines (`src/orchestration/types.jl:63-67`) rather than as a typed AST of CONT/LIST/TAB1/TAB2 records. The decision was forced by bit-identity-to-Fortran, but every module that "modifies" a tape has to do byte-level string surgery and the type system can't catch malformed sections — exactly the bug class the parametric `ResonanceRange{P}` dispatch otherwise eliminates.

---

### TensorGR.jl

**Path:** `/home/tobiasosborne/Projects/TensorGR.jl`

**Emits/consumes structured values?** No — no on-wire serialisation; tensor expressions live as in-memory Julia structs with display going to text/LaTeX/Unicode and an `Expr`-based escape hatch (not bytes).

#### 1. Value kinds (in-memory only)
- `TIndex` — symbolic tensor index (name + Up/Down + vector bundle).
- `Tensor` — named tensor with index slot list (leaf of `TensorExpr`).
- `TProduct` — rational scalar coefficient times factor list.
- `TSum` — sum of `TensorExpr` terms.
- `TDeriv` — index-bearing derivative (∂ or covariant) on a subexpression.
- `TParamDeriv` — parametric derivative, no index.
- `TScalar` — opaque scalar wrapper (`val::Any`).
- Symmetry specs: `Symmetric`, `AntiSymmetric`, `PairSymmetric`, `RiemannSymmetry`, `FullySymmetric`, `FullyAntiSymmetric`.
- Registry: `VBundleProperties`, `ManifoldProperties`, `TensorProperties`, `TensorRegistry`, `RewriteRule`.

#### 2. On-wire shape per kind
N/A — no wire format. In-memory struct definitions:
- `TIndex` — `src/types.jl:11-17`: `name::Symbol; position::IndexPosition; vbundle::Symbol`.
- `Tensor` — `src/types.jl:37-40`: `name::Symbol; indices::Vector{TIndex}`.
- `TProduct` — `src/types.jl:50-53`: `scalar::Rational{Int}; factors::Vector{TensorExpr}`.
- `TSum` — `src/types.jl:63-65`: `terms::Vector{TensorExpr}`.
- `TDeriv` — `src/types.jl:76-80`: `index::TIndex; arg::TensorExpr; covd::Symbol`.
- `TScalar` — `src/types.jl:92-94`: `val::Any`.

Escape hatch reifies these as `Expr(:call, :Tensor, QuoteNode(name), Expr(:vect, …))` (`src/escape_hatch.jl:10-31`).

#### 3. Binders
**Named, with explicit Einstein-summation pairing inferred dynamically.** No formal binder node; dummy indices detected by name+vbundle co-occurrence in `_analyze_indices` (`src/ast/indices.jl:51-95`); α-renaming via `rename_dummy` / `rename_dummies` / `ensure_no_dummy_clash` (`src/ast/indices.jl:143-325`). No de Bruijn, no locally-nameless.

#### 4. Context carriage
Mostly **global / ambient via task-local registry**. `TensorRegistry` (`src/registry.jl:84-110`) holds manifolds, vector bundles, foliations, mappings, per-tensor metadata; `current_registry()` / `with_registry` (`src/registry.jl:343-364`) thread it through a task-local stack. Per-value: only `TIndex.position` (Up/Down) and `TIndex.vbundle` carried; `TDeriv.covd::Symbol` names which connection. Metric, dimension, signature, ring all in registry.

#### 5. Canonicalisation
For *display/equality only*. Index canonicalisation through Butler–Portugal in `src/xperm/` (xperm.c port). Dummy-name hygiene via `same_dummies` rewrites to `:p,:q,:r,…`. `==`/`hash` defined structurally on every `TensorExpr` variant — but rely on `Vector` order, so two algebraically equal expressions with different factor order are unequal until simplified. No sorted-key JSON, no number-as-string, no hash-stable bytes.

#### 6. Foreign / unknown nodes
**Pass-through via `TScalar(val::Any)`** for foreign CAS objects (Symbolics.jl/SymEngine.jl tunnelled through `ext/`); `val::Any` with `isequal`-based equality lets anything ride. For unknown *expression heads*, `from_expr` errors with `"Unknown TensorExpr tag: $tag"` (`src/escape_hatch.jl:63`); `validate` ignores tensors not in registry rather than rejecting them. No tagged-foreign wrapper.

#### 7. Most regrettable design decision
`TScalar.val::Any` (`src/types.jl:93`) — one untyped escape hatch swallows rationals, symbols, Symbolics expressions, SymEngine objects, arbitrary user values indistinguishably. `==`/`hash` depends on `isequal` of opaque objects; future serialisation impossible (no way to know what's inside); breaks Julia method-dispatch optimisations; blocks ever giving the IR a stable wire format.

---

### Lyr.jl

**Path:** `/home/tobiasosborne/Projects/Lyr.jl`

**Emits/consumes structured values?** Yes — pure-Julia OpenVDB binary file format reader/writer.

**Summary.** OpenVDB reader/writer plus Monte Carlo volume renderer (auxiliary GR ray tracing, hydrogen orbitals, scalar-QED scattering modules built on the same VDB grid substrate).

#### 1. Value kinds
- **Scalar voxel types** — `Float32`, `Float64`, `Int32`, `Int64`, `Bool`, `Float16`-stored-as-`Float32`.
- **Vector voxel types** — `NTuple{3, Float32/Float64/Int32}` (`vec3s/f/d/i`).
- **Coord** — Int32 triple (index-space coordinate).
- **BBox** — pair of `Coord`.
- **Tile{T}** — constant-value subregion.
- **LeafNode{T}** — 8x8x8 = 512-voxel dense buffer + active-mask.
- **InternalNode1{T}** / **InternalNode2{T}** — 16³/32³ sparse children/tiles with bitmasks.
- **RootNode{T} / Tree{T}** — hash-mapped Internal2 children + tiles + background.
- **Grid{T,Tr}** — name + `GridClass` enum (`LEVEL_SET`/`FOG_VOLUME`/`STAGGERED`/`UNKNOWN`) + transform + tree.
- **Transforms** — `LinearTransform`, `UniformScaleTransform`.
- **Metadata scalars** — `string`, `int32/64`, `float`, `double`, `bool`, `vec3i/f/s/d`.
- **VDBFile** — `VDBHeader` + heterogeneous grids.
- **Field protocol values** (in-memory only) — `ScalarField3D`, `VectorField3D`, `ComplexScalarField3D`, `ParticleField`, `TimeEvolution`, `BoxDomain`.

#### 2. On-wire shape per kind
**Custom OpenVDB binary, little-endian.**

Scalar voxel `T` (`src/Values.jl:170-179`): raw LE read of `sizeof(T)` bytes; `Bool` is single byte; `Float16` 2-byte widened to `Float32`.
`NTuple{N,T}` voxel (`src/Values.jl:182-190`): N consecutive scalars, no padding.
`Coord` (`src/Coordinates.jl:14-18`): three Int32 LE.
`Tile{T}` wire (`src/FileWrite.jl:315-322`): origin (3×Int32) + value(`sizeof(T)`) + active byte.
`LeafNode{T}` wire: `value_mask` (64 bytes = 512 bits) + 1-byte compression metadata (codes 0–6) + 0–2 inactive values + optional selection mask + size-prefixed compressed/raw active-value buffer (`src/Values.jl:11-98, 119-158`).
`RootNode{T}` wire (`src/FileWrite.jl:301-322`): background + `tile_count` (u32) + `child_count` (u32) + sorted root tiles + sorted Internal2 children.
`Grid{T,Tr}` wire (`src/Grid.jl:34-39, 66-81`): per-grid compression flags (u32) + grid metadata + transform + buffer_count (u32) + background + tree.
`Transform` wire (`src/FileWrite.jl:178-212`): type-tag string ("UniformScaleMap"/"ScaleMap"/"ScaleTranslateMap"/"UniformScaleTranslateMap") + 5×/6× Vec3d redundant scale/inv/voxel-size.
Metadata entry (`src/Metadata.jl:42-95`): `key` (u32 size + bytes) + `type` (u32 size + bytes) + `value` (u32 size + payload, dispatched on type-name string).
`VDBHeader` (`src/Header.jl:22-30, 44-107`): magic `0x56444220` + 4-byte pad + format_version u32 + library_major u32 + library_minor u32 + has_grid_offsets u8 + 36-byte ASCII UUID + per-grid compression bytes.
`GridDescriptor` (`src/GridDescriptor.jl:16-53`): name + grid_type + instance_parent (size-prefixed strings) + 3× Int64 offsets.

#### 3. Binders
N/A — voxel/grid format, not a syntax tree. Closest concept is `Grid.name` + `instance_parent` (string-keyed name reference for instanced grids), a flat namespace.

#### 4. Context carriage
**Per-grid, in dedicated header fields plus a metadata dict.** Value-type token in `GridDescriptor.grid_type` (e.g. `"Tree_float_5_4_3"`, `"Tree_vec3s_5_4_3_HalfFloat"`). Index-to-world coordinate frame in `Grid.transform`. Grid classification in `GridClass` enum derived from `"class"` metadata. Arbitrary user metadata in per-grid `Dict{String,Any}`. Compression context is per-grid for v222+, global-in-header for v220–221. Branching factors `(5,4,3)` baked into the type string.

#### 5. Canonicalisation
**Custom binary, partially canonical.** Numbers as raw native-LE bytes, never strings. Key ordering canonicalised on write only — root tiles and Internal2 children sorted by `(origin.x, origin.y, origin.z)` for "deterministic output" (`src/FileWrite.jl:302-308`). File-level and per-grid metadata `Dict{String,Any}` written **in iteration order** (not key-sorted) — two equivalent grids with different metadata insertion order produce different bytes. UUID preserved verbatim; no content hash.

#### 6. Foreign / unknown nodes
**Mixed.** Unsupported grid value types (`PointDataIndex32`, etc.) cause `parse_value_type` to return `nothing`; parser seeks to `desc.end_offset` and continues with `@warn` (`src/File.jl:79-85, 109-111`). Instanced grids (non-empty `instance_parent`) skipped the same way. Unknown metadata type names: `metadata[key] = nothing` after byte-skipping value (`src/Metadata.jl:88-92`); silently dropped on the write path (`src/FileWrite.jl:120-122`). Magic mismatch throws `InvalidMagicError`. Non-diagonal `LinearTransform` writes throw.

#### 7. Most regrettable design decision
`VDBFile.grids::Vector{Union{Grid{Float32}, Grid{Float64}, Grid{NTuple{3, Float32}}}}` — supported value types baked into a closed `Union` at the top-level container (`src/File.jl:14`) with hand-rolled `if T == ... elseif ...` dispatch in `parse_vdb` (`src/File.jl:100-111`). Every new voxel type requires editing the union, the dispatch ladder, and the writer in lockstep — which is why `Int32`/`Int64`/`Bool`/`Vec3d`/`Vec3i` are decoded by `parse_value_type` but produce `@warn "Skipping grid ... unsupported value type"` at runtime today.

---

### Abstractfeld.jl

**Path:** `/home/tobiasosborne/Projects/Abstractfeld.jl`

**Emits/consumes structured values?** **No source code yet** — repository contains only `PRD.md` and `AGENTS.md`. The PRD *proposes* a unified S-expression IR but nothing has been written. The user mentioned "Alethfeld" in the audit prompt — no project of that name exists; Abstractfeld.jl is the closest "feld"-family project and is currently empty.

---

### Integralis

**Path:** `/home/tobiasosborne/Projects/Integralis`

**Emits/consumes structured values?** Yes — every integral is a record of S-expression-serialised symbolic trees stored in DuckDB.

**Summary.** Universal verified integral database: symbolic integrands/results parsed into a 3-node IR, canonicalised, hashed, fingerprinted, stored with provenance and tiered verification levels (L0 unverified through L4 Lean4-formal).

#### 1. Value kinds
- `Literal` — exact rational number (`Rational{BigInt}`).
- `Sym` — symbolic name (integration var `:_star_`, parameters `:p1..pN`, known constants `:pi`, `:e`, `:im`, `:pinf`, `:ninf`, `:eulergamma`).
- `Call` — operator/function application with op symbol + child vector (`:add`, `:mul`, `:pow`, `:neg`, `:sin`, `:cos`, `:tan`, `:exp`, `:ln`, `:sqrt`, `:abs`, `:asin`..`:acoth`, plus subscripted special-function ops like `:J_nu`).
- `IntegralRecord` — DB envelope.
- `ProvenanceRecord` — source citation envelope.
- `VerificationRecord` — evidence envelope per verification level.

#### 2. On-wire shape per kind
IR types (`src/expression.jl:20-22, 30-32, 45-48`):
```julia
struct Literal <: IntExpr
    val::Rational{BigInt}
end
struct Sym <: IntExpr
    name::Symbol
end
struct Call <: IntExpr
    op::Symbol
    args::Vector{IntExpr}
end
```
Wire format (S-expression strings) — `src/sexpr.jl:14-30`:
```julia
function to_sexpr(e::Literal)
    if isinteger(e.val)
        return "(:lit $(numerator(e.val)))"
    else
        return "(:lit $(numerator(e.val))/$(denominator(e.val)))"
    end
end
to_sexpr(e::Sym) = ":$(e.name)"
function to_sexpr(e::Call)
    parts = [":$(e.op)"]
    for arg in e.args; push!(parts, to_sexpr(arg)); end
    return "(" * join(parts, " ") * ")"
end
```
DB record (`src/db/types.jl:11-28`): `IntegralRecord` with `integrand_canonical::String`, `bound_lower/upper::Union{String,Nothing}`, `result_canonical::String`, `structural_hash::String` (64-char hex), `fingerprint::Union{Vector{Float64},Nothing}` (length 16), `verification_level::Float64`, `tags::Vector{String}`. DuckDB schema (`src/db/schema.jl:4-21`) stores S-expressions as `VARCHAR`, fingerprint as `DOUBLE[]`, hash as `VARCHAR(64)`.

#### 3. Binders
**Named-binder scheme with a single privileged name.** Integration variable rewritten to `:_star_` by `normalize_variables` (`src/canonical.jl:159-162`); parameters get sequential `:p1, :p2, ...` names in DFS first-occurrence order (`canonical.jl:169-179`). No de Bruijn; no explicit binder node — the bound variable is identified by name convention only.

#### 4. Context carriage
**Per-record envelope, not per-value.** Integrand/result S-expressions carry no metric/ring/domain info. The integration variable is encoded by convention (`:_star_`); bounds, original variable name, parameter conditions live in sibling fields on `IntegralRecord` (`src/db/types.jl:11-28`). Coefficient ring is implicit and global: literals always `Rational{BigInt}`. Numerical fingerprint context (8 fixed complex evaluation points, `param_eval_values`) is global.

#### 5. Canonicalisation
**Aggressive multi-stage pipeline.** `src/canonical.jl:32-59` runs `normalize_variables` → fixed-point loop of `simplify` + `canonical_order` + `_renormalize_params_with_map` (cap 100 iters). `canonical_order` (`canonical.jl:607-656`) imposes total order Literal<Sym<Call with lex tiebreak. Hash is SHA-256 of UTF-8 bytes of canonical S-expression (`src/hashing.jl:13-17`). Numbers as `n` or `n/d` ASCII inside `(:lit ...)`. Output is byte-stable but only after pipeline converges.

#### 6. Foreign / unknown nodes
**Pass-through within the IR.** Unknown ops survive as `Call(::Symbol, ::Vector{IntExpr})` — IR has no closed op enum, any symbol is structurally legal. `simplify_node` falls through unrecognised ops untouched (`canonical.jl:492`). At parse time, `_parse_tokens` errors on non-keyword head (`sexpr.jl:90-92`); ingest pipelines raise on unrecognised constructs. So pass-through *within* IR, hard error at parser/ingest boundary.

#### 7. Most regrettable design decision
Encoding the bound integration variable as a distinguished symbol name (`:_star_`) inside the same flat `Sym` namespace as parameters and constants, rather than introducing a binder/`Integral` node. Conflates lexical scope with naming convention; forces every traversal (canonicaliser, simplifier, fingerprinter, equivalence checker) to special-case the symbol; makes nested/multi-variable integrals (and the param-renumber composition bug already documented in `canonical.jl:25-30`) structurally awkward.

---

### QuantumHardware.jl

**Path:** `/home/tobiasosborne/Projects/QuantumHardware.jl`

**Emits/consumes structured values?** Yes — consumes per-device TOML files, parses into typed `Device` struct trees, emits relational DuckDB/SQLite + a `Target{M}` projection for downstream `Sturm.jl`.

#### 1. Value kinds
- `Device` — top-level revision record.
- `DeviceMeta` — id, slug, aliases, schema version, timestamps.
- `Organization` — vendor/lab/consortium with kind enum.
- `DeviceFamily` — name, modality enum, lineage predecessor.
- `DeviceRecord` — status, qubit counts, dates, logical-code info.
- `Topology` — kind enum, reconfigurability, coupling map.
- `NativeGate` — name, arity, kind enum, params, durations, fidelities.
- `FidelityPair`, `NoiseModel` / `T1Block` / `T2Block` / `ReadoutBlock`.
- `CalibrationSnapshot` — longitudinal calibration row.
- `Timing`, `Access`, `EnergyCarbon`, `Roadmap`.
- `Provenance` — field path, source url/kind, retrieval timestamp, SHA-256.
- `AbstractModality` + 18 singleton subtypes (`SCTransmon`, `NeutralAtom`, ...).
- `Target{M<:AbstractModality}` — Sturm-facing projection parametric on modality.
- `Coherence = Union{Nothing, Float64, Vector{Float64}}`.
- `Verdict` — feasibility result.

#### 2. On-wire shape per kind
TOML on input, DuckDB/SQLite rows on output.

`Device` (`src/schema.jl:213-228`):
```julia
struct Device
    meta::DeviceMeta
    organization::Organization
    family::DeviceFamily
    device::DeviceRecord
    topology::Topology
    native_gates::Vector{NativeGate}
    noise_model::NoiseModel
    calibration_snapshots::Vector{CalibrationSnapshot}
    timing::Timing; access::Access
    benchmarks::Union{Nothing, Dict{String, Any}}
    energy_carbon::Union{Nothing, EnergyCarbon}
    roadmap::Union{Nothing, Roadmap}
    provenance::Vector{Provenance}
end
```
`Topology` (`src/schema.jl:97-103`), `NativeGate` (`:110-122`), `Timing`/`Access`/`EnergyCarbon`/`Roadmap`/`Provenance` (`:161-208`).
`Target{M}` (`src/target.jl:41-73`).

DB rows: each table is a `ColumnSpec[]` driving CREATE/INSERT (`src/db.jl:53-58`); free-form fields (`crosstalk`, `position_constraints`, `benchmarks`, `gate.params`, `provenance.value`) flattened via `JSON3.write` into TEXT columns (`src/db.jl:34, 244`). Dates round-trip as ISO 8601 text via `_iso(d::Date) = string(d)` (`src/db.jl:29-30`).

#### 3. Binders
N/A — hardware-spec database; no binders. Symbols (e.g. `:in_service`) are flat enum tags.

#### 4. Context carriage
**Per-record.** A `Device` carries its full context (modality, qubit count, topology, calibration) inline as named fields. Modality additionally lifted into the type system as `Target{M<:AbstractModality}` (`src/target.jl:41`) so Sturm.jl can dispatch on modality directly. Coherence has three explicit shapes via `Coherence = Union{Nothing, Float64, Vector{Float64}}`. Provenance is a parallel `Vector{Provenance}` whose entries name `field_path` strings (e.g. `"native_gates[0].fidelity_mean"`).

#### 5. Canonicalisation
**None at wire level.** TOML parsed by Julia stdlib with no canonical ordering enforced. DB writes ISO 8601 text for dates; free-form fields hit `JSON3.write` with default key order. Determinism only from path-lexicographic sort of TOML files (`src/loader.jl:189-198`) and `sort!(collect(keys(corpus)))` (`src/db.jl:411`); per-record bytes not hash-stable. SHA-256s appear only on original *source* archive bytes (`Provenance.sha256`), not on derived artefacts.

#### 6. Foreign / unknown nodes
**Closed schema.** Top-level JSON Schema declares `"additionalProperties": false` (`schema/device.schema.json:8`); validator hard-fails on missing required sections (`src/validator.jl:73-75`). Enum values outside controlled vocab throw `ValidationError` via `_enum`. **Free-form escape hatches** for known-unknowable structure: `topology.position_constraints`, `noise_model.crosstalk`, `benchmarks`, `native_gates.params` typed `Dict{String,Any}` / `Vector{String}` and stored as JSON text in DB.

#### 7. Most regrettable design decision
Persisting free-form structures (`crosstalk`, `position_constraints`, `benchmarks`, `provenance.value`) as opaque JSON-in-TEXT columns inside the relational DB (`src/db.jl:108, 121, 244`). Quietly punts the hard schema-design question — vendors will keep inventing crosstalk shapes and ad-hoc benchmarks — and locks analytical queries into DuckDB-specific `json_extract` paths, exactly the dialect-coupling the relational layer was supposed to avoid.

---

### fundingscape

**Path:** `/home/tobiasosborne/Projects/fundingscape`

**Emits/consumes structured values?** Yes — ingests grant/call records from JSON (EU F&T, OpenAIRE bulk), CSV (CORDIS, OpenAIRE staging), and YAML (manual entries) into Pydantic models, persists to DuckDB.

**Summary.** Research-funding intelligence pipeline ingesting/normalising ~3.7M grant/call records from 20+ funders into a single DuckDB warehouse for SQL-based quantum-funding analytics.

#### 1. Value kinds
- `Funder` — funding bodies.
- `FundingInstrument` — programme/scheme.
- `Call` — call-for-proposals with deadline, budget, status.
- `GrantAward` — awarded project with PI, institution, funding, dates.
- `EligibilityProfile`.
- `DataSourceStatus` — bookkeeping.
- `Application` (qa) — quantum-advantage problem record.
- `Reference`, `IndustrySector`, `FundingLink` (qa).
- `CacheEntry` — cached HTTP response.
- Enum literals: `FunderType`, `Recurrence`, `DeadlineType`, `CallStatus`, `GrantStatus`, `AdvantageType`, `AdvantageStatus`, `Maturity`.

#### 2. On-wire shape per kind
`Funder` (`src/fundingscape/models.py:19-25`):
```python
class Funder(BaseModel):
    name: str
    short_name: str | None = None
    country: str | None = None
    type: FunderType
    website: str | None = None
    contact: str | None = None
```
`Call` (`models.py:49-67`): includes `budget_total: Decimal | None`, `currency: str = "EUR"`, `deadline: date | None`, `deadline_timezone: str = "Europe/Brussels"`, `raw_data: dict[str, Any] | None = None`.
`GrantAward` (`models.py:70-96`):
```python
class GrantAward(BaseModel):
    instrument_id: int | None = None
    ...
    total_funding: Decimal | None = None
    currency: str = "EUR"
    partners: list[dict[str, Any]] = Field(default_factory=list)
    source: str
    source_id: str
    @field_validator("total_funding", "eu_contribution", mode="before")
    def coerce_decimal(cls, v): return Decimal(str(v))
```
DuckDB persistence (`src/fundingscape/db.py:108-134`): `total_funding DOUBLE`, `partners JSON`, `topic_keywords TEXT[]`. `Call.raw_data` persisted via `json.dumps(call.raw_data)` (`db.py:252`); `partners` via `json.dumps(grant.partners)` (`db.py:273, 299`).
OpenAIRE bulk TSV (`src/fundingscape/sources/openaire_bulk.py:52-60`): tab-delimited columns `source_id, project_title, project_id, ..., keywords, abstract`.
Manual YAML: top-level `calls:` list, each item flat map `id, title, description, url, deadline, status, budget, keywords, programme`.
`CacheEntry` on disk (`cache.py:62-71`): `data_path.write_bytes(entry.body)`; `meta_path.write_text(json.dumps(meta, indent=2))`.

#### 3. Binders
N/A — no IR or AST; flat tabular records (Pydantic + DuckDB rows). No variable scoping, no expressions, no binding.

#### 4. Context carriage
**Per-value fields with implicit defaults:**
- Currency: per-record (`Call.currency`, `GrantAward.currency`), default `"EUR"`.
- Timezone: per-record `deadline_timezone: str = "Europe/Brussels"`.
- Provenance: every record carries `source: str` + `source_id: str`; separate `data_source` table tracks fetch metadata.
- Year (for FX): passed as separate argument to `currency.to_eur(amount, currency, year)` — not stored alongside converted value.
- Schema version: none — DuckDB migrations detected via `information_schema` lookups.

#### 5. Canonicalisation
**None.** Whatever Python/DuckDB happens to produce:
- `Decimal` force-cast to `float` before insert (`db.py:248, 270-271, 296-297`), losing precision.
- `partners` and `raw_data` round-trip via `json.dumps(...)` defaults (no `sort_keys`, no separators).
- Cache metadata uses `json.dumps(meta, indent=2)` — pretty-printed, unsorted.
- Numbers stored as native JSON numbers / DuckDB `DOUBLE`, not strings.
- No hash-stable bytes, no canonical key order, no schema-version tag.

#### 6. Foreign / unknown nodes
**Best-effort pass-through, with truncation and silent drops.** `Call.raw_data: dict[str, Any] | None` preserves entire upstream payload as opaque JSON. `GrantAward.partners` similarly opaque. OpenAIRE bulk extraction silently drops unparseable JSONL lines (`openaire_bulk.py:76-79` — bare `except json.JSONDecodeError: continue`) and untitled records. Text fields silently truncated and tab/newline-stripped before TSV emission (`:151-156`); unknown currencies fall through `to_eur` returning `None`; unrecognised currency strings treated as EUR.

#### 7. Most regrettable design decision
Demoting all monetary amounts from `Decimal` to native `DOUBLE` at the DB boundary (`db.py:248, 270-271, 296-297`) while keeping `Decimal` in the Pydantic layer. The asymmetry means every read-back loses precision and the `coerce_decimal` validator (`models.py:91-96`) is purely cosmetic — any future audit or reconciliation against funder records will hit float-rounding noise the schema was supposedly designed to prevent.

---

### vibefeld

**Path:** `/home/tobiasosborne/Projects/vibefeld`

**Emits/consumes structured values?** Yes — serialises proof-tree nodes, challenges, and an event-sourced ledger to JSON files (one event per `NNNNNN.json`).

**Summary.** Go CLI (`af`) for adversarial natural-language mathematical proof construction; AI prover/verifier agents build a hierarchical proof tree backed by an append-only event-sourced ledger of JSON event files.

#### 1. Value kinds
- **NodeID** — hierarchical dotted-integer id (`"1"`, `"1.2.3"`).
- **Timestamp** — RFC3339Nano UTC instant.
- **Node** — proof step (claim/local_assume/local_discharge/case/qed).
- **Challenge** — verifier's objection.
- **Definition**, **Assumption**, **External**, **Lemma**.
- **Event** — one of ~30 ledger event variants (NodeCreated, ChallengeRaised, NodeValidated, NodeAdmitted, NodeRefuted, NodeArchived, TaintRecomputed, ScopeOpened/Closed, OutlineSet, ClaimTested, DefChecked, ...).
- Embedded record kinds: **OutlineStage**, **Evidence**, **Hint**, **ClaimTestResult**, **DefCheckResult**, **FailedApproach**, **ProposedStrategy**, **FailurePattern**.
- Enums: `NodeType`, `InferenceType`, `WorkflowState`, `EpistemicState`, `TaintState`, `ChallengeStatus`, `ChallengeTarget`, severity (`critical|major|minor|note`).

#### 2. On-wire shape per kind
Wire = Go-`encoding/json`-marshalled JSON, one event per file (filename `%06d.json` per `internal/ledger/filename.go:16-18`).

`NodeID` (`internal/types/id.go:212-214`):
```go
func (n NodeID) MarshalJSON() ([]byte, error) {
    return json.Marshal(n.String())
}
```
`Timestamp` (`internal/types/time.go:70-75`):
```go
func (ts Timestamp) MarshalJSON() ([]byte, error) {
    s := ts.t.Format(time.RFC3339Nano)
    return json.Marshal(s)
}
```
`Node` (`internal/node/node.go:28-81`):
```go
type Node struct {
    ID types.NodeID `json:"id"`
    Type schema.NodeType `json:"type"`
    Statement string `json:"statement"`
    Latex string `json:"latex,omitempty"`
    Inference schema.InferenceType `json:"inference"`
    Context []string `json:"context,omitempty"`
    Dependencies []types.NodeID `json:"dependencies,omitempty"`
    ValidationDeps []types.NodeID `json:"validation_deps,omitempty"`
    WorkflowState schema.WorkflowState `json:"workflow_state"`
    EpistemicState schema.EpistemicState `json:"epistemic_state"`
    TaintState TaintState `json:"taint_state"`
    ContentHash string `json:"content_hash"`
    Created types.Timestamp `json:"created"`
    ...
}
```
`Event` envelope (`internal/ledger/event.go:60-64`):
```go
type BaseEvent struct {
    EventType EventType       `json:"type"`
    EventTime types.Timestamp `json:"timestamp"`
}
```
Marshal call (`internal/ledger/append.go:94`): `data, err := json.Marshal(event)`. Enums are plain JSON strings.

#### 3. Binders
N/A — proof IR is a **natural-language tree of strings** (`Statement string` field); quantifiers, variables, bindings live inside opaque strings and are never parsed. Closest thing to scoping is `local_assume` / `local_discharge` node types tracked imperatively by `internal/scope/Tracker` keyed by NodeID.

#### 4. Context carriage
**Per-node, by NodeID reference.** Each `Node` carries `Context []string` (string IDs pointing at definitions/assumptions/externals stored separately in `State`), `Dependencies []NodeID`, `ValidationDeps []NodeID`, `Scope []string`. Dereferenced records (Definition, Assumption, External, Lemma) live in maps on `State` (`internal/state/state.go:148-160`), reconstructed by replaying global ledger. No metric/ring/dimension/basis — vibefeld is not a math-value system.

#### 5. Canonicalisation
**Mostly none on wire.** `json.Marshal(event)` (`internal/ledger/append.go:94`) emits whatever order Go's reflect-walk produces (struct-field declaration order; `omitempty` drops zero values). No sort, no indent. **Exception**: per-Node **content hash** (`internal/node/node.go:165-218`) builds a hand-written canonical string with sorted `Context`, sorted `Dependencies`, sorted `ValidationDeps`, pipe-delimited fields, then SHA256s it. Render package separately uses `enc.SetEscapeHTML(false)` (`internal/render/json.go:22-35`) for human-facing output. Numbers as raw JSON numbers (no string-wrapping). Sequence ordering on disk from zero-padded filename, not in-file content.

#### 6. Foreign / unknown nodes
**Strict reject.** `internal/state/replay.go:135-150` defines an `eventFactories` registry keyed by known `EventType` strings; unknown type returns `"failed to parse event N: ..."` and aborts whole replay (`replay.go:48-55`). No pass-through, no quarantine. Ledger files bounded to 1 MB (`read.go:15-18`, `ErrEventTooLarge`); invalid JSON rejected. Sequence gaps/duplicates also abort replay.

#### 7. Most regrettable design decision
`Node.Statement` is an **opaque natural-language string** with no structured AST, no parser, no normal form — proof content is never machine-inspected, only diffed, hashed, and shown to LLMs. Enables the "adversarial LLM dance" pitch but means every downstream feature (taint propagation, validation deps, content hashing, export, claim-testing) reaches around the string instead of through it; future migration to any structured logic kernel would invalidate every persisted proof in the ledger.

---

### FQHE

**Path:** `/home/tobiasosborne/Projects/FQHE`

**Emits/consumes structured values?** No on-wire IR for physics — self-contained Julia numerical pipeline emitting CSV plot data and PDF/PNG figures only.

**Summary.** Julia 1.10+ package builds the FQHE transport plot for a GaAs 2DEG: Haldane-sphere LLL exact diagonalisation + cylinder DMRG (ITensors) for gaps, composite-fermion scaling, Dykhne–Ruzin semicircle transport.

#### 1. Value kinds (in-memory only)
- `FockBasis` — many-body Fock basis: `UInt64` bitstrings at fixed (N, 2S, 2Lz).
- Bitstring Fock state — single `UInt64`.
- Pseudopotentials `VJ::Vector{Float64}` (sphere) / V_m (cylinder).
- Two-body matrix-element table `Vmat::Dict{NTuple{4,Int},Float64}`.
- Sparse Hamiltonian `Hermitian{SparseMatrixCSC{Float64}}`.
- ITensors `MPO` + `Vector{Index}` site-set; DMRG returns `MPS` ground/excited state.
- `GapTable` — per-fraction gap record.
- `FractionData` — `(ν::Rational{Int}, gap_dimless::Float64)`.
- `MaterialParams` / `PhysicalConstants`.
- Filling fraction — `Rational{Int}` throughout.
- Transport result — `(R_xy, R_xx)` plain `Vector{Float64}`.
- Proof ledger JSON files under `proof/{ledger,externals,...}/*.json` (audit, not IR).

#### 2. On-wire shape per kind
Essentially no wire format. In-memory shapes:
- `FockBasis` (`src/hilbert_space.jl:19-26`): `N::Int; n_orb::Int; twoS::Int; states::Vector{UInt64}; target_twoLz::Int; state_to_index::Dict{UInt64,Int}`.
- `GapTable` (`src/exact_diag.jl:95-101`).
- `FractionData` (`src/transport.jl:27-30`).
- ITensors MPO emission (`src/dmrg_hamiltonian.jl:80-94`): `ampo += V, "Cdag", a+1, "Cdag", b+1, "C", d+1, "C", c+1`.
- Experimental data ingest (`scripts/04_make_plot.jl:144`): `readdlm(path, ',', skipstart=1)`.
- Proof ledger entry: opaque-to-physics JSON (`{"type":"node_created", ...}`).

#### 3. Binders
N/A — no symbolic binders. Fermionic creation/annihilation as positional ITensors `OpSum` strings; orbital indices are integers, not bound names.

#### 4. Context carriage
**Per-value field plus a process-global `const`.** `FockBasis` carries `N, n_orb, twoS, target_twoLz` directly. Fillings as `Rational{Int}` everywhere. Geometry **implicit by which function you call** (`sphere_*` vs `cylinder_*`). Material/fundamental constants: `const CONSTANTS = PhysicalConstants(...)` and `const GaAs = MaterialParams(...)` (`src/materials.jl:22,42`).

#### 5. Canonicalisation
N/A — no serialised value protocol. Raw `Float64` (with `BigInt` only inside binomial pseudopotential computation); pruning thresholds (`1e-15`, `1e-12`) are not canonicalisation. CSV output is `DelimitedFiles.readdlm` defaults.

#### 6. Foreign / unknown nodes
**Never thought about it** — closed-world. Out-of-regime inputs are loud errors: `sphere_flux` errors on non-integer `2S`; `shift(ν)` errors on `ν=1/2` and even-denominator fractions; `enumerate_fock_states` errors on `n_orb > 64` (UInt64 cap); `cf_gap_scaling` errors on `p < 1`. No pass-through, no tagged-foreign, no silent drop.

#### 7. Most regrettable design decision
Encoding Fock states as a single `UInt64` bitstring (`src/hilbert_space.jl:19,35`). Fast and elegant up to 64 orbitals, but hard-caps the sphere to `twoS ≤ 63` and the cylinder MPO to `Nphi ≤ 64` with explicit `error("n_orb=$n_orb > 64: need UInt128 (not implemented)")` — exactly the regime where larger-N extrapolations would close the gap to the published 0.1036 e²/εℓ_B reference.

---

## §2. Cross-project disagreement matrix

**Note**: "in-memory only" projects (Bennett, Feynfeld, TensorGR, FQHE)
trivially disagree with on-wire projects on axes 2 and 5 — included for
completeness but the disagreement is structural, not a design choice.

### Axis 1 — Value-kind taxonomy size

| Position | Projects |
|---|---|
| Tiny IR core (≤ 5 kinds) | Integralis (3: Lit/Sym/Call) |
| Small (5–15) | TensorGR (7 expr + 6 symmetry), Lyr (~15), FQHE (~10), fundingscape (~10) |
| Medium (15–25) | Sturm (~25), Bennett (~22), QuantumHardware (~22), vibefeld (~15 record + ~30 events) |
| Large (>25) | Feynfeld (~40), NJOY (~30+) |

### Axis 2 — Wire format

| Position | Projects |
|---|---|
| None (in-memory only) | Bennett.jl, Feynfeld.jl, TensorGR.jl, FQHE |
| Custom binary, little-endian | Lyr.jl (OpenVDB), NJOY.jl (CCCC binary, B-variant native-endian / legacy `htol`) |
| Fixed-column ASCII | NJOY.jl (ENDF 80-col, ACE Type-1) |
| Hand-rolled JSON / NDJSON | Sturm.jl |
| Library-default JSON | vibefeld (Go `encoding/json`), fundingscape (Pydantic + `json.dumps`) |
| S-expression strings inside SQL | Integralis (DuckDB `VARCHAR`) |
| TOML in / DuckDB out | QuantumHardware.jl |
| OpenQASM 3 text | Sturm.jl (secondary) |

### Axis 3 — Binders

| Position | Projects |
|---|---|
| No binder concept at all | Sturm, Bennett (flat SSA), NJOY, Lyr, vibefeld, fundingscape, QuantumHardware, FQHE |
| Named, gensym-fresh dummies | Feynfeld (`gensym(:c)` for trace dummies) |
| Named, ad-hoc α-rename, no node | TensorGR (`rename_dummy*`, indices detected by name+vbundle co-occurrence) |
| Named, single privileged sentinel | Integralis (`:_star_`) |
| Opaque (binders inside an opaque string) | vibefeld (binders live in NL `Statement` string) |
| de Bruijn / locally-nameless | none |
| Explicit binder node | none |

### Axis 4 — Context carriage

| Position | Projects |
|---|---|
| Per-value field on every node | NJOY (`MaterialId` triple on every record), QuantumHardware (every section inline on `Device`), fundingscape (currency/source per record), Bennett (bit-`width` duplicated per instruction), Integralis (envelope around expr) |
| Type parameter / Julia type system | Sturm (`QInt{W}`, `QMod{d,K}`, `Channel{In,Out}`), Feynfeld (`Field{S}`, `SU{N}`, `DimSlot` per index), Lyr (value-type baked into `grid_type` string) |
| Global / task-local store | TensorGR (TLS `TensorRegistry`), Sturm (task-local backend via `@context`), Feynfeld (`ScopedValue` for SP table), FQHE (process-`const GaAs`, `CONSTANTS`) |
| Per-grid header dict | Lyr.jl |
| Implicit by which function called | FQHE (`sphere_*` vs `cylinder_*`) |
| By NodeID reference into a separate map | vibefeld (Context/Dependencies are NodeID lists; records live in replayed `State`) |
| Mixed exceptions | Sturm (`QCoset.modulus` is a runtime field, breaking the type-param rule); Feynfeld (per-value DimSlot + global ScopedValue + type-param `SU{N}` simultaneously) |

### Axis 5 — Canonicalisation

| Position | Projects |
|---|---|
| N/A — never serialised | Bennett, Feynfeld, TensorGR, FQHE |
| Library defaults / insertion order | fundingscape (`json.dumps`, no sort), QuantumHardware (TOML stdlib + `JSON3.write`), Sturm (hand-rolled JSON, dict iteration order), vibefeld (Go reflect-walk, struct-field declaration order) |
| Partial — sort on write only, metadata in iteration order | Lyr.jl (root tiles + Internal2 sorted by origin; metadata dict is not key-sorted) |
| Bit-identity to upstream Fortran | NJOY.jl |
| Multi-stage simplifier → SHA-256 of canonical S-expression | Integralis |
| Hand-built canonical string for content hash, but raw JSON for the ledger | vibefeld (split: per-Node content hash is canonical; ledger bytes are not) |
| Numbers as raw JSON numbers | Sturm, vibefeld, fundingscape, QuantumHardware (free-form fields) |
| Numbers as decimal strings | Integralis (inside `(:lit n/d)`) |
| Numbers as native binary bytes | Lyr (LE), NJOY (B-variant native, legacy `htol`) |

### Axis 6 — Foreign / unknown nodes

| Position | Projects |
|---|---|
| Hard error / closed-world | Sturm (`Channel` rejects non-`HotNode`), Bennett (closed enums + `MethodError`), Feynfeld (closed `AlgFactor` union), QuantumHardware (`additionalProperties: false`), FQHE (errors on out-of-regime), vibefeld (unknown `EventType` aborts replay) |
| Pass-through inside the IR | Integralis (any `Call(::Symbol, ...)` legal), TensorGR (`TScalar.val::Any` swallows arbitrary objects) |
| Skip-with-`@warn` + zero placeholder | NJOY (unsupported MF2 formalism: zeroed `SLBWParameters` placeholder) |
| Skip-with-`@warn` + offset advance | Lyr (unsupported grid types, instanced grids) |
| Silent drop | NJOY (URR upper-boundary), Lyr (unknown metadata types on write), fundingscape (unparseable JSONL, untitled records) |
| Truncate-and-continue | fundingscape (text fields) |
| Tagged-foreign envelope | none |

### Axis 7 — Most regrettable decision (one per project)

| Project | Regret |
|---|---|
| Sturm.jl | `QCoset.modulus` is a runtime field while every other dimension lives in the type parameter |
| Bennett.jl | bit-`width` duplicated on every instruction (with sentinel values) |
| Feynfeld.jl | `AlgFactor` is a closed concrete union of 6 types |
| NJOY.jl | PENDF tape stored as `Vector{String}` raw lines, not typed AST |
| TensorGR.jl | `TScalar.val::Any` is one untyped escape hatch for everything |
| FQHE | Fock state encoded as single `UInt64` (caps `n_orb` at 64) |
| Lyr.jl | `VDBFile.grids::Vector{Union{Grid{Float32}, Grid{Float64}, Grid{NTuple{3, Float32}}}}` — closed `Union` of supported voxel types at top-level container |
| Integralis | bound integration variable encoded as the sentinel symbol `:_star_` rather than an explicit binder node |
| QuantumHardware.jl | free-form structures (`crosstalk`, `position_constraints`, `benchmarks`, `provenance.value`) persisted as opaque JSON-in-TEXT inside the relational DB |
| fundingscape | `Decimal` force-cast to `DOUBLE` at the DB boundary while keeping `Decimal` in Pydantic (asymmetric precision loss) |
| vibefeld | `Node.Statement` is an opaque natural-language string with no AST, parser, or normal form |
| Abstractfeld.jl | N/A — no source code yet (PRD only) |

---

## §3. What this means for sci-wb

The user asked: if we wanted to break **all** of these tools into sci-wb
microservice tools, what is the path forward, and where would sci-wb come
under tension most? The honest answer is that **some of these projects fit
sci-wb's substrate naturally, some force sci-wb to grow new protocol
features, and some are category errors**. This section says which is which
and why.

### 3.1 Sci-wb's load-bearing assumptions, named

A microservice tool in sci-wb is currently:

1. A **pure function** from a JSON value to a JSON value, running in
   milliseconds with cold-start <100ms.
2. Operating on a **closed value algebra of 10 kinds** (`canonical.ts`),
   with **no raw numbers** and **no `null`**.
3. Producing **canonical bytes** (sorted keys, no whitespace) that hash
   stably to a content address.
4. Honouring **foreign-pass-through**: subterms outside scope round-trip
   verbatim or wrap in `tagged "<name>/<class>"`.
5. Declaring its **shape via `Schema`** (ADR-0004), validated by the runner
   before/after `fn`.
6. Recording **provenance** in `$CAS_STORE/provenance/<hh>/<hash>.json`.

Each of these is load-bearing. Each is at risk under one or more
absorption candidates.

### 3.2 Tier classification

**Tier 1 — natural extension. Already works.**

| Project | Why it fits |
|---|---|
| Sturm.jl IR | Already partially absorbed (`sturm-ir`, `sturm-execute`, `sturm-simplify`, `sturm-equivalent`, `sturm-sample`, `sturm-controlled`, `sturm-then`, `sturm-tensor`). Closed `HotNode` union is exactly sci-wb's "fail loud on unknown node." `WireID` is `integer`. The `QCoset.modulus`-as-runtime regret *naturally resolves itself* in sci-wb form (everything becomes a record field, no type parameters). |
| Integralis IR | Lit/Sym/Call → sci-wb `integer`/`symbol`/`expression`. Hash is already SHA-256 of canonical bytes — that's exactly sci-wb's discipline. The S-expression string layer can be deleted; sci-wb canonical JSON does the same job. The `:_star_` regret is fixed by introducing the binder kind discussed below. |
| Bennett reversible circuits | Gates and wires are records; `IRBinOp`/`IRICmp`/etc. map to record-with-tag. The bit-`width` regret survives if sci-wb just copies the duplication, but at least the duplication is uniform. |
| Feynfeld kinematic algebra (without Dirac) | `Pair`, `MomentumSum`, `AlgSum` map cleanly to record + sorted-keys; `FactorKey` becomes a sorted list. `gensym`-fresh dummies don't survive — would need replacing with a deterministic naming scheme or, better, a binder kind. |

These 4 absorptions don't force sci-wb to change. They validate the
substrate and immediately ~10x its tool surface. The work is straight
porting plus property-test mutation-proof.

**Tier 2 — forces a sci-wb design decision.**

| Project | What it forces |
|---|---|
| TensorGR.jl | A **binder kind** (named α-rename is fragile under canonicalisation; locally-nameless is the natural fit). A **context-carrier value** distinct from "input" — manifold/metric/dimension belong neither inside the tensor nor as flag arguments; they're a *separate first-class value*. The `TScalar.val::Any` regret cannot be ported as-is; it must be a `tagged "tensor/foreign-scalar"` envelope. |
| NJOY result tools | "Compute reaction rate from ENDF point data" works fine. **PENDF tape round-trip** does not — sci-wb canonicalisation (sorted keys, no whitespace) is incompatible with bit-identity to NJOY2016 ASCII output. Two honest options: (a) sci-wb `njoy-*` tools take pre-parsed values and produce values, while a separate non-sci-wb wrapper does the bit-identity Fortran-output dance; (b) wrap PENDF tapes as `tagged "njoy/pendf"` opaque-string payloads, giving up structural manipulation. There is no third option. |
| QuantumHardware target lookup | Sci-wb tool that takes a device id → returns a `record { modality, qubit_count, native_gates, ... }` is a clean fit. Sci-wb tool that *builds the database* is not — it's a multi-source ingest pipeline with side effects. |

Tier 2 is where the next ADR pressure lives. The binder + context-carrier
question is the most interesting because it's load-bearing for Integralis
(remove `:_star_`), TensorGR (Einstein summation), and any future
lambda-calculus, type-theory, or proof-term tool. **Pick the binder
protocol once; pay forever.**

**Tier 3 — fundamental mismatch. Not sci-wb tools.**

| Project | Why it doesn't fit |
|---|---|
| Lyr.jl voxel grids | A 100MB Float32 voxel buffer encoded as `{kind:"float64", bits:"..."}` per voxel multiplies storage by ~8× and CPU by more (per-voxel canonicalisation). Sci-wb's "no raw numbers" rule is correct *for symbolic* values; it is **a category error for bulk numerical artefacts**. Lyr should be a *consumer* of sci-wb tools (e.g. `cas-simplify` on a transform parameter), not a resident. |
| fundingscape warehouse | A 3.7M-record DuckDB warehouse is not a JSON value. Even the *index* into it is a database. Sci-wb's tool model — "JSON in, JSON out, milliseconds, cold-start <100ms" — is the wrong substrate. The right shape is: sci-wb tools that operate on a *single record* (canonicalise, validate, hash for dedup); a separate ingest/warehouse component holds the corpus. The boundary is the record. |
| vibefeld event-sourced ledger | Not a pure function: replay is a state machine with 30+ event variants, where the "value" is the materialised `State` after replay. Sci-wb tools that operate on a single proof node, definition, or challenge are fine; the ledger itself is not a sci-wb concern. |
| FQHE numerical pipeline | A multi-stage compute job (basis enumeration → sparse Hamiltonian → ED/DMRG → transport) where the intermediates are gigabytes of `Float64`. Each stage *could* be a tool if its input/output were small symbolic descriptors, but the actual numerical state belongs in HDF5 or similar — not in canonical JSON. |

Trying to absorb Tier 3 is what would put sci-wb under tension most. The
specific failure modes:

- **Protocol bloat**: a `blob` kind to hold opaque binary, breaking the
  "10 kinds" closure; a `database-handle` kind, breaking pure-function
  semantics; a `stream` kind, breaking single-value-on-stdin.
- **Discipline erosion**: once sci-wb has an opaque-blob kind, every tool
  author defaults to it for "convenience," and foreign-pass-through
  becomes a polite suggestion.
- **Performance lies**: cold-start <100ms only holds if the values are
  small. Validating a 100MB record against a schema isn't fast even for
  Bun.
- **Determinism erosion**: ingest tools that consume external HTTP
  endpoints or filesystems-with-mutation are *not deterministic given
  bytes*. fundingscape's whole point is "what's the current state of the
  world's grant calls" — that's an inherently non-deterministic concern.

### 3.3 Where sci-wb comes under tension most, ranked

1. **Volumetric / bulk-numerical data (Lyr, FQHE intermediates).** The
   "no raw numbers" rule is the bright line. Either it bends, in which
   case sci-wb stops being canonical-symbolic and becomes "yet another
   serialisation library," or it holds, in which case bulk numerics are
   simply out of scope. The audit suggests it should hold.

2. **Persistent-state systems (fundingscape, vibefeld, QuantumHardware
   warehouse).** Sci-wb has no notion of a long-lived process with state.
   Adding one — ingestion daemons, query servers, replayed ledgers — is
   a substrate change, not a feature. The current model (value in,
   value out, no shared state) is what makes provenance and content
   addressing work.

3. **Binder protocol absence (Integralis, TensorGR, future lambda
   tools).** Sci-wb has no `lambda` / `bound-name` value. Integralis's
   `:_star_` regret and TensorGR's ad-hoc α-rename are both *symptoms of
   the same missing primitive*. This is the most interesting tension
   because it's resolvable: pick locally-nameless (deterministic α-equivalence
   by bytes, no shift-on-substitution pain), commit it as an ADR, and
   most of the other "name-management" pain in those projects evaporates.

4. **Context-carrier kind (TensorGR, Sturm `QCoset.modulus`, NJOY
   temperature, Feynfeld dimension/SP).** Right now context is either
   per-value (NJOY's `MaterialId` on every record) or "type parameter"
   (Sturm's `QInt{W}`, which doesn't survive serialisation). Sci-wb
   currently fudges this — `cas-*` tools assume Q[x] uniformly; `mod-*`
   tools take `modulus` as an input field. If the next iteration wants
   to handle "the *same* expression has different meanings under
   different metrics/rings," the design needs an explicit context value
   that travels alongside the input. This may want a new ADR.

5. **Bit-identity-to-upstream constraints (NJOY).** A tool that has to
   produce *byte-equal* output to an external reference cannot also
   produce sci-wb-canonical bytes. These are mutually exclusive. NJOY
   is the only project in the audit with this constraint, but if the
   user wants to absorb it the choice is permanent.

6. **Ingest from non-deterministic sources (fundingscape).** Sci-wb's
   only crack at non-determinism is `entropy-source` (ADR-0005). HTTP
   fetches, file-system scrapes, time-of-day are *worse* than
   randomness — they're observably stateful. The pattern that works is:
   non-deterministic ingest writes content-addressed bytes; downstream
   sci-wb tools consume the bytes deterministically. fundingscape's
   `CacheEntry` is already shaped this way. But the ingest itself is
   not a sci-wb tool — it's a producer of input.

### 3.4 Concrete path forward, if the user wants one

**If the goal is "make sci-wb the symbolic substrate for the user's
research stack":**

A. **Tier 1 absorptions next**, ordered by leverage:
   1. Integralis IR → sci-wb tools (`int-parse`, `int-simplify`,
      `int-canonical`, `int-fingerprint`, `int-equal`). Closes the
      `:_star_` regret if A.4 lands.
   2. Sturm.jl algorithm-IR (BlockEncoding, QSVTPhases) → sci-wb tools.
      The substrate is already there.
   3. Bennett oracle as `tools/sturm-bennett-oracle` (already a
      `bd ready` issue).
   4. **Decide the binder protocol** (locally-nameless recommended; ADR).
      This unblocks integration tools, lambda-calculus tools, and
      tensor-calculus tools.
A doesn't grow the protocol; it grows tool count.

B. **Tier 2 needs design pressure first**:
   - Context-carrier kind: write an ADR that decides whether ring/metric/
     basis is (i) a sibling input, (ii) a wrapping `record { context, value }`,
     or (iii) a global flag like `--ring=Q[i]`. The TensorGR port is the
     forcing function.
   - Foreign-scalar / foreign-payload envelope: a uniform ADR for "I have
     an opaque object I cannot inspect" beyond the current `tagged
     "<tool>/out-of-scope"` (which is *named per-tool*; the foreign-payload
     kind is *generic*). TensorGR's `TScalar.val::Any` regret is the test.

C. **Tier 3 stays out** unless the user is prepared to redesign the
   substrate. Specifically:
   - Bulk numerical artefacts (Lyr, FQHE intermediates) should be
     content-addressed *outside* sci-wb (HDF5 / OpenVDB files), with
     sci-wb only seeing the hash + small descriptors.
   - Warehouses and ledgers (fundingscape, vibefeld) should be
     *consumers* of sci-wb tools, not residents. The boundary is the
     individual record / event, not the corpus.

**If the goal is "everything in one universal protocol":**

Don't. The audit makes the case directly: of the 12 projects, 4 are
in-memory-only with no wire format at all (their authors haven't paid
the canonicalisation cost yet); 4 use library-default JSON with no
canonicalisation discipline; 1 uses Fortran ASCII for upstream
bit-identity; 1 uses custom binary for volumetric data. **Forcing them
all into one protocol means losing the property each was optimising
for.** Sci-wb's discipline is what makes it useful for symbolic-
computation tools; that discipline is not free, and projects that
weren't paying it had reasons.

The honest answer is: sci-wb is the **right substrate for the symbolic
core**, and a forcing-function for surfacing protocol regrets in the
adjacent projects (Integralis's `:_star_`, TensorGR's `TScalar`,
Sturm's `QCoset.modulus`). Use it for that. Resist the universal-
protocol temptation.

### 3.5 Open ADR-shaped questions surfaced by this audit

These are the design decisions the next iteration of sci-wb would have
to make. None is decided here.

1. **ADR-NN: Binder protocol.** Locally-nameless, de Bruijn, named-with-
   α-rename, or "no binders, ever." Forced by Integralis; relevant to
   TensorGR, future integration / lambda / proof-term tools.
2. **ADR-NN: Context-carrier kind.** How does ring / metric / basis
   travel with a value? Sibling input, wrapping record, global flag, or
   "implicit per-tool"? Forced by TensorGR; relevant to Sturm
   (`QCoset.modulus`), `cas-*` (currently Q[x] only), `mod-*`.
3. **ADR-NN: Generic foreign-payload kind.** Today every tool wraps its
   own out-of-scope subterm in a per-tool `tagged "<tool>/<class>"`. Is
   there a generic `tagged "foreign/<source>"` envelope for opaque
   objects from outside sci-wb? Forced by TensorGR `TScalar`; relevant
   to any tool that wants to interop with foreign CAS systems.
4. **ADR-NN: Externalised bulk numerics.** Should sci-wb formalise the
   pattern "small descriptor in canonical JSON + content-addressed
   blob in external store"? If yes, what is the descriptor shape, and
   how does provenance handle the blob hash? Forced by Lyr; relevant to
   FQHE intermediates, NJOY ACE/CCCC, any future PDE solver.
5. **ADR-NN: Long-lived ingest tools.** Can sci-wb formalise a *category*
   of tool that has side effects (HTTP fetch, filesystem read), separate
   from the deterministic-pure default? If yes, what's the manifest
   marker (analogous to `nondeterministic: true` for `entropy-source`)
   and what guarantees does it give up? Forced by fundingscape;
   relevant to any data-corpus producer.

Each is independently scoped. None should be blocked on the others.

---

## §4. Prediction check, elegant moments, and the path to v0.3

Before writing the audit, the user predicted four specific patterns the
audit would surface, plus a trap to watch for. This section checks each
prediction against the evidence, flags the places where one project
solved a problem more elegantly than another, and maps the findings to
the three-part v0.3 PRD update the user proposed (promoted kinds,
implicitly-resolved questions, surviving open questions).

### 4.1 Prediction check

**P1 — "You'll find that you already invented something close to
`tagged` in at least three projects, under different names."**

**Confirmed in four projects, under four different names.** Each is a
discriminated union with a string/symbol tag and a per-variant payload:

| Project | Tag field | Payload |
|---|---|---|
| vibefeld | `BaseEvent.EventType EventType` (string) | per-variant struct, `eventFactories` registry decodes (`internal/ledger/event.go:60-64`, `internal/state/replay.go:135-150`) |
| Sturm.jl | `ProtocolOp.verb::Symbol` | `fields::Dict{String,Any}` (`src/hardware/protocol.jl:26`) |
| Integralis | `Call.op::Symbol` | `args::Vector{IntExpr}` with **open** op set (`src/expression.jl:45-48`) |
| NJOY.jl | `ResonanceRange{P<:AbstractResonanceFormalism}` (Julia type-parameter as compile-time tag) | `parameters::P` (`src/resonances/types.jl:280-290`) |

The pattern is recurrent enough that it confirms `tagged` belongs in
MVP (it does, per PRD §2.2 #10). The standardised name is `tagged`.
Each project's name (`verb`, `EventType`, `op`, type-parameter) is a
local accommodation, not a competing primitive.

**P2 — "At least two projects disagree on whether numbers go on the
wire as strings or as JSON numbers. Whichever one you regret, that's
the canonical form."**

**Confirmed.** Three positions across the audit:
- **JSON numbers**: Sturm.jl, vibefeld, fundingscape, QuantumHardware
- **Decimal strings**: Integralis (inside `(:lit n/d)`)
- **Native binary bytes**: Lyr.jl (LE), NJOY.jl (B-variant native, legacy `htol`)

The regret evidence is unambiguous. **Of the four projects that wrote
JSON numbers, fundingscape's regret is exactly this**: `Decimal` is
force-cast to `DOUBLE` at the DB boundary (`db.py:248,270-271,
296-297`), every read-back loses precision, and the `coerce_decimal`
validator (`models.py:91-96`) is purely cosmetic. **Integralis, the
one project that chose decimal strings, did not regret it** — its
regret was the `:_star_` binder sentinel.

The signal points to **decimal strings as the canonical form**, which
is what sci-wb already chose (PRD §2.4: "all numerics live inside
`integer`, `rational`, `float64` whose number-bearing fields are
strings"). Past evidence validates the existing rule.

**P3 — "Binders are handled inconsistently or absent. None of the
projects forced you to handle binders properly."**

**Confirmed strongly.** From axis 3:

| Approach | Projects | Status |
|---|---|---|
| No binder concept at all | 8 (Sturm, Bennett, NJOY, Lyr, vibefeld, fundingscape, QuantumHardware, FQHE) | inadequate for any future tool that binds |
| Named, gensym-fresh dummies | 1 (Feynfeld, `gensym(:c)`) | **breaks determinism — incompatible with sci-wb** |
| Named, ad-hoc α-rename, no node | 1 (TensorGR, `rename_dummy*`) | fragile under canonicalisation |
| Named, single privileged sentinel | 1 (Integralis, `:_star_`) | **already regretted** by author |
| Opaque (binders inside an opaque string) | 1 (vibefeld, NL `Statement`) | not a binder protocol |
| de Bruijn / locally-nameless / explicit binder node | **0** | no past evidence |

This is the genuinely-open question, exactly as predicted. Past code
does not resolve it because nothing forced past-Tobias to. PRD §2.2's
recommendation (locally-nameless) is unrefuted by the audit but also
unconfirmed; it remains a deliberate decision waiting for the first
binder-using tool to force it.

**P4 — "You'll probably find one or two kinds that appear in multiple
projects but aren't in the §2.2 nine-kind MVP. Candidates: string,
vector/tensor, interval/approximate. 3+ projects = promote; 1 = leave
as tagged."**

`string` is already in MVP (#10) and is universal across the audited
projects. The question is the other two candidates plus anything else.

Surveying the audit:

| Candidate kind | Projects using it | Verdict |
|---|---|---|
| `datetime` / `timestamp` | vibefeld (`RFC3339Nano Timestamp`), QuantumHardware (ISO 8601 dates), fundingscape (deadlines, fiscal years) | **3 projects → earns promotion by the rule.** Not encodable as a number without losing timezone/precision; not encodable as a string without losing structural validation. |
| `interval` / `approximate` (number with uncertainty) | QuantumHardware (`fidelity_mean` + std), NJOY (covariance blocks), FQHE (`gap_extrap` with extrapolation error) | 3 projects, but **all encodable as `record { value, error }` without a new primitive**. Borderline. |
| Fixed-length numerical tuple (vec3, NXS NTuple{16,Int32}) | Lyr.jl (vec3), NJOY.jl (NXS/JXS), QuantumHardware (coupling pairs) | 3 projects, but **`list` already covers it**; `S.tuple([...])` in the schema language already pins fixed length. No new value kind needed. |
| Bulk-numerical blob (voxel buffer, ACE XSS, DMRG state) | Lyr.jl (voxels), NJOY.jl (ACE, CCCC), FQHE (HDF5 proposed) | 3 projects, **and §3 argued this is Tier 3 (category error)**. The 3-project rule says promote; the substrate analysis says don't. **Genuine tension** — see §4.4. |
| Symbolic indexed object | TensorGR (Tensor with named indices), Feynfeld (FourVector via Pair, MomentumSum), Integralis (`:_star_`-bound integrals) | 3 projects use it, **and PRD §2.2 already lists `indexed` as deferred**. The audit confirms the deferral was correct. |
| Symbolic polynomial | cas-core (sci-wb internal), Feynfeld (DimPoly in spacetime dimension D) | 2 projects, **already deferred as `polynomial`**. |
| Operator-string (non-commutative product) | Sturm (PauliTerm, PauliHamiltonian), Feynfeld (DiracChain) | 2 projects, **already deferred as `operator-string`**. Audit confirms the deferral was correct. |
| Algebraic number | cas-core (recently shipped), Integralis (could use it for closed-form constants) | 1-2 projects, **already deferred as `algebraic`**, partially built in cas-core. |

So the 3-project rule promotes:
- **`datetime`** unambiguously — three projects independently chose it
  as a first-class value, none encoding it as a number-of-seconds.
- **`interval`** marginally — three projects need it but all could
  fall back on `record`.
- **bulk-blob descriptor** uncomfortably — three projects need it but
  promoting it crosses the substrate line that §3 argued should hold.

The deferred-kind list (`algebraic`, `indexed`, `operator-string`,
`polynomial`) is *exactly the set* the audit independently surfaces.
That's strong validation of PRD §2.2's deferred slate.

**P5 — "The trap: Claude Code will be eager to declare convergence."**

Acknowledged. The places where one project solved a problem **more
elegantly than another** are flagged in §4.2 below, including a
pointed callout where past-Tobias's audit-doc author (me, in §3 of this
document) was probably *too eager* to dismiss the bulk-blob question.

### 4.2 Where one IR solved a problem more elegantly than another

The user explicitly asked for these. They are the per-axis "best of"
the audit — not as a recommendation, but as evidence about what works.

**On extension / pass-through.**

- **Integralis's open `Call(::Symbol, ::Vector{IntExpr})`** preserves
  the *structure* of unknown ops while letting the symbol carry an
  unrecognised tag (`canonical.jl:492` falls through unrecognised ops
  untouched). You can still see "this is a `Call` with op `:foo`," walk
  its args, hash it. **Compare TensorGR's `TScalar.val::Any`**, which
  loses structure entirely (`src/types.jl:92-94`) — equality falls
  back on `isequal` of opaque Julia objects, future serialisation is
  blocked, and the IR can't tell you what kind of foreign thing it's
  carrying. The lesson: pass-through should preserve enough structure
  to inspect, not just opaque-ride.

**On context carriage.**

- **NJOY's per-record `MaterialId` triple** is verbose but unambiguous
  (`src/endf/types.jl:30-34`). Every record self-describes its `(MAT,
  MF, MT)` location. **Compare TensorGR's TLS `TensorRegistry`**
  (`src/registry.jl:343-364`), which is invisible context that
  silently breaks if you forget `with_registry`. NJOY's choice survives
  serialisation; TensorGR's does not. The lesson confirms PRD §2.2's
  recommendation: per-value context > ambient context, even at the
  cost of verbosity.

**On canonicalisation.**

- **Integralis's full pipeline** — canonicalise (multi-stage simplifier)
  → SHA-256 of canonical S-expression → fingerprint (length-16 Float64
  at 8 fixed complex points) → DuckDB lookup
  (`src/canonical.jl:32-59`, `src/hashing.jl:13-17`,
  `src/fingerprint.jl:8-46`) — is **the cleanest end-to-end discipline
  in the audit**, and matches sci-wb's intent step-for-step except for
  the **fingerprint**. The fingerprint catches structural near-duplicates
  that don't byte-equal (different parameterisations, different argument
  orderings before convergence). Sci-wb has nothing equivalent. Worth
  noting for any future cas-equivalence tool.

- **vibefeld's per-Node `ContentHash`** (`internal/node/node.go:165-218`)
  is the *opposite* lesson: a hand-canonicalised SHA-256 over a careful
  pipe-delimited string with sorted Context/Dependencies/ValidationDeps
  — but the *surrounding* ledger JSON is uncanonicalised reflect-walk
  output (`append.go:94`). Half-measures on canonicalisation are visible:
  the per-Node hash is byte-stable, the ledger as a whole is not. Sci-wb's
  all-or-nothing rule is harder to comply with but doesn't leave you
  with this asymmetry.

**On opaque references.**

- **Sturm's `WireID = struct { id::UInt32 }`** (`src/types/wire.jl:7`)
  is a globally-unique counter, no scoping required, opaque
  bytes-of-content irrelevant. **Compare Bennett's `Symbol` SSA names**
  (`src/ir_types.jl:223-236`), which require manual global-uniqueness
  discipline within `ParsedIR` and are not enforceable at the type
  level. Sturm's pattern is what sci-wb would do: opaque integer
  identity, no name-collision worry.

**On compile-time tag dispatch (in-memory only).**

- **NJOY's `ResonanceRange{P<:AbstractResonanceFormalism}`** and
  **QuantumHardware's `Target{M<:AbstractModality}`** both lift the tag
  into Julia type parameters so dispatch resolves at compile time. This
  is elegant in-memory. **It does not survive serialisation.** Sci-wb's
  runtime `tagged { tag, payload }` is the wire-survivable equivalent;
  the elegance loss is real (no compile-time dispatch on the consumer
  side) but the wire-survivability gain is the whole point.

**Where §3 was probably too eager.**

§3's Tier-3 dismissal of bulk numerics (Lyr voxel grids, NJOY ACE
arrays, FQHE intermediates) deserves harder thought. The 3-project
rule says these earn a kind. **A `blob-by-hash` descriptor — small
canonical-JSON metadata pointing to content-addressed bytes in an
external store — is probably the right shape**, and it doesn't break
the canonical-text invariant (the blob hash is just a string; the
bytes live elsewhere, indexed by hash). This is exactly the pattern
fundingscape's `CacheEntry` (`cache.py:62-71`) and QuantumHardware's
`Provenance.sha256` already use *for source bytes*. Generalising it to
*derived* artefacts is a smaller move than I implied. Not a decision —
but a question §3 should not have closed off so cleanly.

### 4.3 Implicit resolutions, surfaced by the audit

These are open questions that **past code has already implicitly
answered**, where the evidence is consistent enough to retire the
question.

1. **Numbers on the wire as strings, not JSON numbers.** Past evidence:
   one regret in the JSON-number school (fundingscape DOUBLE precision
   loss); zero regrets in the decimal-string school (Integralis). The
   PRD §2.4 rule is validated by past evidence; close the question.

2. **Tagged-extension belongs in MVP, named `tagged`.** Past evidence:
   four projects independently invented the discriminated-union pattern
   under different names. The pattern is irreducible. PRD §2.2 #10 is
   correct.

3. **Foreign-pass-through is the right invariant for any tool with
   scope.** Past evidence: where projects DIDN'T have it (Sturm
   closed-world, Bennett closed enums, Feynfeld closed `AlgFactor`,
   FQHE error-on-out-of-regime), composition required pre-flattening;
   where they DID have it (TensorGR `TScalar`, Integralis open `Call`),
   the IR composes. PRD §2.3 is validated.

4. **Context belongs per-value, not in ambient global state.** Past
   evidence: NJOY's `MaterialId` works; TensorGR's TLS registry is a
   regret-in-waiting (silently breaks); FQHE's `const GaAs` global
   prevents reuse across materials. PRD §2.2's open recommendation
   (a) is validated.

### 4.4 Genuinely surviving open questions

These questions are not implicitly answered by past code. They need
deliberate decisions.

1. **Binder protocol** (PRD §2.2 carries forward). No past project has
   a working binder discipline. Recommendation unchanged: locally-
   nameless. Decide before the first binder-using tool ships.
   Forces: Integralis port (`:_star_` removal), TensorGR port
   (Einstein summation), any future integration / lambda /
   proof-term tool.

2. **Promote `datetime`?** Three projects independently chose it as
   first-class. PRD §2.2 doesn't list it. Either promote (and decide
   wire shape: ISO 8601 string with timezone? two-part `record { date,
   tz }`?) or commit to "encode as string and lose validation." Forces:
   QuantumHardware port, fundingscape port, vibefeld-shaped audit
   trails for sci-wb tools.

3. **Promote `interval` / `approximate`?** Three projects need it,
   all could fall back on `record { value, error }`. The question is
   whether sci-wb wants quantitative-uncertainty as a *primitive*
   (with arithmetic that propagates intervals) or as a *convention*
   (record-shaped, with each tool implementing propagation). Forces:
   any tool that consumes experimental data with error bars.

4. **Promote a `blob-by-hash` descriptor kind?** Three projects need
   bulk numerics. §3 argued no; §4.2 acknowledged §3 was probably too
   eager. The question survives: is sci-wb the substrate for *only*
   the symbolic core, or does it want a content-addressed-bytes story
   for derived artefacts too? Forces: any port of Lyr / NJOY ACE
   tables / FQHE intermediates.

5. **Long-lived ingest tools?** PRD doesn't address tools with side
   effects (HTTP, filesystem, timestamps). `entropy-source` is the one
   designated non-deterministic tool (ADR-0005). fundingscape and
   QuantumHardware-warehouse-build push for a category. Open: do
   these become sci-wb tools at all, or do they remain *producers* of
   sci-wb input? §3 argues the latter; the question is whether that
   stays the answer.

### 4.5 The v0.3 PRD path, sketched

If — *and only if* — the user has sat with the disagreement table for
long enough, the natural v0.3 §2.2 update is:

**(a) Promoted from deferred / new in MVP**:
- `datetime` (3-project rule, irreducible to existing kinds without
  validation loss)

**(b) Confirmed deferred**:
- `algebraic` (cas-core has it; PRD's deferral was correct)
- `indexed` (TensorGR forces it; PRD's deferral was correct)
- `operator-string` (Sturm Pauli would use it; PRD's deferral was correct)
- `polynomial` (cas-core has it; PRD's deferral was correct)

**(c) Open questions resolved by past evidence (close)**:
- Numbers as decimal strings (validated by fundingscape regret)
- `tagged` standardisation (validated by 4 independent reinventions)
- Per-value context over ambient (validated by NJOY vs TensorGR)
- Foreign-pass-through is the right invariant (validated by closed-
  world projects' composition pain)

**(d) Open questions surviving**:
- Binder protocol (carried, locally-nameless still recommended)
- Context-carrier shape for `indexed`/`polynomial` (PRD §2.2 (a)
  recommendation validated; needs concrete shape)
- `interval` promotion (3-project candidate, marginal)
- `blob-by-hash` descriptor promotion (3-project candidate; substrate
  question)
- Long-lived ingest tools (whole category open)

**This sketch is not a v0.3 PRD draft.** It is the shape one would
have. Whether to promote `datetime`, `interval`, or `blob-by-hash`
depends on which tools the user wants to absorb next, and that's a
prioritisation decision the audit cannot make.

The user's note stands: don't act on first synthesis. The disagreement
table is most useful when read for a day, not consumed in one sitting.
What §4 produces is an artefact, not a plan.

---

## Pointers

- Per-project source paths in §1.
- `PRD-v0.2.md` — sci-wb's design canonical. §2.2 is the section v0.3
  would update; §2.4 is what the canonicalisation prediction validated.
- `docs/adr/` — existing ADRs, especially 0001 (subprocess), 0003 (output
  categories), 0004 (Schema as type), 0005 (externalised entropy),
  0006 (Sturm IR as value), 0008 (cas-core ring-generic).
- `docs/sturm-ts/spec-v3.md` — the most recent absorption case study;
  shows what a Tier 1 absorption looks like end-to-end.
- This document supersedes any earlier informal ecosystem-mapping notes;
  it is a snapshot in time and will need re-running if the audited
  projects change shape.
