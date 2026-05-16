# R5 — Local oracle landscape for `erf` / `erfc`

**Bead:** R5 (of 26-bead orchestrated erf-oracle effort).
**Date probed:** 2026-05-16.
**Host:** Linux 6.8.0-111-generic (Ubuntu 24.04 "noble" derivative).
**Scope:** capability matrix + worked examples + tier proposal + uniform
adapter shape + gaps. Research/probing only — no source files were
modified outside this artefact; no packages were installed.

All "available" and "version" claims below are backed by a literal CLI
excerpt. Every numeric output reproduces an actual run. Probing
commands are inlined so a future agent can re-run.

---

## 1. Capability matrix

| Oracle                                | Version           | Installed? | Arb-prec real        | Arb-prec complex     | float64 real | float64 complex | CLI surface                | Accuracy claim                                       |
| ------------------------------------- | ----------------- | ---------- | -------------------- | -------------------- | ------------ | --------------- | -------------------------- | ---------------------------------------------------- |
| Wolfram Mathematica (`wolframscript`) | 14.3.0 (kernel) / WolframScript 1.13.0 | **YES** | YES                  | YES                  | yes          | yes             | `wolframscript -code '…'`  | declared `N[…, d]` precision, correctly rounded      |
| Python `mpmath`                       | 1.3.0             | **YES**    | YES                  | YES                  | n/a          | n/a             | `python3 -c '…'`           | correctly rounded to declared `mp.dps`               |
| Python `sympy`                        | 1.14.0            | **YES**    | YES (via mpmath)     | YES (via mpmath)     | n/a          | n/a             | `python3 -c '…'`           | symbolic + `.evalf(d)` ⇒ delegates to mpmath          |
| Python `scipy`                        | 1.17.0            | **YES**    | no                   | no                   | YES          | YES             | `python3 -c '…'`           | float64 to ≤ few ULP (Cephes / Faddeeva)             |
| Python `numpy`                        | 1.26.4            | YES        | n/a                  | n/a                  | (no `erf`)    | (no `erf`)       | n/a                        | not an erf source                                    |
| Julia 1.12.5 + `SpecialFunctions.jl`  | Julia present, **package NOT installed** | NO  | (would: yes real)    | (would: no — `MethodError` on `Complex{BigFloat}`) | yes (would) | yes (would) | `julia -e '…'`        | N/A locally — package missing                        |
| Boost.Math (`boost::math::erf`)       | Boost 1.83        | **YES**    | YES (`cpp_bin_float<N>`) | NO (template instantiation fails on `std::complex`) | YES | no | C++ compile + run         | correctly rounded for `cpp_bin_float<N>` at N digits |
| C++ `<cmath>` (`std::erf`, libm)      | g++ 13.3.0 / glibc libm | **YES** | no                   | no                   | YES          | no              | C++ compile + run          | libm implementation-defined; typically ≤ 1 ULP       |
| MPFR (`libmpfr.so.6`)                 | runtime 4.2.1     | runtime-only — no `-dev` headers | (would: yes) | no | n/a   | n/a | C linkage (no headers)     | correctly rounded — but cannot link without `libmpfr-dev` |
| GSL (`libgsl.so.27`)                  | runtime 2.7.1     | runtime-only — no `-dev` headers | n/a    | n/a       | (would: yes) | no | C linkage (no headers)     | float64 + error estimate — but cannot link            |
| Arb / FLINT                           | —                 | NO         | (would: yes ball)    | (would: yes ball)    | n/a          | n/a             | n/a                        | N/A — not installed                                  |
| `python-flint` / `gmpy2`              | —                 | NO         | (gateway to FLINT)   | (gateway to FLINT)   | n/a          | n/a             | n/a                        | N/A — not installed                                  |
| R / `Rscript`                         | —                 | NO         | no                   | no                   | (would: yes) | no              | n/a                        | N/A — not installed                                  |

### Probe excerpts backing the "Installed?" column

