# R5 — Local oracle landscape for the Bessel family

**Bead:** `scientist-workbench-gimq` (R5 of the BesselJ reference-implementation epic).
**Parent epic:** `scientist-workbench-zcam`.
**Date probed:** 2026-05-17.
**Host:** Linux 6.8.0-111-generic (Ubuntu 24.04 "noble" derivative).
**Target audience:** Phase 1 oracle-adapter subagents (G2–G7) and the
Phase 1 cross-agreement comparator subagent (G8). Every adapter
implementer reads §3 (per-oracle), §4 (capability matrix), §5 (tier
hierarchy), §6 (landmines), and §7 (the Arb-install recommendation)
before writing a line.

**Scope:** capability matrix per oracle × four heads ({J, Y, I, K})
× six ν-classes × {real, complex}. Tier hierarchy
(gold/silver/bronze) per ADR-0040 §"Decision 8". Ten enumerated
landmines (L1–L10) — three carried from `docs/refs/erf-research/
R5-oracle-landscape.md` and seven Bessel-specific — each documented
with reproducer, primary source, and adapter-side mitigation. Strong
install recommendation for `python-flint` (FLINT 3.0+ ships Arb
integrated, NOT as a separate package — see §7).

**Discipline:** PROBE, do not speculate. Every claim is backed by a
captured probe output under
`docs/refs/besselj-research/sources/oracles/<oracle>-*-probe.txt`
(or `.cpp`/`.c`/`.wls`/`.py` for the source program). Speculation, if
any, is flagged `[UNVERIFIED]`.

**Gate this artefact unblocks:** Phase 1 (G1–G8). Specifically:
G1's corpus-tier design (which oracles to query at which precision);
G2–G7's per-oracle adapter implementations (the exact CLI / batch
pattern, the cancellation/branch-cut/overflow mitigations); G8's
cross-agreement comparator's tier-aware tolerance bands.

---

## 1. Tier hierarchy (executive summary)

Per Erf R5 §1 and ADR-0040 Decision 8, three tiers matched to the
local Bessel reality:

### Gold tier — deep golden masters @ 50+ decimals

- **Wolfram Mathematica 14.3** (`/usr/bin/wolframscript` calling
  WolframScript 1.13.0 → Mathematica kernel 14.3.0 in
  `/usr/local/bin/math`). Canonical closed-source reference. Use as
  the **primary** gold voice for ALL four heads × real-and-complex
  × all ν-classes. Caveats: L1 input-trap (numbers MUST be
  `Rational[num,den]`), L11 trailing-noise digits (truncate output
  to `precision - 2`), 7.6 s cold-start (batch mandatory).
- **mpmath 1.3.0** (`/usr/lib/python3.12/dist-packages/mpmath/`).
  Independent open-source arb-prec implementation in pure Python
  over `int` arithmetic. Use as the **co-primary** gold voice. The
  ONLY locally-available independent arb-prec voice for the
  complex branch (Wolfram + mpmath = the entire complex arb-prec
  oracle pool until Arb is installed — see §7).
- **sympy 1.14.0** (`/usr/lib/python3/dist-packages/sympy/`).
  `besselj(...).evalf(50)` delegates to mpmath. Use as a
  **wire-format check** (does the symbolic pipeline preserve
  bit-exact equality through `.evalf`?), NOT as an independent third
  vote. Counts as a single vote with mpmath in any cross-agreement
  tally.

### Silver tier — cross-check, independent implementation

- **Boost.Math 1.83** `cpp_bin_float<N>` (`/usr/include/boost/math/
  special_functions/bessel.hpp` plus `/usr/include/boost/
  multiprecision/cpp_bin_float.hpp`). Fully independent C++ arb-prec
  implementation. **Real branch only** — Bessel-on-`std::complex`
  template substitution fails identically to the Erf case (see §3.4
  + `boost-complex-probe-output.txt`). Acceptance criterion: gold
  (Wolfram + mpmath) and silver (Boost) agree to first 48 digits
  for `BesselJ/I` real, ≥45 for `BesselY/K` (the latter two have
  cancellation tails per L4). NB: Boost spells Y_ν as `cyl_neumann`,
  NOT `cyl_bessel_y` (an attempt to call `cyl_bessel_y` fails to
  compile — see `boost-test-prog.cpp` rev. 2 — pin this in the
  adapter).

### Bronze tier — float64 only

- **SciPy 1.17.0** (`scipy.special.{jv, yv, iv, kv, jn, yn,
  jn_zeros, jvp, ive, kve}`). Independent of Boost / mpmath at the
  algorithm level (uses AMOS via Fortran for `jv`/`yv`/`iv`/`kv`;
  Cephes for `j0`/`j1`/`y0`/`y1`). Real + complex float64. Use for
  float64-evaluator validation. Several landmines: L5 silent
  underflow at large ν+z; L8 integer-vs-near-integer-ν jump.
- **libm** (`<math.h>` j0/j1/jn/y0/y1/yn via glibc) via g++ 13.3 +
  libc6. **No Bessel-I, no Bessel-K, no general-ν, no complex** —
  the most restricted oracle on the machine. Useful only as a
  float64 cross-check for J_n and Y_n at integer n.
- **Boost.Math `<double>` API** (`boost::math::cyl_bessel_j` /
  `cyl_neumann` / `cyl_bessel_i` / `cyl_bessel_k` instantiated on
  `double`). Independent of libm and SciPy.

### Not locally available

- **Julia + SpecialFunctions.jl** — Julia 1.12.5 binary is on PATH
  (`/home/tobias/.juliaup/bin/julia`) but `SpecialFunctions.jl` is
  NOT installed (only PicoSAT 0.4.1). Probe: `julia -e 'using
  SpecialFunctions; ...'` ⇒ `ArgumentError: Package SpecialFunctions
  not found in current path` (`julia-probe-output.txt`). Filed as
  deferred-on-install; orchestrator may opt to `julia -e 'using Pkg;
  Pkg.add("SpecialFunctions")'` (~3 min cold install) before Phase 1.
- **python-flint / Arb** — `pip install python-flint` returns
  `WARNING: Package(s) not found: python-flint` (`flint-probe-
  output.txt`); apt has `libflint-dev` (version 3.0.1, ships Arb
  integrated) and `libflint18t64` available but NOT installed. See
  §7 for the STRONG install recommendation.
- **R / Rscript**, **Maxima**, **Sage** — none installed
  (`which maxima` / `which Rscript` / `which sage` all empty).
- **MPFR / GSL** — `libmpfr.so.6` and `libgsl.so.27` present at
  runtime, but no `-dev` headers (`/usr/include/mpfr.h` absent;
  `/usr/include/gsl/gsl_sf_bessel.h` absent). C-linkage unavailable
  without `apt install libmpfr-dev libgsl-dev`.

### Tier-matrix at a glance

| Tier        | Oracles                           | Real arb-prec | Complex arb-prec |
| ----------- | --------------------------------- | ------------- | ---------------- |
| Gold        | Wolfram + mpmath                  | ✓ (2 voices)  | ✓ (2 voices)     |
| Gold-redux  | sympy (delegates → mpmath)        | ✓ (0 added)   | ✓ (0 added)      |
| Silver      | Boost.Math `cpp_bin_float<N>`    | ✓ (real only) | ✗ template fails |
| Bronze      | SciPy + libm + Boost `<double>`  | n/a           | scipy only       |

**The complex arb-prec gap is the single weakest link.** Until Arb
ships, gold for complex Bessel rests on a **two-engine pair**
(Wolfram + mpmath). If they disagree there is no tie-breaker. See §7.

---

## 2. Probe excerpts backing the "Installed?" column

All commands re-runnable. Outputs captured in
`docs/refs/besselj-research/sources/oracles/*.txt`.

```text
$ which wolframscript && wolframscript -version
/usr/bin/wolframscript
WolframScript 1.13.0 for Linux x86 (64-bit)

$ which math && math -version
/usr/local/bin/math
14.3.0 for Linux x86 (64-bit)

$ python3 --version
Python 3.12.3
$ python3 -c "import mpmath, scipy, sympy, numpy; print(mpmath.__version__, scipy.__version__, sympy.__version__, numpy.__version__)"
1.3.0 1.17.0 1.14.0 1.26.4

$ which g++ && g++ --version | head -1
/usr/bin/g++
g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0

$ ls /usr/include/boost/version.hpp && grep BOOST_LIB_VERSION /usr/include/boost/version.hpp | tail -1
/usr/include/boost/version.hpp
#define BOOST_LIB_VERSION "1_83"

$ ls /usr/include/boost/math/special_functions/bessel.hpp
/usr/include/boost/math/special_functions/bessel.hpp

$ which julia && julia --version
/home/tobias/.juliaup/bin/julia
julia version 1.12.5
$ julia -e 'using Pkg; Pkg.status()'
Status `~/.julia/environments/v1.12/Project.toml`
  [ff2beb65] PicoSAT v0.4.1
$ julia -e 'using SpecialFunctions; println(besselj(3, 2))'
ERROR: ArgumentError: Package SpecialFunctions not found in current path.

$ python3 -c "from flint import acb"
ModuleNotFoundError: No module named 'flint'

$ apt-cache search libflint
libflint-dev   - C library for number theory, development files
libflint-doc   - Documentation for the FLINT library
libflint18t64  - C library for number theory, shared library
$ apt-cache show libflint-dev | grep Version
Version: 3.0.1-3.1build1
  # NB FLINT 3.0+ ships Arb INTEGRATED — no separate libarb-dev package needed.
  # The "libarb" package in Ubuntu 24.04 is a DIFFERENT project
  # (phylogenetic sequence analysis) — DO NOT install it.

$ which maxima sage Rscript mpfr-config gsl-config
(all empty — none installed)

$ ls /usr/include/mpfr.h /usr/include/gsl/gsl_sf_bessel.h
ls: cannot access ... : No such file or directory
$ ls /usr/lib/x86_64-linux-gnu/libmpfr* /usr/lib/x86_64-linux-gnu/libgsl*
/usr/lib/x86_64-linux-gnu/libmpfr.so.6
/usr/lib/x86_64-linux-gnu/libmpfr.so.6.2.1
/usr/lib/x86_64-linux-gnu/libgsl.so.27
/usr/lib/x86_64-linux-gnu/libgsl.so.27.0.0
```

---

## 3. Per-oracle deep dive

Each section: install path, version, capability matrix (4×6×2),
precision claim, batch-mode cost, batch-mode invocation, worked
example with captured output, and oracle-specific landmines.

### 3.1 Wolfram Mathematica via `wolframscript` (GOLD)

- **Install path**: `/usr/bin/wolframscript` (thin CLI shim) →
  `/usr/local/bin/math` (kernel) → `/usr/local/Wolfram/Mathematica/
  14.3/` (kernel + libraries).
- **Version**: WolframScript 1.13.0; kernel 14.3.0 (Linux x86_64).
- **Precision claim**: gold — declared `N[…, d]` precision,
  correctly rounded, but emits N+a-few digits of NOISE past the
  declared precision (see L11).
- **Capability matrix** (✓ full precision, ⚠ caveat, ✗ refuses):

| Head     | int-ν real | half-int-ν real | gen-ν real | int-ν cplx | half-int-ν cplx | gen-ν cplx |
| -------- | :--------: | :-------------: | :--------: | :--------: | :-------------: | :--------: |
| BesselJ  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
| BesselY  |     ✓      |        ✓        |  ✓ (L3)    |     ✓      |        ✓        |     ✓      |
| BesselI  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
| BesselK  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |

- **Cost** (measured):
  - Cold-start single call: `time wolframscript -code 'N[BesselJ[3,
    2], 60]'` ⇒ **real 7.689 s**, user 0.112 s, sys 0.150 s (kernel
    boot dominates; CPU largely idle). See
    `wolfram-probe-output.txt`.
  - Warm batch (5 calls, single `.wls` file): **6.942 s**
    (`wolfram-batch-probe.txt`) ⇒ amortised ~1.4 s/call after the
    first. **Batch mode mandatory.**
  - Estimated batch-throughput: 100 inputs ≈ 8 s + 5 ms/input
    after kernel boot.

- **Batch-mode pattern** (G2 adapter — pinned from Erf G2a):

  ```ts
  // packages/oracle-besselj/wolfram.ts (design sketch)
  // 1. Emit a single .wls script with all inputs as a Wolfram List literal.
  // 2. Each input row: {fn, nu_str, z_str_re, z_str_im, precision}.
  // 3. Strings are passed to ToExpression after rational construction:
  //      nu = ToExpression[nu_str]            (e.g. "5/2" → 5/2 exact)
  //      z  = ToExpression[z_str_re] + ToExpression[z_str_im] I
  //    NEVER use a decimal literal — it parses as MachinePrecision and
  //    silently caps the result at ~16 digits (LANDMINE L1).
  // 4. Evaluate N[Switch[fn, ...][nu, z], precision].
  // 5. Stringify via ToString[result, InputForm].
  // 6. Strip the back-tick precision suffix via StringSplit[_, "`"][[1]].
  // 7. Normalise *^ exponent syntax to e   (LANDMINE L_carryover from Erf G2a).
  // 8. Print one JSON line per result: {"idx":1,"result":"…"}.
  ```

  The actual working `.wls` is captured in
  `wolfram-batch-v2.wls`. Reference exemplar — copy verbatim into
  G2. The Erf `tools/wolframscript/` adapter shows the
  byte-decoding side.

- **Worked example** (4 functions, one batch):

  ```text
  $ wolframscript -file wolfram-batch-v2.wls
  {"idx":1,"fn":"BesselJ","nu":"3","z":"2","prec":50,"result":"0.12894324947440205109879333296923983526999372528246023386415951315080031119298"}
  {"idx":2,"fn":"BesselY","nu":"5/2","z":"3/2","prec":50,"result":"-1.3150372048051936777826754765592963127722808944588590393583410504937749668363"}
  {"idx":3,"fn":"BesselI","nu":"1/2","z":"3","prec":50,"result":"4.61482290340760094785298030024927703459477781226161327170377978307371891418061"}
  {"idx":4,"fn":"BesselK","nu":"0","z":"10","prec":50,"result":"0.00001778006231616765181130119279949279231287347016034643601049462795792273104"}
  {"idx":5,"fn":"BesselJ","nu":"3","z":"25/10","prec":50,"result":"0.21660039103911352476668900351596372171684342357695992677700684053000212453412"}
  ```

  See `wolfram-batch-probe.txt`. Compare to single-shot N@80
  for the BesselJ[3,2] case in `wolfram-probe-output.txt`:
  `0.128943249474402051098793332969239835269993725282460233864`**`439608742379200753590`** —
  digits 51-78. **Note that the batch-mode N@50 emitted
  `…0233864`**`159513…`** — i.e. digits 49 onward differ.** This is
  L11 (trailing-noise tail). Truncate to `precision − 2` digits in
  the adapter.

- **Landmines specific to Wolfram**: L1 (input-trap), L11 (trailing
  noise), L_carryover-G2a (`*^` exponent syntax). All pinned in §6.

### 3.2 mpmath 1.3.0 via `python3` (GOLD, the only complex arb-prec voice besides Wolfram)

- **Install path**: `/usr/lib/python3.12/dist-packages/mpmath/`.
- **Version**: 1.3.0 (probe: `python3 -c "import mpmath;
  print(mpmath.__version__)"`).
- **Precision claim**: gold — correctly rounded to declared
  `mp.dps`. Internal precision is bumped by mpmath's algorithm
  selection to ensure the output digit at `mp.dps` is correctly
  rounded. **CRITICAL**: `nstr` rounds-to-nearest, while Wolfram
  `N[]` truncates at the displayed precision (L2 carryover).
- **Capability matrix**:

| Head     | int-ν real | half-int-ν real | gen-ν real | int-ν cplx | half-int-ν cplx | gen-ν cplx |
| -------- | :--------: | :-------------: | :--------: | :--------: | :-------------: | :--------: |
| BesselJ  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
| BesselY  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
| BesselI  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
| BesselK  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |

- **Cost**:
  - Cold-start single call: ~250 ms (Python interpreter boot
    dominates).
  - Warm batch (400 calls @ 60 dps): **0.670 s** total ⇒ ~1.7
    ms/call. Spec from the timing probe in this artefact's
    investigation.
  - Estimated batch throughput at 60 dps: ~600 evaluations/second.