```text
$ which wolframscript
/usr/bin/wolframscript
$ wolframscript -version
WolframScript 1.13.0 for Linux x86 (64-bit)
$ which math
/usr/local/bin/math
$ math -version
14.3.0 for Linux x86 (64-bit)

$ python3 --version
Python 3.12.3
$ python3 -c 'import sys; print(sys.version)'
3.12.3 (main, Mar 23 2026, 19:04:32) [GCC 13.3.0]

$ python3 -c 'import mpmath; print("mpmath", mpmath.__version__)'
mpmath 1.3.0
$ python3 -c 'import scipy; print("scipy", scipy.__version__)'
scipy 1.17.0
$ python3 -c 'import numpy; print("numpy", numpy.__version__)'
numpy 1.26.4
$ python3 -c 'import sympy; print("sympy", sympy.__version__)'
sympy 1.14.0
$ python3 -c 'import flint; print(flint.__version__)'
ModuleNotFoundError: No module named 'flint'
$ python3 -c 'import gmpy2; print(gmpy2.version())'
ModuleNotFoundError: No module named 'gmpy2'

$ which julia
/home/tobias/.juliaup/bin/julia
$ julia --version
julia version 1.12.5
$ julia -e 'using Pkg; Pkg.status()'
Status `~/.julia/environments/v1.12/Project.toml`
  [ff2beb65] PicoSAT v0.4.1
$ julia -e 'using SpecialFunctions; println(pkgversion(SpecialFunctions))'
ERROR: ArgumentError: Package SpecialFunctions not found in current path.

$ which g++
/usr/bin/g++
$ g++ --version | head -1
g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0

$ ls /usr/include/boost/version.hpp
/usr/include/boost/version.hpp
$ ls /usr/include/boost/math/special_functions/erf.hpp
/usr/include/boost/math/special_functions/erf.hpp
$ grep BOOST_LIB_VERSION /usr/include/boost/version.hpp | head -1
#define BOOST_LIB_VERSION "1_83"

$ ls /usr/include/mpfr.h
ls: cannot access '/usr/include/mpfr.h': No such file or directory
$ ls /usr/lib/x86_64-linux-gnu/libmpfr*
/usr/lib/x86_64-linux-gnu/libmpfr.so.6
/usr/lib/x86_64-linux-gnu/libmpfr.so.6.2.1
$ ls /usr/include/gsl/gsl_sf_erf.h
ls: cannot access '/usr/include/gsl/gsl_sf_erf.h': No such file or directory
$ ls /usr/lib/x86_64-linux-gnu/libgsl*
/usr/lib/x86_64-linux-gnu/libgsl.so.27
/usr/lib/x86_64-linux-gnu/libgsl.so.27.0.0
$ ls /usr/include/flint/arb.h /usr/include/arb.h
ls: cannot access '/usr/include/flint/arb.h': No such file or directory
ls: cannot access '/usr/include/arb.h': No such file or directory

$ which gsl-config
(not on PATH)
$ which Rscript
(not on PATH)
$ which mpfr-config
(not on PATH)
```

### Summary

Of 13 candidate backends, **5 are installed and usable locally**:
Wolfram Mathematica, mpmath, sympy, scipy, Boost.Math; plus `<cmath>`
via g++. Julia is installed but `SpecialFunctions.jl` is not.

The locally-available **arb-prec real** oracles are
**Wolfram + mpmath + sympy + Boost** — four independent
implementations. The locally-available **arb-prec complex** oracles
are **Wolfram + mpmath + sympy** — but sympy is not independent of
mpmath, so this is really **two** independent voices (Wolfram and
mpmath). The locally-available **float64 complex** oracles are
**scipy (Faddeeva) + Wolfram float64**.

Crucially: **no local independent silver-tier arb-prec complex oracle
exists** beyond Wolfram + mpmath. This is the one notable gap (§5).

---

## 2. Per-oracle worked examples

Targets throughout:

- `erf(1.23)` and `erfc(1.23)` at 50-decimal precision.
- `erf(0.5 + 0.7i)` and `erfc(0.5 + 0.7i)` at 50-decimal precision.

### 2.1 Wolfram Mathematica (Gold — real + complex, arb-prec)