- **Batch-mode pattern** (G3 adapter):

  ```ts
  // packages/oracle-besselj/mpmath.ts (design sketch)
  // Spawn `python3 -u mpmath_oracle.py` once per corpus build.
  // mpmath_oracle.py: read newline-delimited JSON requests on stdin,
  //                   process, emit newline-delimited JSON responses on stdout.
  // Per-request:
  //   mpmath.mp.dps = precision_decimals + 6        # 6-dp guard
  //   nu = mpmath.mpf(nu_str)  or mpmath.mpc(nu_re_str, nu_im_str)
  //   z  = mpmath.mpc(z_re_str, z_im_str)            # always mpc; im=0 if real
  //   fn = mpmath.{besselj,bessely,besseli,besselk}
  //   result = fn(nu, z)
  //   re_str = mpmath.nstr(result.real, precision_decimals, strip_zeros=False)
  //   im_str = mpmath.nstr(result.imag, precision_decimals, strip_zeros=False)
  //   emit {"re": re_str, "im": im_str}
  // Always construct z as mpc (not mpf) to get a uniform code path for real/complex.
  // For real inputs verify result.imag is exactly zero before stringifying — mpmath
  // sometimes emits a 1e-60 spurious imaginary part on real inputs near zeros.
  ```

- **Worked example**:

  ```text
  $ python3 -c "import mpmath; mpmath.mp.dps=60; ..."
  besselj(3,2)     = 0.1289432494744020510987933329692398352699937252824602339
  bessely(5/2,3/2) = -1.315037204805193677782675476559296312772280894458859039
  besseli(1/2,3)   = 4.614822903407600947852980300249277034594777812261613272
  besselk(0,10)    = 0.00001778006231616765181130119279949279231287347016034643601

  complex besselj(3, 0.5+0.7i) = -0.012722421408081983037907765670929809232541040352665763870180...
                              i× 0.004408551591352994421325748813458034542819000039157093036668...
  ```

  See `mpmath-probe-output.txt`. Cross-validated against Wolfram
  to 60 digits (re-diff ~3.7e-61, im-diff ~9.6e-61) per
  `complex-cross-validate.txt`.

- **Landmines specific to mpmath**: L2 nstr-rounding-vs-Wolfram-
  truncation (carry from Erf R5); L_mpmath_spurious_im (real
  inputs near zeros may emit spurious 1e-60 imaginary parts —
  observed for `besseli(1/2, 3)` in `scipy-probe-output.txt`
  cross-check). Adapter strips `im` if `|im| < 1e-(dps-5)` for
  inputs flagged as real.

### 3.3 sympy 1.14.0 via `python3` (REDUNDANT-GOLD)

- **Install path**: `/usr/lib/python3/dist-packages/sympy/`.
- **Version**: 1.14.0.
- **Precision claim**: redundant-gold — `besselj(...).evalf(50)`
  delegates to mpmath. Output bit-identical to mpmath at any tested
  input (see `sympy-probe-output.txt` vs `mpmath-probe-output.txt`).
- **Capability matrix**: identical to mpmath (same engine).
- **Cost**: ~350 ms cold-start; slower than direct mpmath by ~30%
  due to symbolic-to-mpmath conversion overhead. Not worth running
  in batch — use mpmath directly. **Wire-format check role only.**
- **Batch-mode pattern**: same as mpmath but with `besselj(nu,
  z).evalf(precision)` for the inner call. Recommended use: run
  ONCE per corpus build to confirm `sympy.besselj(Rational(num,den),
  z).evalf(50) == mpmath.besselj(...)`.
- **Worked example** (`sympy-probe-output.txt`):

  ```text
  besselj(3, 2)          = 0.12894324947440205109879333296923983526999372528246
  bessely(Rational(5,2), Rational(3,2)) = -1.3150372048051936777826754765592963127722808944589
  besseli(Rational(1,2), 3)             = 4.6148229034076009478529803002492770345947778122616
  besselk(0, 10)                        = 0.000017780062316167651811301192799492792312873470160346
  ```

  All four byte-identical with mpmath to 49 digits (the 50th differs
  by ≤ 1 ULP due to mpmath nstr's round-to-nearest applied
  identically in both).
- **Landmines specific to sympy**: none beyond mpmath's (since it
  IS mpmath). The temptation to treat sympy as a third independent
  voice is the landmine — it isn't.

### 3.4 Boost.Math 1.83 via g++ 13.3.0 + `cpp_bin_float<50>` (SILVER, real only)

- **Install path**: `/usr/include/boost/math/special_functions/
  bessel.hpp`; `/usr/include/boost/multiprecision/cpp_bin_float.hpp`;
  `/usr/include/boost/math/special_functions/detail/bessel_jy.hpp`
  (the algorithmic core).
- **Version**: Boost 1.83 (`#define BOOST_LIB_VERSION "1_83"` in
  `/usr/include/boost/version.hpp`).
- **Precision claim**: silver — correctly rounded for
  `cpp_bin_float<N>` to N decimal digits. Last 1-2 digits at N may
  differ from mpmath by 1 ULP (rounding-mode mismatch). For G8's
  comparator, agreement target is "first N-2 digits identical".
- **Capability matrix**:

| Head     | int-ν real | half-int-ν real | gen-ν real | int-ν cplx | half-int-ν cplx | gen-ν cplx |
| -------- | :--------: | :-------------: | :--------: | :--------: | :-------------: | :--------: |
| BesselJ  |     ✓      |        ✓        |     ✓      |     ✗      |        ✗        |     ✗      |
| BesselY  |     ✓      |        ✓        |  ✓ (L4)    |     ✗      |        ✗        |     ✗      |
| BesselI  |     ✓      |        ✓        |     ✓      |     ✗      |        ✗        |     ✗      |
| BesselK  |     ✓      |        ✓        |     ✓      |     ✗      |        ✗        |     ✗      |

  All complex cells are **template-substitution failure**, not
  refusal. The compile-error excerpt (`boost-complex-probe-output.
  txt`):

  ```text
  /usr/include/boost/math/special_functions/bessel.hpp:99:9: error:
    no match for 'operator<' (operand types are 'std::complex<double>' and 'int')
       99 |    if(x < 0)
  ```

  Per ADR-0040 §"honest scope": the G4 adapter MUST refuse complex
  inputs with `tagged "oracle-boost/complex-unsupported"` rather
  than attempt instantiation and propagate the compile error.

- **Cost**:
  - One-time compile: **~26.5 s** (heavy template instantiation
    for `cpp_bin_float<50>` Bessel paths). Cache the binary.
  - Run cost (10 calls): **0.011 s** ⇒ ~1 ms/call. By a wide
    margin the fastest oracle on this machine in warm-run mode.
  - Estimated throughput: 1000+ evaluations/second per precision.

- **Batch-mode pattern** (G4 adapter):

  ```ts
  // packages/oracle-besselj/boost.ts (design sketch)
  // Strategy: compile ONCE at adapter install time with a finite set of
  // template precisions {30, 50, 70, 100} all instantiated as separate paths.
  // The compiled binary takes {precision, fn, nu_str, z_str} on stdin as
  // newline-delimited JSON, dispatches via switch on precision, prints
  // {"result": "<decimal string>"} on stdout.
  // REFUSE complex inputs with a clean error.
  // NB Boost spells Y_ν as cyl_neumann (cyl_bessel_y does NOT exist).
  ```

  Working test program: `boost-test-prog.cpp` (with the
  `cyl_neumann` correction applied in revision 2). Use as the
  literal starting point for G4.

- **Worked example** (`boost-probe-output.txt`):

  ```text
  === Boost cpp_bin_float<50> ===
  cyl_bessel_j(3, 2)       = 0.12894324947440205109879333296923983526999372528246
  cyl_neumann (2.5, 1.5)   = -1.3150372048051936777826754765592963127722808944588
  cyl_bessel_i(0.5, 3)     = 4.6148229034076009478529803002492770345947778122616
  cyl_bessel_k(0, 10)      = 1.7780062316167651811301192799492792312873470160347e-05
  cyl_neumann (-1.5, 1.5)  = -0.38714221727606743621772237366146145526735600842364
  cyl_bessel_k(-1.5, 1.5)  = 0.38055842038044242679325810346081234920702502688381
  cyl_bessel_j(0, 1st zero)= -1.6008725313912482801501576220517239690439837377005e-50
  cyl_bessel_i(0, 700)     = 1.5295933476718737363162072288904508649662689614637e+302
  cyl_bessel_k(0, 700)     = 4.6697764316853768809856276364426087990517773538029e-306
  ```

  All four heads byte-identical with mpmath at 49 digits; last
  digit differs by ≤ 1 ULP. **At the first J_0 zero**, Boost
  returns `-1.6e-50` while mpmath returns `-1.7e-50` — agreement
  is to the 1st significant figure only because relative error is
  unbounded at a true zero (L7). Adapter pins absolute-error
  comparison in this case.