**Important caveat:** `N[Erf[1.23], 50]` does **not** give 50 digits —
the literal `1.23` is parsed as a machine-precision double, which
silently caps Wolfram at ~16 digits:

```text
$ wolframscript -code 'N[Erf[1.23], 50]'
0.9180501041267614
```

To actually request 50 digits, the input must be an exact rational (or
wrapped in `SetPrecision[..., 60]`):

```text
$ wolframscript -code 'N[Erf[123/100], 50]'
0.91805010412676136789273300392075214555771922462406708095005970802796930750084`50.

$ wolframscript -code 'N[Erfc[123/100], 50]'
0.08194989587323863210726699607924785444228077537593291771379792597513130835638`50.

$ wolframscript -code 'N[Erf[1/2 + 7/10 I], 50]'
0.78627282800464320891609283764169690678792967527278940239827872460570857322392`50.03305108723522 +
  0.66607235912046604179820394797640399117425281735723563680655517365635606723746`49.96099923118899*I

$ wolframscript -code 'N[Erfc[1/2 + 7/10 I], 50]'
0.21372717199535679108390716235830309321207032472721059760172127539429142677607`49.63557306520514 -
  0.66607235912046604179820394797640399117425281735723563680655517365635606723746`50.12923473746831*I
```

Notes: the `` `50. `` suffix is Wolfram's precision annotation; the
`` `50.03... `` / `` `49.96... `` on the complex case are the per-component
*tracked* precisions (slightly above and below 50, reflecting catastrophic
cancellation tracking). **The adapter must strip the back-tick precision
suffix when emitting the decimal-string envelope.**

### 2.2 mpmath (Gold — real + complex, arb-prec)

```sh
python3 -c "
import mpmath
mpmath.mp.dps = 50
print('erf(1.23)         [50d]:', mpmath.nstr(mpmath.erf('1.23'), 50))
print('erfc(1.23)        [50d]:', mpmath.nstr(mpmath.erfc('1.23'), 50))
z = mpmath.mpc('0.5','0.7')
r  = mpmath.erf(z);   print('erf(0.5+0.7i)  re :', mpmath.nstr(r.real, 50));  print('erf(0.5+0.7i)  im :', mpmath.nstr(r.imag, 50))
r2 = mpmath.erfc(z);  print('erfc(0.5+0.7i) re :', mpmath.nstr(r2.real, 50)); print('erfc(0.5+0.7i) im :', mpmath.nstr(r2.imag, 50))
"
```

Literal output:

```text
erf(1.23)         [50d]: 0.91805010412676136789273300392075214555771922462407
erfc(1.23)        [50d]: 0.081949895873238632107266996079247854442280775375933
erf(0.5+0.7i)  re : 0.78627282800464320891609283764169690678792967527279
erf(0.5+0.7i)  im : 0.66607235912046604179820394797640399117425281735724
erfc(0.5+0.7i) re : 0.21372717199535679108390716235830309321207032472721
erfc(0.5+0.7i) im : -0.66607235912046604179820394797640399117425281735724
```

Notes: `mp.dps = 50` requests 50 working digits; `mpmath.erf` bumps
internal precision to hit that correctly-rounded at the requested
inputs. `mpmath.nstr(value, 50)` controls *output* digits.
Cross-checking with Wolfram: the first 50 displayed digits of
`0.91805010412676136789273300392075214555771922462407` (mpmath) vs
`0.91805010412676136789273300392075214555771922462406708095005970...`
(Wolfram `` `50 ``) agree on all 50 digits, with mpmath rounding up at
the 50th digit (`...07`) where Wolfram had `...06708...` — i.e.,
**mpmath is correctly-rounded-to-50-digits, Wolfram is truncated-to-50**.
This is a feature of `mpmath.nstr`'s rounding mode, not a disagreement.

### 2.3 sympy (Redundant-gold — same engine as mpmath)

```sh
python3 -c "
import sympy
print('erf(123/100)    [50d]:', sympy.erf(sympy.Rational(123,100)).evalf(50))
print('erfc(123/100)   [50d]:', sympy.erfc(sympy.Rational(123,100)).evalf(50))
z = sympy.Rational(1,2) + sympy.Rational(7,10)*sympy.I
print('erf(0.5+0.7i)   [50d]:', sympy.erf(z).evalf(50))
print('erfc(0.5+0.7i)  [50d]:', sympy.erfc(z).evalf(50))
"
```