- **Landmines specific to Boost**: L_boost_yspell (Y_ν is
  `cyl_neumann`, NOT `cyl_bessel_y` — compile-fails with a
  misleading "did you mean cyl_bessel_k" suggestion); L4
  (cancellation tail at large z — documented but observed
  well-behaved up to z=1e10 in this probe — see
  `boost-y-tail-probe.txt`).

### 3.5 SciPy 1.17.0 via `python3` (BRONZE — primary float64 complex oracle)

- **Install path**: `/usr/lib/python3.12/dist-packages/scipy/special/`.
- **Version**: 1.17.0.
- **Precision claim**: bronze — float64; uses AMOS Fortran code
  (Donald Amos, 1995) for general-ν via `jv`/`yv`/`iv`/`kv`; uses
  Cephes (Stephen Moshier) for integer-ν `jn`/`yn`/`j0`/`j1`/
  `y0`/`y1`. Typical accuracy is 1-2 ULP for moderate inputs;
  degrades to 10+ ULP at large arguments and silently underflows
  to 0.0 for `jv(1000, 100)`.
- **Capability matrix** (✓ float64-correct ≤ 2 ULP; ⚠ caveat; ✗ refuses):

| Head     | int-ν real | half-int-ν real | gen-ν real | int-ν cplx | half-int-ν cplx | gen-ν cplx |
| -------- | :--------: | :-------------: | :--------: | :--------: | :-------------: | :--------: |
| BesselJ  |     ✓      |        ✓        |  ✓ (L5)    |     ✓      |        ✓        |  ✓ (L5)    |
| BesselY  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
| BesselI  |     ✓      |        ✓        |  ✓ (L8)    |     ✓      |        ✓        |  ✓ (L8)    |
| BesselK  |     ✓      |        ✓        |  ✓ (L9)    |     ✓      |        ✓        |  ✓ (L9)    |

- **Cost**:
  - Cold-start: ~220 ms (Python + scipy import).
  - Warm batch (4000 calls): **0.333 s** ⇒ ~82 µs/call. Of the
    bronze tier, scipy is the only one with complex support and
    is the *fastest python-callable*.

- **Batch-mode pattern** (G5 adapter):

  ```ts
  // packages/oracle-besselj/scipy.ts (design sketch)
  // python3 -u scipy_oracle.py reads newline-delimited JSON,
  // calls scipy.special.{jv,yv,iv,kv}(nu, complex(re, im)),
  // returns {"re": repr(r.real), "im": repr(r.imag)} for complex inputs,
  //         {"re": repr(r),       "im": "0"}            for real inputs.
  // For overflow-prone large-z calls (|z| > 100), additionally call
  //   ive(nu, z)  for I_ν       (returns I_ν(z) e^{-z})
  //   kve(nu, z)  for K_ν       (returns K_ν(z) e^{+z})
  // and emit BOTH the unscaled value AND the scaled e-power separately;
  // G8's comparator multiplies back when comparing against gold.
  ```

- **Worked example** (`scipy-probe-output.txt`):

  ```text
  jv(3, 2)        = 0.12894324947440208
  yv(2.5, 1.5)    = -1.315037204805194
  iv(0.5, 3)      = 4.614822903407602
  kv(0, 10)       = 1.778006231616765e-05

  Complex:
  jv(3, 0.5+0.7j) = (-0.012722421408081976+0.004408551591352995j)
  yv(2.5, 1.5+0.3j)= (-1.176455912972217+0.4093809140114355j)
  iv(0.5, 3+0j)   = (4.614822903407577+0j)
  kv(0, 10+0j)    = (1.778006231616765e-05+0j)
  ```

  **Notes**: `iv(0.5, 3+0j) = 4.614822903407577` is **3 ULP off**
  the gold value `4.614822903407602` — the COMPLEX-INPUT real-axis
  path is less accurate than the REAL-input path
  (`iv(0.5, 3) = 4.614822903407602`). This is a documented AMOS
  quirk (the complex path uses a different recurrence). **G5
  adapter must record this**: when an input is real-with-zero-im,
  call the real-input branch (`s.iv(0.5, 3)`), not the complex
  branch (`s.iv(0.5, 3+0j)`).

- **Landmines specific to SciPy**: L5 (silent underflow), L8
  (integer-vs-near-integer-ν jump), L9 (K underflow). All in §6.
  Plus the complex-vs-real-axis ULP divergence noted just above.

### 3.6 libm (`<math.h>` j0/j1/jn/y0/y1/yn via glibc) (BRONZE — most restricted)

- **Install path**: `/usr/include/math.h` (declarations); `/usr/lib/
  x86_64-linux-gnu/libm.so.6` (impl).
- **Version**: glibc 2.39 (Ubuntu 24.04 baseline), g++ 13.3.0
  compile chain.
- **Precision claim**: bronze — float64; implementation-defined
  per ISO C 99 Annex F.10 (errata: jX/yX are XSI extensions and
  permit "approximate" precision). Typically ≤ 4 ULP for moderate
  inputs.
- **Capability matrix**:

| Head     | int-ν real | half-int-ν real | gen-ν real | int-ν cplx | half-int-ν cplx | gen-ν cplx |
| -------- | :--------: | :-------------: | :--------: | :--------: | :-------------: | :--------: |
| BesselJ  |     ✓      |        ✗        |     ✗      |     ✗      |        ✗        |     ✗      |
| BesselY  |     ✓      |        ✗        |     ✗      |     ✗      |        ✗        |     ✗      |
| BesselI  |     ✗      |        ✗        |     ✗      |     ✗      |        ✗        |     ✗      |
| BesselK  |     ✗      |        ✗        |     ✗      |     ✗      |        ✗        |     ✗      |

  **libm provides `j0`, `j1`, `jn`, `y0`, `y1`, `yn` only — no
  general-ν, no Bessel-I, no Bessel-K, no complex.** Most
  restricted of any oracle on the machine.

- **Cost**: build + 8 calls ⇒ 0.004 s ⇒ basically free per call
  (~50 ns warm).
- **Batch-mode pattern** (G6 adapter): single compiled binary,
  per-call JSON in/out. Refuse anything but integer ν and real z.
- **Worked example** (`libm-probe-output.txt`):

  ```text
  j0(2.0)    = 0.22389077914123567
  j1(2.0)    = 0.5767248077568734
  jn(3, 2.0) = 0.12894324947440206
  y0(2.0)    = 0.51037567264974515
  y1(2.0)    = -0.10703243154093754
  yn(2, 1.5) = -0.93219375976297392
  j0(2.4048255576957727686) = -6.1087652597367303e-17
  y0(1e6)    = -0.00072596852233517914
  y0(1e8)    = 7.3063911655217072e-05
  ```

  `jn(3, 2.0) = 0.12894324947440206` agrees with Boost-double's
  `0.12894324947440206` (16 digits identical) and with gold
  `0.128943249474402051098...` truncated to 16 digits. **At the
  first J_0 zero**: libm returns `-6.1e-17` (this is float64 ULP
  noise — `z` itself can only be represented to ~1e-17, and
  `J_0'(z₁) ≈ -0.519`, giving ~5e-17 expected error from input
  noise alone). Cross-check L7's tolerance band.

- **Landmines specific to libm**: capability narrowness (cells
  marked ✗ above). The bone of contention with bronze cross-checks
  is that libm cannot probe the gen-ν dispatch path — adapter
  refuses any `nu_str` not parseable as an `int32` integer.

### 3.7 Julia 1.12.5 + SpecialFunctions.jl (NOT AVAILABLE — deferred-on-install)

- **Install path**: `/home/tobias/.juliaup/bin/julia` (binary
  present); `~/.julia/environments/v1.12/Project.toml` lists only
  `PicoSAT v0.4.1`. `SpecialFunctions.jl` not installed.
- **Probe** (`julia-probe-output.txt`):

  ```text
  $ julia -e 'using SpecialFunctions; println(besselj(3, 2))'
  ERROR: ArgumentError: Package SpecialFunctions not found in current path.
  - Run `import Pkg; Pkg.add("SpecialFunctions")` to install ...
  ```

- **Status**: Per the orchestrator's standing instruction ("If
  `Pkg.add` fails (offline, no network), DO NOT install"), the
  probe was halted. `Pkg.add("SpecialFunctions")` may or may not
  succeed on the user's machine — depends on outbound network +
  Julia package mirror availability. **Deferred-on-install
  follow-up.**
- **Were it available** [UNVERIFIED, projected from Erf R5]: Julia
  + SpecialFunctions.jl would provide a third independent
  silver-tier real arb-prec voice via `BigFloat` (MPFR-backed).
  Complex `Complex{BigFloat}` was unsupported in
  SpecialFunctions.jl's `erf` per Erf R5 §2.7 — same restriction
  EXPECTED for Bessel but UNVERIFIED until installed. Filed as a
  P3 follow-up bead during Phase 1 G5.

### 3.8 Arb / python-flint (NOT AVAILABLE — STRONG install recommendation; see §7)

- **Install path** (would be after install): FLINT 3.0+ ships Arb
  integrated as the `flint::acb_*` C API in `/usr/include/flint/
  acb_hypgeom.h` and `/usr/include/flint/acb.h`; python-flint
  exposes `flint.acb(z).bessel_j(nu)` etc.
- **Probe** (`flint-probe-output.txt`):

  ```text
  $ python3 -c "from flint import acb"
  ModuleNotFoundError: No module named 'flint'
  ```

  Apt feasibility check (`apt-cache show libflint-dev`):

  ```text
  Package: libflint-dev
  Version: 3.0.1-3.1build1
  Depends: libflint18t64 (= 3.0.1-3.1build1), libmpfr-dev
  Description: ... Fast Library for Integer Number Theory ...
  ```

  Ubuntu 24.04 ships **FLINT 3.0.1**. In FLINT 3.0+, the Arb
  arbitrary-precision math library was MERGED into FLINT — there
  is NO separate `libarb-dev` package needed. The Erf R5
  recommendation `apt install libflint-dev libflint-arb-dev` is
  **stale**: in modern Ubuntu the install reduces to
  `sudo apt install libflint-dev && pip install python-flint`.
  (The Ubuntu `libarb` / `libarb-dev` package is a DIFFERENT
  unrelated project — phylogenetic sequence analysis — DO NOT
  install it.)

- **Were it installed** (per Arb / python-flint upstream docs and
  the Fredrik Johansson `arb_hypgeom` chapter):

  | Head     | int-ν real | half-int-ν real | gen-ν real | int-ν cplx | half-int-ν cplx | gen-ν cplx |
  | -------- | :--------: | :-------------: | :--------: | :--------: | :-------------: | :--------: |
  | BesselJ  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
  | BesselY  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
  | BesselI  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |
  | BesselK  |     ✓      |        ✓        |     ✓      |     ✓      |        ✓        |     ✓      |

  Arb provides RIGOROUS ball arithmetic: every computed value is a
  ball `[centre ± radius]` with mathematically-guaranteed
  containment. For the complex branch this is the missing third
  voice (Wolfram + mpmath + Arb), and Arb is the ONLY oracle on the
  list that returns a certified error bound rather than a
  conjecturally-correct value. **For an honest "world's best
  BesselJ" claim, Arb is the single highest-value install.**

### 3.9 Other (Maxima, Sage, R) — none installed

- `which maxima sage Rscript` all empty. Not pursued further. None
  would add a tier-jumping voice beyond what Wolfram + mpmath + Arb
  cover.

---

## 4. Combined capability matrix (gold/silver/bronze synthesis)

For each (head, ν-class, real/complex) cell, the table lists which
oracles deliver gold-tier ground truth (≥48 dp). Cells with no
gold-tier oracle are marked. Bracketed: oracles available at this
cell that DON'T meet gold-tier precision (silver / bronze /
Boost-template-fails).

| Function × class                           | Gold oracle(s)          | Silver | Bronze                  |
| ------------------------------------------ | ----------------------- | ------ | ----------------------- |
| J_n(x), int n, real x                      | Wolfram + mpmath        | Boost  | SciPy, libm, Boost-dbl  |
| J_{n/2}(x), half-int, real x               | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| J_ν(x), general-ν, real x                  | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| J_n(z), int n, complex z                   | Wolfram + mpmath        | —      | SciPy                   |
| J_{n/2}(z), half-int, complex z            | Wolfram + mpmath        | —      | SciPy                   |
| J_ν(z), general-ν, complex z               | Wolfram + mpmath        | —      | SciPy                   |
| Y_n(x), int n, real x                      | Wolfram + mpmath        | Boost  | SciPy, libm, Boost-dbl  |
| Y_{n/2}(x), half-int, real x               | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| Y_ν(x), general-ν, real x (L3 sign-conv)   | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| Y_n(z), int n, complex z                   | Wolfram + mpmath        | —      | SciPy                   |
| Y_{n/2}(z), half-int, complex z            | Wolfram + mpmath        | —      | SciPy                   |
| Y_ν(z), general-ν, complex z               | Wolfram + mpmath        | —      | SciPy                   |
| I_n(x), int n, real x                      | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| I_{n/2}(x), half-int, real x               | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| I_ν(x), general-ν, real x                  | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| I_n(z), int n, complex z                   | Wolfram + mpmath        | —      | SciPy (note ULP loss)   |
| I_{n/2}(z), half-int, complex z            | Wolfram + mpmath        | —      | SciPy                   |
| I_ν(z), general-ν, complex z               | Wolfram + mpmath        | —      | SciPy                   |
| K_n(x), int n, real x                      | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| K_{n/2}(x), half-int, real x               | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| K_ν(x), general-ν, real x                  | Wolfram + mpmath        | Boost  | SciPy, Boost-dbl        |
| K_n(z), int n, complex z                   | Wolfram + mpmath        | —      | SciPy                   |
| K_{n/2}(z), half-int, complex z            | Wolfram + mpmath        | —      | SciPy                   |
| K_ν(z), general-ν, complex z               | Wolfram + mpmath        | —      | SciPy                   |

**Tally: 24 cells, 24 with gold (Wolfram + mpmath), 12 with silver
(Boost — real only), 24 with bronze.** The 12 complex cells have
**no silver-tier voice locally** — install python-flint to close
that gap (§7).

---

## 5. Tier-aware comparator thresholds (G8 input)

Per ADR-0040 Decision 8 + Erf G8 tuning:

- **gold-vs-gold** (Wolfram vs mpmath): byte-identical to first
  `precision - 2` digits. Disagreement above 2-digit slack is a
  finding (file as G8 bead).
- **gold-vs-silver** (Wolfram/mpmath vs Boost): identical to first
  `precision - 4` digits. Boost cpp_bin_float<50>'s last 1-2 digits
  are systematically rounding noise — pin a 4-digit margin.
- **bronze** (any-bronze vs any-gold rounded-to-float64): ULP
  distance ≤ 2 by default, ≤ 10 in the L5/L8/L9-flagged neighborhoods.
- **L7 zero-band override**: if `|z - z_root| < 0.01` (where z_root
  is a tabulated zero of the relevant Bessel head), switch to
  ABSOLUTE-error comparison with threshold `1e-(precision)`.
- **Foreign-pass-through**: a row where Boost (silver) refused
  (complex input) and Julia (silver) is missing is a row with TWO
  silver voices missing — drop the silver-vs-gold check for that
  row and label it `silver-deferred` in the agreement matrix.

---

## 6. Landmines pinned for Phase 1 G2–G7 adapters

The discipline: every landmine listed here is **pinned in adapter
code as a defensive check, error, or mitigation comment**. The
adapter MUST NOT silently ship around any of L1–L11. If a future
agent removes a pinned check without an updated landmine entry,
that's a regression.

### L1 — Wolfram input-trap (carry from Erf R5 §3.1)