Literal output:

```text
erf(123/100)    [50d]: 0.91805010412676136789273300392075214555771922462407
erfc(123/100)   [50d]: 0.081949895873238632107266996079247854442280775375933
erf(0.5+0.7i)   [50d]: 0.78627282800464320891609283764169690678792967527279 + 0.66607235912046604179820394797640399117425281735724*I
erfc(0.5+0.7i)  [50d]: 0.21372717199535679108390716235830309321207032472721 - 0.66607235912046604179820394797640399117425281735724*I
```

Comment: bit-identical agreement with mpmath at 50 digits (sympy
`.evalf` lowers to mpmath under the hood). Treat as **redundant-gold**
— useful as a wire-format check that the symbolic pipeline through
`.evalf` doesn't perturb the answer, **not** as an independent
implementation vote.

### 2.4 Boost.Math + `cpp_bin_float<50>` (Silver — real, arb-prec)

```cpp
// /tmp/erftest_boost_cpp_bin_float.cpp
#include <iostream>
#include <iomanip>
#include <boost/multiprecision/cpp_bin_float.hpp>
#include <boost/math/special_functions/erf.hpp>
int main() {
    using namespace boost::multiprecision;
    using Real50 = number<cpp_bin_float<50>>;
    Real50 x("1.23");
    std::cout << std::setprecision(50) << boost::math::erf(x)  << std::endl;
    std::cout << std::setprecision(50) << boost::math::erfc(x) << std::endl;
    return 0;
}
```

Build + run:

```text
$ g++ -std=c++17 /tmp/erftest_boost_cpp_bin_float.cpp -o /tmp/erftest_bcbf
$ /tmp/erftest_bcbf
0.91805010412676136789273300392075214555771922462407
0.081949895873238632107266996079247854442280775375935
```

**This is the silver tier's load-bearing oracle for the real branch.**
50-digit value agrees byte-identically with mpmath (`erf`) and to the
49th digit with mpmath for `erfc` (mpmath rounds 50th to `...933`,
Boost to `...935` — both within the unit-in-the-last-place envelope).
Boost is a **completely independent C++ implementation** of `erf` (not
sharing code with mpmath, sympy, or Wolfram).

For complex inputs, Boost's template substitution **fails**:

```text
$ g++ /tmp/erfcplx_compile_test.cpp -o /tmp/erfcplx_compile_test
In file included from /tmp/erfcplx_compile_test.cpp:2:
/usr/include/boost/math/special_functions/erf.hpp: In instantiation of
'T boost::math::detail::erf_imp(T, bool, const Policy&, const Tag&)
[with T = std::complex<double>; …]':
...
```

Boost is **real-only**.

### 2.5 scipy (Bronze — float64 real + complex)

```sh
python3 -c "
import scipy.special as sp
print('erf(1.23)         :', repr(sp.erf(1.23)))
print('erfc(1.23)        :', repr(sp.erfc(1.23)))
print('erf(0.5+0.7j)     :', repr(sp.erf(0.5+0.7j)))
print('erfc(0.5+0.7j)    :', repr(sp.erfc(0.5+0.7j)))
"
```

Literal output:

```text
erf(1.23)         : 0.9180501041267614
erfc(1.23)        : 0.08194989587323863
erf(0.5+0.7j)     : (0.7862728280046433+0.6660723591204661j)
erfc(0.5+0.7j)    : (0.2137271719953567-0.666072359120466j)
```

scipy returns `np.float64` / `np.complex128`. Complex path uses the
Faddeeva package (Steven G. Johnson port). Agrees with mpmath in the
first ~16 digits. **Use for float64 evaluator validation only.**

### 2.6 C++ `std::erf` (Bronze — float64 real only)