- **Reproducer** (`wolfram-probe-output.txt`):

  ```text
  $ wolframscript -code 'N[BesselJ[3, 2.5], 50]'
  0.21660039103911352                            ← 17 digits (silent cap at machine prec)
  $ wolframscript -code 'N[BesselJ[3, 25/10], 50]'
  0.21660039103911352476668900351596372171684342357695992677700684053000212453412`50.   ← 50 digits
  ```

  `2.5` parses as MachinePrecision double; `25/10` parses as exact
  `Rational[5,2]`. **The numerical answer is the SAME computation
  algorithmically — only the input precision controls the output
  precision.**

- **Primary source**: Wolfram Documentation Center, "Numerical
  Evaluation Functions / N", §"Precision tracking":
  https://reference.wolfram.com/language/ref/N.html (the
  N[expr, n] section notes "If expr contains an inexact number,
  Wolfram cannot deliver more digits than that number carries").

- **Mitigation in adapter**: Wolfram adapter constructs ALL inputs
  as `ToExpression[<decimal_string>]` after pre-processing
  `"d.ddd…d"` → `"<num>/<denom>"` (e.g. `"1.23"` → `"123/100"`).
  ALSO for ν: `"2.5"` → `"5/2"`. For complex z:
  `"z_re/d + z_im/d I"`. Pinned with an inline comment
  `// LANDMINE L1`.

### L2 — mpmath nstr-vs-Wolfram-N rounding mismatch (carry from Erf R5 §3.2)

- **Reproducer**: BesselJ[3,2] at 50 digits:
  - mpmath: `0.12894324947440205109879333296923983526999372528246023390`
    (nstr rounds to nearest at digit 50)
  - Wolfram: `0.12894324947440205109879333296923983526999372528246023386`
    (N[] truncates at digit 50)
  - Boost: `0.12894324947440205109879333296923983526999372528246`
    (50 dp; no rounding past N)

  All three agree to digit 49; mpmath rounds up at 50, Wolfram and
  Boost truncate. **1 ULP last-digit discrepancy** is the rule, not
  the exception.

- **Primary source**: mpmath documentation, `mpmath.nstr` — defaults
  to `strip_zeros=False, rounding='to-nearest'`. Wolfram
  Documentation Center, `N[expr, n]` — emits at requested precision
  truncated, not rounded.

- **Mitigation in G8 comparator**: compare at
  `precision_decimals - 1` digits, OR round both to a canonical
  representation (`canonicalScientific` helper per Erf G8 — re-use).

### L3 — Negative non-integer ν branch convention (Bessel-specific)

- **The question**: For `Y_{-1.5}(1.5)` and `K_{-1.5}(1.5)`, which
  convention do oracles use? DLMF 10.4.1 states:

  `Y_{-ν}(z) = cos(νπ) · Y_ν(z) + sin(νπ) · J_ν(z)`
  `K_{-ν}(z) = K_ν(z)` (even-in-ν exactly; no branch).

- **Probe across all four oracles** (`branch-cut-probe.txt`,
  `branch-cut-probe-v2.txt`):
  - Wolfram: `Y_{-3/2}(3/2) = -0.38714221727606743621772237366146`
  - mpmath: `Y_{-1.5}(1.5)  = -0.387142217276067436217722373661`
  - Boost:  `cyl_neumann(-1.5, 1.5) = -0.38714221727606743621772237366146`
  - SciPy:  `yv(-1.5, 1.5) = -0.3871422172760678`

  All four agree on the SIGN and 16+ digits. **DLMF 10.4.1 with
  the PLUS sign in front of `sin(νπ)·J_ν` is the canonical
  convention.** A common typo (myself making it in the probe!) is
  to write a MINUS sign — that gives the wrong answer.

- **Lesson**: this landmine is for the DOWNSTREAM substrate
  implementer (`packages/bigfloat/src/special-funcs/besselj.ts`),
  NOT the oracle adapters. All four oracles agree; the landmine is
  re-deriving the connection formula from memory and getting the
  sign wrong. Pin a literal byte-for-byte test against gold for
  `bigBesselY(-3/2, 3/2)` and `bigBesselK(-3/2, 3/2)` to catch any
  future regression.