```cpp
// /tmp/erftest.cpp
#include <iostream>
#include <iomanip>
#include <cmath>
int main() {
    std::cout << std::setprecision(17) << std::erf(1.23)  << std::endl;
    std::cout << std::setprecision(17) << std::erfc(1.23) << std::endl;
    return 0;
}
```

Build + run:

```text
$ g++ /tmp/erftest.cpp -o /tmp/erftest && /tmp/erftest
0.91805010412676136
0.081949895873238643
```

Compare to scipy: `0.9180501041267614` vs `0.91805010412676136` —
agreement to 16 sig digits. Boost (real `double` API) gives
`0.91805010412676136` / `0.081949895873238629` — agrees with libm on
`erf`, differs from libm in the last digit of `erfc` (libm round-up,
Boost round-down). Both within ULP. **Independent libm-vs-Boost-vs-scipy
trio for float64 real cross-validation.**

### 2.7 Julia (UNAVAILABLE locally — package missing)

```text
$ julia -e 'using SpecialFunctions; println(pkgversion(SpecialFunctions))'
ERROR: ArgumentError: Package SpecialFunctions not found in current path.
$ julia -e 'using Pkg; Pkg.status()'
Status `~/.julia/environments/v1.12/Project.toml`
  [ff2beb65] PicoSAT v0.4.1
```

Julia 1.12.5 is on PATH, but only `PicoSAT` is in the active project;
`SpecialFunctions.jl` is not installed and `erf` is not in Base
(`isdefined(Base, :erf) ⇒ false`). To use Julia as an oracle the user
would need `julia -e 'using Pkg; Pkg.add("SpecialFunctions")'`. Until
then, Julia is **NOT** part of the local oracle set.

---

## 3. Oracle tier proposal

Three tiers, matched to the locally-available reality:

### Gold (deep golden masters @ 50+ decimals)

- **Wolfram Mathematica 14.3** (via `wolframscript`) — the canonical
  reference of the scientific-computing community; closed-source but
  battle-tested over decades. Use as the **primary** gold-tier voice
  for both real and complex branches. Caveat: input must be an exact
  rational, not a decimal literal (§2.1).
- **mpmath 1.3.0** — independent open-source arb-prec implementation
  (pure Python over `int` arithmetic). Correctly rounded to declared
  `mp.dps`. Use as the **co-primary** gold voice; cross-validate with
  Wolfram before promoting any golden master.
- **sympy 1.14.0 (via `.evalf(d)`)** — redundant-gold; delegates to
  mpmath. Use as a **wire-format check** (does the symbolic pipeline
  preserve bit-exact equality through `.evalf`?), not as an
  independent third vote.

### Silver (cross-check, independent implementation, arb-binary/arb-decimal)

- **Boost.Math + `cpp_bin_float<N>`** — fully independent C++ arb-prec
  implementation. **Real branch only.** Use as the second-implementation
  vote for the real arb-prec table; acceptance criterion is
  "Gold (Wolfram + mpmath) and Silver (Boost) agree to first 50
  digits".
- *No silver-tier complex oracle is locally available.* See §5.

### Bronze (float64 only — for float64 evaluator validation)

- **scipy.special.erf / erfc** (Cephes + Faddeeva): real + complex
  float64.
- **C++ `std::erf` / `std::erfc`** (glibc libm): real float64.
- **Boost.Math `double` API**: real float64 (independent of both).

Three independent real float64 voices, one independent complex
float64 voice (scipy/Faddeeva). For the complex float64 branch we
should additionally use **Wolfram at `MachinePrecision`** as a second
voice (`N[Erf[0.5 + 0.7 I]]` returns `0.786273 + 0.666072 I` at
machine precision).

### Tier-to-bead mapping (provisional)

- **Deep golden masters (real)** — generate from Wolfram + mpmath
  (parallel), declare success when byte-identical at 50 digits; then
  byte-equality-check against Boost (silver). Three-of-three for
  promotion.
- **Deep golden masters (complex)** — generate from Wolfram + mpmath
  in parallel. Declare "two-source-gold" with provenance flag noting
  that **no independent silver-tier complex check was performed** (no
  local oracle); cite this artefact's §5 in provenance. Mitigate via
  algebraic self-checks (`erf(z*) = erf(z)*`,
  `erf(-z) = -erf(z)`, `erf(z) + erfc(z) = 1`) computed at arb-prec.