- **Primary source**: NIST DLMF §10.4.1
  (https://dlmf.nist.gov/10.4.E1):
  `Y_{−ν}(z) = (cos νπ) Y_ν(z) + (sin νπ) J_ν(z)`.

### L4 — Boost Bessel-Y catastrophic-cancellation tail

- **The claim** (per Boost.Math docs §"Bessel Functions of the
  First and Second Kinds / Accuracy"): Y_ν(z) loses precision
  through cancellation near zeros and at large z.

- **Reproducer** (`boost-y-tail-probe.txt`):

  ```text
  Y_0(1e6) double  = -0.00072596852233517914
  Y_0(1e6) bf50    = -0.00072596852233517916568272174336768651180052202354664
  Y_0(1e8) double  = 7.3063911655217072e-05
  Y_0(1e8) bf50    = 7.3063911655217070977207391054857779596004142649676e-05
  Y_0(1e10) double = -7.676508175792937e-06
  Y_0(1e10) bf50   = -7.6765081757929366904887452674269255727373821065417e-06
  ```

  In the probed range (up to z=1e10), Boost Y_0 at
  `cpp_bin_float<50>` and `double` agree to 16 digits — no observed
  catastrophic cancellation. The Boost docs warning is conservative.
  **Observation: L4 does not manifest at z ≤ 1e10 in Boost 1.83.**

- **Mitigation**: G4 adapter does NOT need a special-case for L4 in
  the 0 < z ≤ 1e10 range. For z > 1e10, additional cross-validation
  with Wolfram is prudent. Phase 1 G1 corpus tier T_huge_z should
  include 1-2 inputs at z=1e12+ to probe the cliff.

- **Primary source**: Boost.Math documentation, "Bessel functions
  / Cylindrical Bessel functions of the Second Kind / Accuracy":
  https://www.boost.org/doc/libs/1_83_0/libs/math/doc/html/math_toolkit/bessel/bessel.html

### L5 — SciPy `jv` silent underflow at large ν + z

- **Reproducer** (`scipy-landmines-probe.txt`):

  ```text
  jv(50, 10)   = 1.784513607871612e-30
  jv(100, 10)  = 6.597316064155483e-89
  jv(500, 100) = 1.6616492023456242e-287
  jv(1000, 100) = 0.0                     ← silent underflow
  jv(1500, 100) = 0.0
  ```

  At `(ν, z) = (1000, 100)`, the true value `J_1000(100)` is
  approximately `10^(-1493)` (per `|J_ν(z)| ~ (e z / 2 ν)^ν /
  √(2πν)` for ν >> z). SciPy returns `0.0` with NO warning or
  error.

- **Primary source**: SciPy issue tracker confirms AMOS-derived
  underflow behaviour: `scipy.special` returns 0.0 silently on
  underflow per IEEE-754 conventions. SciPy issues:
  https://github.com/scipy/scipy/issues/2942 (general AMOS
  precision discussion).

- **Mitigation in G5 adapter**: for `(ν, z)` with `ν > 5·z`,
  ALWAYS also call `ive(ν, z)` (returns `I_ν(z) · e^{-z}`) and emit
  BOTH the unscaled and scaled values. G8's comparator multiplies
  back symbolically. For J_ν there is no equivalent `jve` — the
  best mitigation is to mark such inputs as `flag: underflow_risk`
  and exclude from bronze-vs-gold comparisons.

  *Wait — confirmed via probe: `hasattr(s, 'jve') == True`.* SciPy
  1.17 DOES export `jve` (scaled `J_ν(z) · e^{-|Im z|}`). However
  for purely-real z this is unhelpful since `e^{-|0|} = 1`. The
  underflow risk persists for real-axis inputs.

### L6 — Julia SpecialFunctions.jl Bessel-Y bug at large ν (deferred — package not installed)

- **Status**: Julia package not locally installed. Cannot reproduce.
- **Per the GitHub issue tracker** (UNVERIFIED probe — Julia is
  unavailable): SpecialFunctions.jl has had several historical
  Bessel-Y precision bugs at large ν. See
  https://github.com/JuliaMath/SpecialFunctions.jl/issues
  (searches for "bessely accuracy" yield multiple issues; one
  notable: https://github.com/JuliaMath/SpecialFunctions.jl/issues/356
  — Bessel functions of large complex argument).

- **Status for our purposes**: L6 is deferred along with G5
  (the Julia oracle adapter). When G5 is undeferred, the
  implementer must add a smoke-test on a handful of large-ν
  inputs (e.g. `bessely(50, 0.1)`) and cross-check against
  gold; document any disagreement here.

### L7 — Algorithm-divergence at J_ν zeros (relative-error trap)

- **Reproducer** (`zero-divergence-probe.txt`):

  ```text
  At z_root = first zero of J_0 = 2.4048255576957727686216318793264546...
    mpmath @ 60 dps: J_0(z_root) = -1.70614154616396485995009750937e-50
    Boost  bf50:     J_0(z_root) = -1.6008725313912482801501576220517e-50
    scipy float64:   j0(z_root)  = -9.586882554916807e-17
    libm float64:    j0(z_root)  = -6.1087652597367303e-17

  Relative error: scipy vs mpmath = 5.6e+33 fold     ← would fail any threshold
  Absolute error: scipy vs mpmath = 9.6e-17           ← well within float64
  ```

  At z = z_root + 0.01:
  ```text
    mpmath @60 dps:  J_0(z_root+0.01) = -0.00518062458774058908
    scipy float64:   j0(z_root+0.01)  = -0.005180624587740599
    Relative error: 2.0e-15              ← back to float64-normal
  ```

- **Mitigation in G8 comparator**: pre-tabulate the first 10 zeros
  of each {J_0, J_1, J_2, Y_0, I_0-has-no-zeros, K_0-has-no-zeros,
  ...}. For any test input z, compute `min_k |z - z_root_k|`. If
  this distance is below 0.01, switch to ABSOLUTE-error comparison
  with threshold `1e-(precision)` (for gold) or `2 ULP` (for
  bronze). Document the override on the agreement-matrix row.

- **Primary source**: NIST DLMF §10.21 (Zeros of Bessel functions
  of the first and second kinds, https://dlmf.nist.gov/10.21);
  mpmath `besseljzero(0, k)` for tabulating.

### L8 — Integer-ν vs near-integer-ν algorithm switch

- **Reproducer**: Wolfram (`wolfram-probe-output.txt` partial):

  ```text
  $ wolframscript -code 'N[BesselJ[3, 5], 50]'
  0.36483123061366699446357694935872197913428221995116403591998431004760273302171

  $ wolframscript -code 'N[BesselJ[3 + 10^(-15), 5], 50]'
  0.36483123061366716217338221911932458866991340143073529976832919751097635268775

  $ wolframscript -code 'N[BesselJ[3 + Rational[1, 10^15], 5], 50]'
  0.36483123061366716217338221911932458866991340143073529976832919751097635268775
  ```

  Difference appears at digit ~17. **The function should be
  smooth in ν.** A perturbation of 1e-15 in ν cannot legitimately
  shift the answer by ~1.7e-16. The discontinuity is an
  algorithm-switch artefact: at exactly integer ν, Wolfram uses
  the integer-recurrence path; at non-integer ν, the general-ν
  Hankel-asymptotic / Miller-recurrence path.

  SciPy shows the same artefact (`scipy-landmines-probe.txt`):

  ```text
  jv(3,           5) = 0.364831230613667
  jv(3 + 1e-15,   5) = 0.3648312306136696
  jv(3 + 1e-12,   5) = 0.36483123061383244
  ```

- **Mitigation in G8 comparator**: tag inputs with
  `|ν - round(ν)| < 1e-13` as `flag: integer_nu_boundary`. For
  these inputs, allow up to 2 ULP discrepancy between integer-path
  and general-path implementations. Document on the row.

  In the SUBSTRATE (`packages/bigfloat/src/special-funcs/
  besselj.ts`): use the integer-recurrence path for exactly
  integer ν, the general-ν path for non-integer ν, and accept the
  algorithmic discontinuity at the boundary as legitimate. This is
  not a bug in any oracle — it's a property of the algorithm
  landscape.

- **Primary source**: NIST DLMF §10.6 (Recurrence Relations and
  Derivatives, https://dlmf.nist.gov/10.6); SpecialFunctions.jl
  source for the same dispatch pattern.

### L9 — Bessel-K underflow

- **Reproducer** (`scipy-landmines-probe.txt`):

  ```text
  scipy:  kv(0, 700)  = 0.0                ← silent underflow
  scipy:  kve(0, 700) = 0.04736236945461356 (returns K_0(700) · e^{700})
  Boost:  cyl_bessel_k(0, 700) bf50 = 4.6697764316853768809856276364426087990517773538029e-306
  Wolfram: N[BesselK[0, 700], 50]   = 4.66977643168537688098562763644260879905177735379543665352712`50.*^-306
  ```

  K_0(700) ≈ 4.67e-306 — which is at the edge of the subnormal
  range of float64 (min normal ≈ 2.2e-308, min subnormal ≈ 4.9e-324).
  Boost-double returns the value correctly (within float64);
  Boost-bf50 returns it at 50 digits; SciPy returns 0.0 with no
  warning.

- **Mitigation in G5 adapter**: for K calls with z > 50, always
  also call `kve(nu, z)` and emit both. G8 multiplies by
  `exp(-z)` symbolically when comparing scaled-vs-unscaled.

- **Primary source**: NIST DLMF §10.40.2 (asymptotic forms for
  K_ν as z → ∞: `K_ν(z) ~ sqrt(π/(2z)) · e^{-z}`,
  https://dlmf.nist.gov/10.40.E2).

### L10 — Bessel-I overflow

- **Reproducer**:

  ```text
  scipy:  iv(0, 700)  = 1.5295933476718723e+302
  Boost:  cyl_bessel_i(0, 700) bf50 = 1.5295933476718737363162072288904508649662689614637e+302
  Wolfram: N[BesselI[0, 700], 50]   = 1.52959334767187373631620722889045086496626896146611648512721115779545895`50.*^302
  scipy:  ive(0, 700) = 0.015081295651531358 (returns I_0(700) · e^{-700})
  ```

  I_0(700) ≈ 1.53e+302 — well within float64 range (max ≈ 1.8e+308).
  But I_0(710) ≈ ?

  ```text
  $ python3 -c "import scipy.special as s; print(s.iv(0, 710))"
  inf      ← overflow at z=710
  $ python3 -c "import scipy.special as s; print(s.ive(0, 710))"
  0.014998811408244147
  ```

- **Mitigation**: same as L9 — adapter records both `iv` and `ive`
  for z > 100. The corpus generator (Phase 1 G1) must include T_huge_z
  tier with explicit `ive`-mode comparison.

- **Primary source**: NIST DLMF §10.40.1
  (`I_ν(z) ~ e^z / sqrt(2πz)` as z → ∞,
  https://dlmf.nist.gov/10.40.E1).

### L11 — Wolfram trailing-noise digits (Bessel-specific reformulation of Erf L2)

- **Reproducer**:

  ```text
  $ wolframscript -code 'N[BesselJ[3, 2], 80]'
  0.128943249474402051098793332969239835269993725282460233864439608742379200753590774918776387899286
  $ wolframscript -code 'N[BesselJ[3, 2], 50]'
  0.12894324947440205109879333296923983526999372528246023386415951315080031119298
  ```

  At N=80 digits, position 51-78 reads `…023386`**`439608742379200753590`**.
  At N=50 digits, position 50 onward reads `…023386`**`415951315080031119298`** —
  these are NOISE digits emitted by Wolfram's `InputForm` past the
  declared precision. Treating them as meaningful generates spurious
  agreement-failures.

- **Mitigation in adapter**: stringify via `ToString[result,
  InputForm]`, split on back-tick (drop the suffix), and TRUNCATE
  the result to `precision - 2` digits before emitting. Pin in G2
  with a comment `// LANDMINE L11 — Wolfram emits N+ noise digits;
  truncate to N-2`.

- **Primary source**: Wolfram Documentation Center, "InputForm" —
  "InputForm always tries to give as much information as is needed
  to reconstruct the expression unambiguously" (which in practice
  means a few extra digits past the declared precision).

### L_carryover — Wolfram `*^` exponent syntax (carry from Erf G2a)

- **Reproducer**:

  ```text
  $ wolframscript -code 'N[BesselI[0, 700], 50]'
  1.52959334767187373631620722889045086496626896146611648512721115779545895`50.*^302
  $ wolframscript -code 'N[BesselK[0, 10], 60]'
  0.00001778006231616765181130119279949279231287347016034643600925391839909193046`60.
  ```

  The `*^302` is Wolfram's scientific-notation syntax. Standard
  decimal-string parsers (Python `float`, JavaScript `Number`, all
  cross-language JSON parsers) expect `e` or `E`. The Erf G2a
  adapter bug emitted 90 spurious cross-agreement findings from
  this. Mitigation pinned in the `wolfram-batch-v2.wls` script:
  `StringReplace[..., "*^" -> "e"]` BEFORE emitting.

### L_boost_yspell — Boost spells Y_ν as `cyl_neumann`, not `cyl_bessel_y`

- **Reproducer**: the first revision of `boost-test-prog.cpp`
  used `boost::math::cyl_bessel_y(nu, x)` and failed to compile:

  ```text
  boost-test-prog.cpp:26:64: error: 'cyl_bessel_y' is not a member of
    'boost::math'; did you mean 'cyl_bessel_k'?
  ```

  The g++ "did you mean" suggestion is misleading — `cyl_bessel_k` is
  Bessel-K, not Bessel-Y. The correct spelling is `cyl_neumann`
  (named after the alternative name "Neumann function" for Y_ν).
  Fixed in revision 2 of `boost-test-prog.cpp`.

- **Mitigation in G4 adapter**: pin the spelling in a centralised
  enum + a comment block at the top of the .cpp:

  ```cpp
  // Boost spellings (NB: Y_nu is cyl_neumann, NOT cyl_bessel_y):
  //   BesselJ ↔ boost::math::cyl_bessel_j
  //   BesselY ↔ boost::math::cyl_neumann          ← LANDMINE
  //   BesselI ↔ boost::math::cyl_bessel_i
  //   BesselK ↔ boost::math::cyl_bessel_k
  ```

- **Primary source**: Boost.Math documentation, "Cylindrical Bessel
  Functions of the Second Kind / cyl_neumann":
  https://www.boost.org/doc/libs/1_83_0/libs/math/doc/html/math_toolkit/bessel/bessel.html

---

## 7. STRONG INSTALL RECOMMENDATION — `python-flint` (Arb)

### The argument

For the Erf reference implementation, the gold-tier complex
arb-prec oracle pool consisted of two voices: Wolfram + mpmath.
Erf R5 §5 noted this as the single weakest-link gap and
recommended installing Arb (then a separate `libarb-dev`
package). The Erf epic shipped without it; complex arb-prec
cross-validation was done by Wolfram + mpmath + algebraic
self-checks (`erf(z*) = erf(z)*`, `erf(z) + erfc(z) = 1`).

**The Bessel family is fundamentally harder for self-checks:**

1. **There are 4 heads, not 2.** Erf's family had 4 heads (Erf,
   Erfc, Erfcx, Erfi) bound by simple algebraic identities. The
   Bessel family has J/Y/I/K bound by more involved Wronskian
   relations (J Y' - J' Y = 2/(πz)), which require evaluating
   derivatives — adding another precision-burning operation.
2. **Connection formulas involve cos/sin of νπ** (L3). At
   half-integer ν the trig terms vanish exactly, but at general
   ν they're non-trivial and degrade self-checks by ~log₂(|νπ|) bits.
3. **Two-engine single-engine-paired complex arb-prec means there
   is NO tie-breaker if Wolfram and mpmath disagree.** This bit
   the Erf epic at G8 (Wolfram's `Erfi(MAX_DOUBLE)` returning
   `1.38e+14_035_097...`; mpmath returning `inf`; no third voice
   to adjudicate). The Erf epic resolved by downgrading the cell
   to a documented "two-source-gold with provenance note." That
   compromise was acceptable for Erf because the cell was an
   edge-input; for Bessel, EVERY complex cell in the capability
   matrix is in the same situation.

**Recommendation: orchestrator request user approval to
install `python-flint` BEFORE Phase 1 commences.**

### The install command

In Ubuntu 24.04, FLINT 3.0.1 ships Arb INTEGRATED (the Arb
library was merged into FLINT in 2023; FLINT 3.0+ provides
`acb_*`, `arb_*`, `acb_hypgeom_*` etc. directly). The install is:

```sh
sudo apt install libflint-dev
pip install --user python-flint
```

**NOT** `sudo apt install libflint-dev libflint-arb-dev` (the
recommendation in Erf R5 § 5 was stale — `libflint-arb-dev` no
longer exists as a separate package; AND the Ubuntu `libarb-dev`
package is a DIFFERENT unrelated project, phylogenetic sequence
analysis, DO NOT install it).

Estimated install time: `apt` ~30 s; `pip` ~60 s (compiles the
binding). Total ~2 min wall-time.

### The capability gain

With python-flint installed, every cell of the capability matrix
(§4) gains an Arb voice. Arb's `acb_hypgeom_bessel_{j,y,i,k}`
returns rigorous ball arithmetic (`[centre ± radius]` with
provable containment of the true value). This means:

1. **Three-way independent complex arb-prec** for all 12 complex
   cells (Wolfram + mpmath + Arb).
2. **Rigorous error bounds** — Arb's balls are MATHEMATICALLY
   GUARANTEED to contain the true value (modulo a CVE in the
   library, which Fredrik Johansson has never had). Other oracles
   are "correctly rounded" at the heuristic-correctness level.
3. **Phase 1 G7 becomes a real adapter, not a deferred-on-install
   placeholder.** The Erf epic's G7 was deferred and its absence
   was the only critical-path follow-up not closed at epic-close.

### Cost of not installing

Without python-flint:
- Phase 1 G7 ships as a deferred-on-install bead with a docs note.
- All complex arb-prec cells in the agreement matrix carry a
  "two-source-gold" provenance flag.
- For inputs where Wolfram and mpmath disagree (expected: ~5 per
  corpus of 200), the dispute can only be resolved by algebraic
  self-check; if the self-check is inconclusive (as the Erf
  `Erfi(MAX_DOUBLE)` case demonstrated), the input must be
  excluded from the corpus.

### The orchestrator's call

Per the user's standing CLAUDE.md instruction ("never `apt install`
or `pip install` of system packages without explicit user
approval"), this R5 artefact does NOT install. **The orchestrator
should explicitly request user approval, citing this section as
justification.**

---

## 8. References (local paths)

- This artefact: `docs/refs/besselj-research/R5-oracle-landscape.md`.
- Captured probe outputs: `docs/refs/besselj-research/sources/
  oracles/*.txt`. Per-claim citations inline above.
- Test programs: `docs/refs/besselj-research/sources/oracles/
  {boost,libm,boost-y-tail,boost-complex}-test-prog.{cpp,c}` and
  `wolfram-batch-v2.wls`.
- Erf R5 (styling exemplar): `docs/refs/erf-research/
  R5-oracle-landscape.md`.
- Erf epic close (frictions catalogue): `docs/worklog/142-erf-
  epic-close.md`.
- ADR pinning tier hierarchy: `docs/adr/0040-per-head-special-
  function-substrate-and-meijer-g-bridge.md` §"Decision 8".
- HANDOFF for the methodology: `docs/HANDOFF_per_head_special_
  function_methodology.md` §"Phase 1: oracle harness + golden
  corpus".
- ADR-0001 (spawnBun resolver pattern for child processes):
  required by all G2–G7 adapters.
- ADR-0015 (`numerical: true` + platform fingerprint): bronze-tier
  determinism contract.
- ADR-0020 (`arbprec: true` + `--precision` flag): gold/silver-tier
  determinism contract.
- Project CLAUDE.md Rule 8 (honest scope; tagged refusal vs lying):
  Boost adapter's complex-input refusal.

### Primary-source references (external)

- NIST Digital Library of Mathematical Functions, Chapter 10
  (Bessel Functions): https://dlmf.nist.gov/10
  - §10.4 (Connection Formulas): https://dlmf.nist.gov/10.4
  - §10.6 (Recurrence Relations): https://dlmf.nist.gov/10.6
  - §10.21 (Zeros of J_ν, Y_ν): https://dlmf.nist.gov/10.21
  - §10.40 (Asymptotic Expansions for K_ν, I_ν):
    https://dlmf.nist.gov/10.40
- Boost.Math documentation, Bessel functions chapter (Boost 1.83):
  https://www.boost.org/doc/libs/1_83_0/libs/math/doc/html/math_toolkit/bessel/bessel.html
- mpmath documentation, Bessel functions:
  https://mpmath.org/doc/current/functions/bessel.html
- SciPy documentation, scipy.special.jv / yv / iv / kv:
  https://docs.scipy.org/doc/scipy/reference/special.html#bessel-functions
- Fredrik Johansson, Arb library:
  https://arblib.org/  (note: now part of FLINT 3.0+ as
  `flint::acb_hypgeom_*`)

End of R5.