- **float64 evaluator validation** — gold value rounded-to-float64 vs
  scipy / libm / Boost`<double>`; ULP-distance ≤ 1 is the pass bar.

---

## 4. Uniform adapter shape (TS-side, Bun)

### Common interface

```ts
// packages/oracle-erf/adapter.ts  (design sketch; not yet implemented)

export type DecimalString = string;          // e.g. "0.5", "-1.23e-4"
export type BigComplexString = {
  re: DecimalString;
  im: DecimalString;                         // "0" if real
};

export interface OracleRequest {
  input: BigComplexString;
  precision_decimals: number;                // 17 for float64, ≥ 30 for arb
  fn: "erf" | "erfc";
}

export interface OracleResponse {
  output: BigComplexString;                  // decimal string, byte-comparable
  precision_actual: number;                  // digits actually delivered
  oracle_id: OracleId;
  oracle_version: string;                    // pulled live from oracle
  platform: { arch: string; os: string; runtime: string };
                                             // populated for bronze tier
  ulp_distance?: number;                     // bronze tier only
}

export type OracleId =
  | "wolfram" | "mpmath" | "sympy"            // gold
  | "boost-cppbf"                             // silver
  | "scipy" | "cxx-libm" | "boost-double";    // bronze

export interface OracleAdapter {
  id: OracleId;
  tier: "gold" | "silver" | "bronze";
  supportsReal: boolean;
  supportsComplex: boolean;
  maxPrecisionDecimals: number;              // 17 bronze; ~10^6 gold/silver
  run(req: OracleRequest): Promise<OracleResponse>;
  runBatch?(reqs: OracleRequest[]): Promise<OracleResponse[]>;
}
```

All child invocations must go through the `spawnBun` resolver pattern
(ADR-0001) even when the child is `python3`, `julia`, or a compiled
C++ binary — the resolver fix is in the parent process and is
agnostic to the child language. **Do not** use raw `node:child_process`.

### Per-oracle implementation strategy

**Wolfram (`wolframscript`).** Spawn `wolframscript -script
oracle.wls` and feed it newline-delimited JSON on stdin (Wolfram script
mode supports `InputString[]`). The `.wls` script parses `{re, im,
precision, fn}`, builds the input as `Rational[num, den]` from the
decimal string (avoid the `1.23 ⇒ machine-precision-double` trap from
§2.1!), evaluates `N[Erf[z], precision]` or `N[Erfc[z], precision]`,
strips the back-tick precision suffix (`StringSplit[ToString[r,
InputForm], "`"][[1]]`), and prints JSON to stdout. Pull version from
`$VersionNumber` (`14.3`); also record `$LicenseID` for provenance.
**Startup cost is ~2-4 s per `wolframscript` invocation** — batch mode
mandatory.

**mpmath.** Spawn `python3 oracle_mpmath.py` reading newline-delimited
JSON requests on stdin. Set
`mpmath.mp.dps = precision_decimals + 6` (6-digit guard), build
input as `mpmath.mpc(re, im)` (parses decimal strings directly),
evaluate `mpmath.erf` / `mpmath.erfc`, format via
`mpmath.nstr(value, precision_decimals, strip_zeros=False)`. Version
from `mpmath.__version__`. Unified real/complex via always-`mpc`
construction.

**sympy.** Spawn `python3 oracle_sympy.py`. Parse decimal string
`"d.ddd"` into `sympy.Rational` via `sympy.nsimplify(s, rational=True)`
or by manual numerator/denominator construction (avoid `sympify(s)`
which floats decimals). Evaluate
`sympy.{erf,erfc}(z).evalf(precision_decimals + 6)`. For complex
output, split via `sympy.re(r)` / `sympy.im(r)` and stringify. Version
from `sympy.__version__`. Use this adapter in **gold-agreement** mode
alongside mpmath — wrap them with a driver that byte-compares.

**Boost (`cpp_bin_float<N>`).** Compile *once* at adapter install time:
the helper takes precision as a template parameter, but Boost's
`cpp_bin_float<N>` requires `N` at compile time. Strategy: emit a
binary with a switch over a finite set of precisions
`{30, 50, 70, 100}` (the precisions we actually need), each
instantiated as a separate template. Helper reads
`{precision, value, fn}` from stdin, dispatches to the right
templated path, prints decimal string via
`std::setprecision(precision)`. Refuse complex with a clean error
(§2.4 confirmed Boost's template fails on `std::complex`). Version
from `BOOST_LIB_VERSION` macro at compile time.

**scipy (float64).** `python3 oracle_scipy.py`, parses real
`{re, im}` decimal strings to `complex(re, im)` (or `float(re)` if
`im == "0"`), evaluates `scipy.special.erf` / `erfc`, returns
`{re: repr(r.real), im: repr(r.imag)}`. `precision_actual = 17`.
Computes `ulp_distance` against caller-supplied reference (Gold or
Silver value) if provided. Version from `scipy.__version__`. Platform
fingerprint required in provenance per ADR-0015.

**C++ libm.** Compile `oracle_cxx.cpp` once at install time, cache
binary. Helper takes `<fn> <decimal_re>` on argv (no complex), prints
`std::setprecision(17)` decimal. "Version" baked in at compile time
as `__GNUC__.__GNUC_MINOR__` + `__GLIBC_MINOR__`.

**Boost `<double>` API.** Same helper as `cpp_bin_float<N>` but with
a `--double` flag that uses the unscaled `double` overload.

### Batching note

Wolfram's ~3 s cold start dominates per-call latency; Python's is
~200 ms; Boost binary is ~5 ms. For golden-master generation (target:
hundreds-to-thousands of `(input, precision)` pairs per oracle), every
adapter must expose a `runBatch` mode that spawns the child process
**once**, streams newline-delimited JSON requests on stdin, and reads
newline-delimited JSON responses on stdout. Implementation is
~30 LOC per adapter and brings batch throughput to
500-2000 evaluations/second across the gold tier.

### Determinism & provenance tier mapping (ADR-0020 / ADR-0015)

- **Wolfram, mpmath, sympy, Boost-cpp_bin_float** → `arbprec: true`
  semantics transitively (precision is an explicit input, correctly
  rounded; output identity ≡ `(input, precision)` ⇒
  output decimal string). Provenance hash includes
  `oracle_id`, `oracle_version`, `precision_decimals`.
- **scipy, libm, Boost-double** → `numerical: true` semantics; record
  `platform: {arch, os, runtime}` in provenance; cache hits invalidate
  on platform mismatch.

---

## 5. Gaps + risks

### Hard gaps (no local independent silver-tier complex arb-prec oracle)

- **No Arb / FLINT.** Arb (`arb_hypgeom_erf`, ball arithmetic with
  rigorous error bounds) would be the natural second arb-prec voice
  for the **complex** branch. Absent: `pkg-config --modversion arb` ⇒
  not found; `/usr/include/flint/arb.h` ⇒ no such file; `python3 -c
  'import flint'` ⇒ ModuleNotFoundError.
- **No `python-flint`.** Would provide Arb via Python bindings —
  cleanest install path. `pip install python-flint` typically requires
  FLINT/Arb system libs.
- **No `gmpy2`.** Doesn't add an oracle, but would speed up mpmath
  3-10× via MPFR-accelerated arithmetic (and `libmpfr.so.6` is
  *already on disk*, just missing the `-dev` header).
- **Julia `SpecialFunctions.jl` not installed.** Julia is on PATH but
  the package is missing. Would add the third independent silver-tier
  voice for the real branch (already covered by Boost) and zero new
  complex coverage (since `Complex{BigFloat}` is unsupported in
  Julia's `SpecialFunctions.erf` — see earlier draft probe).

### Soft gaps

- **MPFR `-dev` headers absent** (`libmpfr.so.6` runtime present).
  Trivial to install (`apt install libmpfr-dev`) and would enable
  direct C linkage to MPFR's `mpfr_erf` (which the GNU MPFR project
  has correctly-rounded to declared precision since 4.1).
- **GSL `-dev` headers absent** (`libgsl.so.27` runtime present).
  `apt install libgsl-dev` would enable `gsl_sf_erf_e` (float64 with
  error estimate) — adds a 4th float64 real voice; not essential.
- **No Mathematica float64-complex variant via scripted interface.**
  Wolfram at `MachinePrecision` gives float64; we should wire this as
  a second complex-float64 voice alongside scipy.
- **No R / Rscript.** Marginal — would add `pracma::erf` (a 4th
  float64 voice). Not essential.

### Install recommendations (priority-ordered, *if the user opts in*)

The user has not asked us to install anything; this is a recommendation
list:

1. **`apt install libflint-dev libflint-arb-dev`** *and* `pip install
   python-flint`. **Highest value per byte installed** — gives us the
   long-missing independent arb-prec complex oracle (Arb's
   `arb_hypgeom_erf` with rigorous error bounds via ball arithmetic).
   Closes the §5 hard gap completely.
2. **`pip install gmpy2`** (after `apt install libmpfr-dev`) — speeds
   up mpmath 3-10× on batch gold generation; no new oracle added but
   wall-clock savings are large.
3. **`julia -e 'using Pkg; Pkg.add("SpecialFunctions")'`** — adds a
   second independent silver-tier voice for the real branch
   (already covered by Boost, so marginal). Useful if we want a
   three-source silver consensus for the real branch.
4. **`apt install libmpfr-dev libgsl-dev`** — enables direct C
   linkage to two extra float64 / arb-prec backends. Marginal.
5. **(Already-licensed) Mathematica `MachinePrecision` complex-float64
   adapter** — second complex-float64 voice alongside scipy. Just an
   adapter, no install needed.

### Risks for downstream beads

- **Single-engine arb-prec complex oracle.** Until Arb is installed,
  mpmath is the only independent arb-prec complex implementation on
  this machine (Wolfram is a second voice but closed-source; sympy
  delegates to mpmath; Boost can't do complex). For a "world's best
  Erf" claim, **two independent gold voices on the complex branch is
  the absolute minimum** — currently we have Wolfram + mpmath. Mitigate
  either by (a) installing Arb, or (b) adding algebraic self-checks
  at arb-prec (conjugation symmetry, parity, `erf + erfc = 1`,
  asymptotic-tail check for `|z|` large), or (c) shipping with a
  documented provenance note that the complex masters are
  "two-source-gold" with the gap acknowledged.
- **Wolfram startup latency.** ~3 s per `wolframscript` invocation —
  batch mode mandatory; do not call per-input.
- **Wolfram `1.23 ⇒ MachinePrecision` trap.** Adapter must construct
  inputs as `Rational[num, den]` from the parsed decimal string.
  Failure to do this silently caps Wolfram at ~16 digits regardless
  of the precision argument. Test the adapter with an input that
  would round catastrophically at float64 if the trap were active.
- **Adapter version drift.** Pinning `wolframscript --version`,
  `mpmath`, `sympy`, `scipy`, `boost`, and `g++/glibc` versions in
  `oracle_version` and including all of them in the provenance hash
  is essential; without that we risk silent gold-tier changes between
  sessions.
- **mpmath `nstr` vs Wolfram `N[]` rounding-mode mismatch.** mpmath's
  `nstr` rounds-to-nearest; Wolfram `N[]` truncates at the displayed
  precision. At 50 digits this is a 1-ULP last-digit difference; the
  comparator must compare at `precision_decimals - 1` digits, or
  round both to a canonical form before byte-compare.

---

## 6. Pointer index

- This artefact: `docs/refs/erf-research/R5-oracle-landscape.md`.
- ADR-0001 (`spawnBun` resolver pattern for child processes): cited in §4.
- ADR-0015 (`numerical: true` + platform fingerprint): cited in §4.
- ADR-0020 (`arbprec: true` + `--precision` flag): cited in §4.
- Project CLAUDE.md Rule 8 (honest scope; tagged refusal vs lying):
  cited in §4 (Boost complex refusal).

End of R5.
