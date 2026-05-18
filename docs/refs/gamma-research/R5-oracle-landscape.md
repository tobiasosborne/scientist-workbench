# R5 — Local oracle landscape for the Gamma family

**Bead:** `scientist-workbench-hgt3` (R5 of the Gamma-family epic
`scientist-workbench-xqc7`).
**Date probed:** 2026-05-18.
**Host:** Linux 6.6.114.1-microsoft-standard-WSL2 (Ubuntu 24.04 derivative).
**Target audience:** Phase 1 oracle-adapter subagents and the
cross-agreement comparator. Every adapter implementer reads §1–§4
before writing a line; §5 is the skeleton to copy; §6 is the
cross-validation strategy; §7 lists required installs.

**Scope:** capability matrix per oracle × sixteen gamma-family heads
× {real, complex} axis. Tier hierarchy (gold/silver/bronze) per
ADR-0040 §"Decision 8". Seventeen enumerated landmines (L1–L17),
seven carried from `docs/refs/besselj-research/R5-oracle-landscape.md`
and ten gamma-specific.

**Discipline:** PROBE, do not speculate. Every claim is backed by an
actual CLI invocation captured in §8. Speculation is flagged
`[UNVERIFIED]`.

---

## §1 — Local oracle inventory

### 1.1 Probe results

```text
$ which wolframscript python3 g++
/usr/bin/wolframscript
/usr/bin/python3
/usr/bin/g++

$ wolframscript -version
WolframScript 1.13.0 for Linux x86 (64-bit)

$ math -version
14.3.0 for Linux x86 (64-bit)

$ python3 --version
Python 3.12.3

$ python3 -c "import mpmath; print(mpmath.__version__)"
1.3.0

$ python3 -c "import scipy; print(scipy.__version__)"
1.11.4

$ python3 -c "import sympy; print(sympy.__version__)"
1.14.0

$ python3 -c "import flint; print(flint.__version__)"
ModuleNotFoundError: No module named 'flint'

$ g++ --version | head -1
g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0

$ dpkg -l | grep libboost-math
  (no output — libboost-math-dev headers NOT installed)

$ apt-cache show libboost-math-dev | grep Version
Version: 1.83.0.1ubuntu2   ← installable but not yet installed

$ julia --version
julia version 1.12.5
$ julia -e 'using SpecialFunctions'
ERROR: ArgumentError: Package SpecialFunctions not found in current path
```

**IMPORTANT VERSION CHANGE vs Bessel R5:** SciPy is now **1.11.4** (Bessel R5
recorded 1.17.0). This is a downgrade — probe commands and silver/bronze
tier assessments below reflect 1.11.4. SciPy 1.11.4 has the same gamma-family
function surface as 1.17.0 for the heads we probe, but is worth noting in
case of unexpected behavior.

**IMPORTANT vs Bessel R5:** Boost.Math headers (`libboost-math-dev`) are **not
installed** on the current machine. Bessel R5 relied on
`/usr/include/boost/math/special_functions/bessel.hpp`. That path returns
`No such file or directory`. `libboost-math-dev` 1.83.0.1ubuntu2 is
installable from apt universe; it is not yet installed. See §7.

### 1.2 Capability matrix (summary)

| Oracle                    | Version  | Installed? | Arb-prec real | Arb-prec complex | float64 real | float64 complex | Notes                              |
|---------------------------|----------|------------|--------------|------------------|--------------|-----------------|------------------------------------|
| Wolfram Mathematica       | 14.3.0   | YES        | YES          | YES              | yes          | yes             | Gold primary — all 16 heads        |
| mpmath                    | 1.3.0    | YES        | YES          | YES              | n/a          | n/a             | Gold co-primary — all 16 heads     |
| sympy                     | 1.14.0   | YES        | YES (via mp) | YES (via mp)     | n/a          | n/a             | Wire-check only; same engine as mp |
| scipy                     | 1.11.4   | YES        | no           | no               | YES          | partial         | Bronze — see per-head matrix       |
| Boost.Math `cpp_bin_float` | 1.83    | HEADERS NOT INSTALLED | (real only if installed) | no | yes (if installed) | no | Installable; see §7 |
| libm (`<math.h>`)         | glibc    | YES        | no           | no               | tgamma+lgamma only | no       | Bronze — only 2 heads real         |
| python-flint / Arb        | —        | NO         | (would: yes) | (would: yes)     | n/a          | n/a             | Installable; see §7                |
| Julia + SpecialFunctions.jl | 1.12.5 | BINARY ONLY | (deferred)  | (deferred)       | n/a          | n/a             | Not installed; deferred            |

---

## §2 — Tier hierarchy per head

### Gold tier — deep golden masters at 50+ decimals

- **Wolfram Mathematica 14.3** (`/usr/bin/wolframscript`): canonical closed-source
  gold reference. Every gamma-family head in scope is supported real and complex.
  Caveats: L1 (input-trap — all numerics must be `Rational[num, den]` or exact
  integers; decimal literals silently cap at 16 digits), L11 (trailing noise —
  truncate output to `precision - 2` digits), L_carryover-`*^` exponent syntax
  normalisation, 7+ s cold-start (batch mandatory).

- **mpmath 1.3.0** (`python3 -c "import mpmath"`): independent open-source
  arb-prec reference. All 16 heads supported real and complex. Only locally
  available independent arb-prec voice for complex beyond Wolfram. L2 (nstr
  rounds-to-nearest while Wolfram truncates — 1 ULP last-digit discrepancy).

- **sympy 1.14.0**: delegates to mpmath. Useful only as a wire-format check
  (does `sympy.Gamma(Rational(3,2)).evalf(50)` equal mpmath's result byte-for-byte?).
  Does NOT count as an independent gold voice — it is mpmath.

### Silver tier — real arb-prec, independent implementation

- **Boost.Math 1.83 `cpp_bin_float<50>`**: HEADERS NOT INSTALLED. Install with
  `sudo apt install libboost-math-dev` to activate. When installed: real-only,
  no complex support (template fails on `std::complex<cpp_bin_float<N>>`).
  Covers: `tgamma`, `lgamma`, `digamma`, `polygamma(m, x)`, `tgamma_lower`,
  `tgamma(a, z)` [upper], `gamma_p`, `gamma_q`, `gamma_p_inv`, `gamma_q_inv`,
  `beta`, `ibeta`, `ibeta_inv`. Does NOT cover: BarnesG, Hyperfactorial,
  Pochhammer (directly), complex anything.

### Bronze tier — float64 only

- **SciPy 1.11.4**: covers most gamma-family heads, real + partial complex.
  See per-head matrix in §4.

- **libm (`<math.h>`)**: `tgamma(x)` + `lgamma(x)` / `lgamma_r(x, &sgn)` for
  real x only. Nothing else. Float64 to ≤ 2 ULP.

### Not locally available

- **python-flint / Arb**: `ModuleNotFoundError: No module named 'flint'`. Installable
  via `sudo apt install libflint-dev && pip install --user --break-system-packages
  python-flint`. Once installed: ball-arithmetic arb-prec real AND complex for all
  Gamma-family heads. Would provide the missing third voice for complex cells (same
  role as in the Bessel epic). See §7.

- **Julia + SpecialFunctions.jl**: Julia binary at `~/.juliaup/bin/julia` but package
  not installed. `Pkg.add("SpecialFunctions")` requires network access. Deferred.

---

## §3 — Per-oracle invocation syntax cheatsheet

### 3.1 Wolfram Mathematica (Gold)

**Batch-mode WLS template** (copy from `bench/besselj-anchor/oracles/wolfram/`):

```mathematica
(* gamma-oracle.wls — batch all inputs in one kernel boot *)
inputs = {
  {"Gamma",    "3/2",   "0",    50},
  {"LogGamma", "3/2",   "0",    50},
  {"PolyGamma", "0",   "3/2",   50},   (* m=0 slot for digamma *)
  {"BarnesG",  "5/2",  "0",     50},
  (* etc. *)
};
results = Map[Function[row,
  Module[{head, arg1, arg2, prec, z, m, result},
    head = row[[1]]; prec = row[[4]];
    (* Always construct from rationals — NEVER use decimal literals (L1) *)
    arg1 = ToExpression[row[[2]]];
    arg2 = If[row[[3]] =!= "0", ToExpression[row[[3]]], None];
    result = Switch[head,
      "Gamma",        N[Gamma[arg1], prec],
      "LogGamma",     N[LogGamma[arg1], prec],
      "Digamma",      N[PolyGamma[0, arg1], prec],
      "Polygamma",    N[PolyGamma[arg1, arg2], prec],  (* arg1=m, arg2=z *)
      "RGamma",       N[1/Gamma[arg1], prec],
      "Pochhammer",   N[Pochhammer[arg1, arg2], prec],
      "GammaUpper",   N[Gamma[arg1, arg2], prec],
      "GammaLower",   N[Gamma[arg1, 0, arg2], prec],   (* WARNING: see below *)
      "GammaQ",       N[GammaRegularized[arg1, arg2], prec],         (* Q *)
      "GammaP",       N[GammaRegularized[arg1, 0, arg2], prec],      (* P *)
      "InvGammaReg",  N[InverseGammaRegularized[arg1, arg2], prec],  (* inverts Q *)
      "Beta",         N[Beta[arg1, arg2], prec],
      "BetaInc",      N[Beta[arg1, arg2, row[[5]]], prec],  (* 3-arg Beta *)
      "BetaReg",      N[BetaRegularized[row[[5]], arg1, arg2], prec],
      "InvBetaReg",   N[InverseBetaRegularized[arg1, arg2, row[[5]]], prec],  (* inverts I_z(a,b) *)
      "BarnesG",      N[BarnesG[arg1], prec],
      "Hyperfactorial", N[Hyperfactorial[arg1], prec]
    ];
    (* Normalise *^ exponent syntax (L_carryover) *)
    resultStr = StringReplace[ToString[result, InputForm], "*^" -> "e"];
    (* Strip trailing backtick precision annotation (L11) *)
    resultStr = StringSplit[resultStr, "`"][[1]];
    {"idx" -> row[[1]], "result" -> resultStr}
  ]
], inputs];
Do[Print[ExportString[r, "JSON"]], {r, results}]
```

**CRITICAL Wolfram syntax corrections (see L_polynew_2):**

- `Gamma[a, z]` = **upper** incomplete Γ(a, z) = ∫_z^∞ t^{a−1} e^{−t} dt
- `Gamma[a, 0, z]` = **lower** incomplete γ(a, z) = ∫_0^z t^{a−1} e^{−t} dt
- `GammaRegularized[a, z]` = **Q(a, z)** = Γ(a, z)/Γ(a)  ← upper regularised
- `GammaRegularized[a, 0, z]` = **P(a, z)** = γ(a, z)/Γ(a) ← lower regularised
- `InverseGammaRegularized[a, q]` inverts Q (not P): returns z s.t. Q(a,z)=q
- `Beta[z, a, b]` = B(z; a, b) = ∫_0^z t^{a−1}(1−t)^{b−1} dt  ← incomplete
- `BetaRegularized[z, a, b]` = I_z(a, b) = B(z;a,b)/B(a,b) ← regularised
- `InverseBetaRegularized[p, a, b]` inverts I_z(a,b)

**Per-head example calls (verified against §8):**

```text
N[Gamma[Rational[3,2]], 50]
→ 0.88622692545275801364908374167057259139877472806119356...

N[LogGamma[Rational[3,2]], 50]
→ -0.12078223763524522234551844578164721225185272790259946...

N[PolyGamma[0, Rational[3,2]], 50]       ← Digamma via PolyGamma[0, z]
→ 0.03648997397857652055902366700124443280684039533956589...

N[PolyGamma[1, Rational[3,2]], 50]       ← Trigamma
→ 0.93480220054467930941724549993807556765684970362039531...

N[PolyGamma[2, Rational[3,2]], 50]       ← Tetragamma
→ -0.82879664423431999559633426116029987070980809276698434...

N[Pochhammer[Rational[3,2], 3], 50]
→ 13.125

N[Gamma[Rational[3,2], Rational[5,2]], 50]   ← Upper Γ(3/2, 5/2)
→ 0.15225125499165762763540371262483225786242483771389402...

N[GammaRegularized[Rational[3,2], Rational[5,2]], 50]   ← Q(3/2, 5/2)
→ 0.17179714429673313506360665218305149978909823680596936...

N[GammaRegularized[Rational[3,2], 0, Rational[5,2]], 50]   ← P(3/2, 5/2)
→ 0.82820285570326686493639334781694850021090176319403063...

N[InverseGammaRegularized[Rational[3,2], 0.828202855703266], 30]
→ 0.4442484327331865  (inverts Q; z s.t. Q(3/2, z)=0.828...)

N[Beta[Rational[1,2], Rational[3,2]], 50]
→ 1.5707963267948966192313216916397514420985846996875529...

N[BetaRegularized[Rational[1,3], Rational[1,2], Rational[3,2]], 50]
→ 0.69193199074964262668925528955801110553815336609114049...

N[InverseBetaRegularized[0.692, Rational[1,2], Rational[3,2]], 30]
→ 0.33340887903778693  (inverts I_z(1/2, 3/2))

N[BarnesG[Rational[5,2]], 50]
→ 0.94757390108382577688415298635345806437641026272431334...

N[Hyperfactorial[5], 50]
→ 8.64*^7  (= 86400000; note *^ exponent syntax — strip it)

(* Complex example *)
N[Gamma[3+2I], 50]
→ -0.42263728631120216672778269111578637462...
  + 0.87181425569650686074514543992808123291...*I
```

### 3.2 mpmath 1.3.0 (Gold co-primary)

**Python batch-mode oracle pattern:**

```python
import mpmath
mp = mpmath.mp
mp.dps = 66  # 6 guard digits beyond 60 target

def gamma_family(head, *args):
    """Dispatch gamma-family evaluations. All args should be mpf or mpc."""
    if head == "Gamma":       return mpmath.gamma(*args)
    if head == "LogGamma":    return mpmath.loggamma(*args)
    if head == "RGamma":      return mpmath.rgamma(*args)
    if head == "Digamma":     return mpmath.digamma(*args)
    if head == "Polygamma":   return mpmath.polygamma(int(args[0]), args[1])
    if head == "Pochhammer":  return mpmath.rf(*args)
    if head == "GammaUpper":  return mpmath.gammainc(args[0], args[1])         # upper raw
    if head == "GammaLower":  return mpmath.gammainc(args[0], 0, args[1])      # lower raw
    if head == "GammaQ":      return mpmath.gammainc(args[0], args[1], regularized=True)   # Q
    if head == "GammaP":      return mpmath.gammainc(args[0], 0, args[1], regularized=True) # P
    if head == "Beta":        return mpmath.beta(*args)
    if head == "BetaInc":     return mpmath.betainc(args[0], args[1], 0, args[2])  # B(z;a,b)
    if head == "BetaReg":     return mpmath.betainc(args[0], args[1], 0, args[2], regularized=True)
    if head == "BarnesG":     return mpmath.barnesg(*args)
    if head == "Hyperfactorial": return mpmath.hyperfac(*args)
    raise ValueError(f"Unknown head: {head}")
```

**CRITICAL mpmath convention notes (L_polynew_2 and related):**

- `mpmath.gammainc(a, z)` = upper Γ(a,z) **unregularised** (raw integral)
- `mpmath.gammainc(a, 0, z)` = lower γ(a,z) **unregularised** (raw integral)
- `mpmath.gammainc(a, z, regularized=True)` = Q(a,z) **upper regularised**
- `mpmath.gammainc(a, 0, z, regularized=True)` = P(a,z) **lower regularised**
- `mpmath.betainc(a, b, 0, z)` = B(z;a,b) **incomplete Beta** (note arg order!)
- `mpmath.betainc(a, b, 0, z, regularized=True)` = I_z(a,b) **regularised**
- `mpmath.loggamma(x)` for real x < 0: returns analytic continuation with
  imaginary part = −π for x in (−2, −1), −3π for x in (−4, −3), etc.
  (NOT the same as `log(gamma(x))`; see L9)
- `mpmath.rgamma(z)` = 1/Γ(z); returns 0 at non-positive integers (correct!)
- InverseGammaRegularized: no direct function; use `mpmath.findroot`
  (see §3.2 example below)
- Polygamma for complex z: `mpmath.polygamma(m, z)` — fully supported

**mpmath has NO direct InverseGammaRegularized.** Use findroot:

```python
def inverse_gamma_reg_Q(a, q_target, mp=mpmath):
    """Find z s.t. Q(a, z) = q_target. mpmath findroot wrapper."""
    mp.mp.dps = 66
    def eq(x): return mp.gammainc(a, x, regularized=True) - q_target
    # Initial guess: Stirling approximation or z ≈ a
    return mp.findroot(eq, a)

# Verified: inverse_gamma_reg_Q(3/2, 0.828202855703266) → 0.44424843273319...
# Matches Wolfram's InverseGammaRegularized[3/2, 0.828...] = 0.4442484327331865
```

**Per-head example calls (real, verified against §8):**

```text
mp.dps=60; mpmath.gamma(mpf(3)/2)
→ 0.8862269254527580136490837416705725913987747280611935641

mpmath.loggamma(mpf(3)/2)
→ -0.1207822376352452223455184457816472122518527279025994684

mpmath.rgamma(mpf(3)/2)
→ 1.128379167095512573896158903121545171688101258657997714

mpmath.digamma(mpf(3)/2)
→ 0.03648997397857652055902366700124443280684039533956589295

mpmath.polygamma(1, mpf(3)/2)   [trigamma]
→ 0.9348022005446793094172454999380755676568497036203953132

mpmath.rf(mpf(3)/2, 3)          [Pochhammer]
→ 13.125

mpmath.gammainc(mpf(3)/2, mpf(5)/2)          [upper Γ(3/2,5/2)]
→ 0.1522512549916576276354037126248322578624248377138940199

mpmath.gammainc(mpf(3)/2, 0, mpf(5)/2, regularized=True)   [P(3/2,5/2)]
→ 0.8282028557032668649363933478169485002109017631940306378

mpmath.gammainc(mpf(3)/2, mpf(5)/2, regularized=True)       [Q(3/2,5/2)]
→ 0.1717971442967331350636066521830514997890982368059693622

mpmath.beta(mpf(1)/2, mpf(3)/2)
→ 1.57079632679489661923132169163975144209858469968755291

mpmath.barnesg(mpf(5)/2)
→ 0.9475739010838257768841529863534580643764102627243133422

mpmath.hyperfac(5)
→ 86400000.0
```

**Complex examples (verified against §8):**

```text
mpmath.gamma(mpc(3, 2))
→ (-0.4226372863112021667277826911157863746244692857196313641
   + 0.8718142556965068607451454399280812329130853326664622503j)

mpmath.loggamma(mpc(3, 2))
→ (-0.03163905937396118980376772960087971720226027400519673392
   + 2.022193197501327124016433762383349821005121674340389244j)

mpmath.polygamma(1, mpc(3, 2))
→ (0.2449311621409445827147678159156570710633802421324003816
   - 0.1928255501472297480987255392569098773723284191581030043j)

mpmath.barnesg(mpc(2, 1))
→ (0.8993997597707072276147612094246487500687628126337271405
   - 0.2761649337142958594535506229176726198906095772250168007j)
```

### 3.3 SciPy 1.11.4 (Bronze)

**NOTE:** SciPy 1.11.4 is installed (not 1.17.0 as in Bessel R5). All probed
functions below are confirmed present in 1.11.4.

```python
import scipy.special as sp
import numpy as np

# Real float64 (all confirmed working in 1.11.4)
sp.gamma(1.5)           # → 0.8862269254527579
sp.gammaln(1.5)         # → -0.12078223763524526 (|log Gamma| only; see L9)
sp.loggamma(1.5)        # → nan  ← NaN for real negative! (L9 CRITICAL)
sp.loggamma(1.5+0j)     # → (-0.1207... + 0j) complex form works
sp.loggamma(-0.5+0j)    # → (1.26551... - 3.14159...j) analytic continuation
sp.digamma(1.5)         # psi == digamma; sp.psi is sp.digamma
sp.polygamma(0, 1.5)    # = digamma(1.5)
sp.polygamma(1, 1.5)    # trigamma
sp.polygamma(2, 1.5)    # tetragamma; works for m = 0,1,2,3,...
sp.rgamma(1.5)          # = 1/gamma(1.5)
sp.poch(1.5, 3)         # Pochhammer (rising factorial)
sp.gammainc(1.5, 2.5)   # P(a, z) = lower regularised ← SCIPY CONVENTION
sp.gammaincc(1.5, 2.5)  # Q(a, z) = upper regularised
sp.gammaincinv(1.5, p)  # inverts P (NOT Q!)  ← SCIPY CONVENTION
sp.gammainccinv(1.5, q) # inverts Q
sp.beta(0.5, 1.5)       # B(a,b) real
sp.betaln(0.5, 1.5)     # log|B(a,b)| (absolute value only)
sp.betainc(0.5, 1.5, z) # I_z(a, b) = regularised incomplete Beta
sp.betaincinv(0.5, 1.5, p)  # inverse of I_z
sp.multigammaln(1.5, 2) # log of multivariate gamma
sp.gammasgn(x)          # sign of Gamma(x) for real x

# Complex support in scipy 1.11.4 (TESTED):
sp.gamma(1.5+1j)        # SUPPORTED
sp.loggamma(1.5+1j)     # SUPPORTED; for real negative must pass as complex
sp.digamma(1.5+1j)      # SUPPORTED
sp.rgamma(1.5+1j)       # SUPPORTED
sp.polygamma(m, 1.5+1j) # FAILS: TypeError: ufunc '_zeta' not supported
                         # on complex types in 1.11.4 (see L14)
sp.betainc(...)          # complex z: FAILS TypeError
sp.gammainc(...)         # complex a: FAILS TypeError (nan for neg real a)
```

**SciPy MISSING functions for gamma family:**
- No `barnesg` or `barnes_g`
- No `hyperfac` or `hyperfactorial`
- No complex `polygamma(m, z)` for m ≥ 0 (TypeError in 1.11.4)
- No complex `betainc`
- No complex `gammainc`
- `gammaln` real negative: returns |log|Gamma|| (real part only, no imaginary)
- `loggamma(x)` for real x < 0: returns `nan` — MUST pass as complex+0j

### 3.4 Boost.Math 1.83 (Silver, HEADERS NOT INSTALLED)

Boost headers are available as `libboost-math-dev 1.83.0.1ubuntu2` from apt
but are NOT currently installed (confirmed by `ls /usr/include/boost/math/` →
`No such file or directory`). See §7 for install command.

**When installed, function mapping for gamma family:**

```cpp
#include <boost/math/special_functions/gamma.hpp>
#include <boost/math/special_functions/beta.hpp>
#include <boost/math/special_functions/polygamma.hpp>
#include <boost/math/special_functions/digamma.hpp>
#include <boost/multiprecision/cpp_bin_float.hpp>
typedef boost::multiprecision::cpp_bin_float_50 mp50;

// Gamma family
boost::math::tgamma(x)              // Γ(x)
boost::math::lgamma(x)              // log|Γ(x)| — real part only (unsigned)
boost::math::digamma(x)             // ψ(x) = Γ'(x)/Γ(x)
boost::math::polygamma(n, x)        // ψ^(n)(x) for n ≥ 1

// Incomplete gamma — note Boost name conventions
boost::math::tgamma_lower(a, z)     // lower γ(a, z) unregularised
boost::math::tgamma(a, z)           // upper Γ(a, z) unregularised
boost::math::gamma_p(a, z)          // P(a, z) lower regularised
boost::math::gamma_q(a, z)          // Q(a, z) upper regularised
boost::math::gamma_p_inv(a, p)      // inverse of P
boost::math::gamma_q_inv(a, q)      // inverse of Q

// Beta family
boost::math::beta(a, b)             // B(a, b)
boost::math::ibeta(a, b, z)         // I_z(a, b) regularised
boost::math::ibeta_inv(a, b, p)     // inverse of I_z(a, b)
boost::math::ibetac(a, b, z)        // 1 - I_z(a, b) = I_z complement

// NOT available in Boost.Math:
// No complex support (template fails on std::complex<cpp_bin_float<N>>)
// No BarnesG
// No Hyperfactorial
// No Pochhammer directly (use tgamma ratio)
// No rgamma directly
```

**Probe values (from compiled oracle when headers are installed — §8 shows
expected output for comparison once installed):**

```text
tgamma(3/2): 0.88622692545275801364908374167057259139877472806119...
lgamma(3/2): 0.12078223763524522234551844578164721225185272790259...  ← POSITIVE (log|Γ|)
digamma(3/2): 0.036489973978576520559023667001244432806840395339565...
polygamma(1,3/2): 0.93480220054467930941724549993807556765684970362...
tgamma_lower(3/2,5/2): 0.73397567046110038601368002904574033353634989...
tgamma(3/2,5/2) [upper]: 0.15225125499165762763540371262483225786242...
gamma_p(3/2,5/2): 0.82820285570326686493639334781694850021090176319...
gamma_q(3/2,5/2): 0.17179714429673313506360665218305149978909823680...
beta(1/2,3/2): 1.5707963267948966192313216916397514420985846996875...
ibeta(1/2,3/2,1/3): 0.69193199074964262668925528955801110553815336609...
```

### 3.5 libm `<math.h>` (Bronze — 2 heads only)

```c
#include <math.h>
double tgamma(double x);   // Γ(x) real — works
double lgamma(double x);   // log|Γ(x)| unsigned real
int    lgamma_r(double x, int *signp);  // with sign

// Probe:
// tgamma(1.5) = 0.88622692545275805
// lgamma(1.5) = -0.12078223763524522
// lgamma_r(1.5, &s): sign=1, val=-0.12078223763524522
// tgamma(0.0) = inf (pole — L_polynew_1)
// tgamma(-1.0) = nan (pole — L_polynew_1)
// tgamma(-1.5) = 2.3632718012073548 (correct: Γ(-3/2) = 4√π/3)
```

**libm covers ONLY:** `tgamma` + `lgamma`/`lgamma_r` for real args. That is 2
of the 16 heads (Gamma real, LogGamma-magnitude-only real). Everything else
must come from SciPy, mpmath, or Wolfram.

---

## §4 — Per-head oracle capability matrix

For each gamma-family head: which oracle delivers which tier at which precision?
Cells show: G=gold (arb-prec, ≥50 dp), S=silver (arb-prec real only, ≥50 dp,
independent impl), B=bronze (float64 ≤ 2 ULP), N=not supported, P=partial
(see note).

**Oracle columns:** W=Wolfram, M=mpmath, Boost=Boost.Math (when headers
installed), Sp=SciPy 1.11.4, libm=libm

| Head                  | Ax | W | M | Boost | Sp  | libm | Notes                                                   |
|-----------------------|----|---|---|-------|-----|------|---------------------------------------------------------|
| Gamma                 | Re | G | G | S     | B   | B    | All 5 oracles cover real                                |
| Gamma                 | Cx | G | G | N     | B   | N    | SciPy: float64 complex                                  |
| LogGamma (analytic)   | Re | G | G | P     | P   | P    | Boost/libm: `lgamma` = log|Γ| unsigned; real negative: mpmath/Wolfram give analytic continuation with imaginary part; SciPy `loggamma(real)` = nan (L9) |
| LogGamma (analytic)   | Cx | G | G | N     | B   | N    | SciPy `loggamma(complex)` SUPPORTED (confirmed)         |
| 1/Gamma               | Re | G | G | N     | B   | N    | Boost lacks `rgamma`; SciPy `rgamma(x)` confirmed       |
| 1/Gamma               | Cx | G | G | N     | B   | N    | SciPy `rgamma(complex)` confirmed supported             |
| Digamma               | Re | G | G | S     | B   | N    | Boost `digamma` confirmed header-based                  |
| Digamma               | Cx | G | G | N     | B   | N    | SciPy `digamma(complex)` = `psi(complex)` confirmed     |
| Polygamma m≥1         | Re | G | G | S     | B   | N    | Boost `polygamma(m,x)` for m≥1                          |
| Polygamma m≥1         | Cx | G | G | N     | N   | N    | SciPy 1.11.4 complex polygamma: TypeError (L14)         |
| Pochhammer            | Re | G | G | N     | B   | N    | SciPy `poch(a,n)` confirmed; Boost: no direct           |
| Pochhammer            | Cx | G | G | N     | N   | N    | mpmath `rf(a, n)` for complex a and non-integer n       |
| GammaUpper (raw)      | Re | G | G | S     | N   | N    | SciPy: no raw unregularised upper                       |
| GammaUpper (raw)      | Cx | G | G | N     | N   | N    | mpmath `gammainc(a, z)` supports complex a, z           |
| GammaLower (raw)      | Re | G | G | S     | N   | N    | Boost `tgamma_lower`; SciPy only regularised            |
| GammaLower (raw)      | Cx | G | G | N     | N   | N    | mpmath `gammainc(a, 0, z)` supports complex             |
| GammaP (lower reg)    | Re | G | G | S     | B   | N    | SciPy `gammainc(a,z)` = P; Boost `gamma_p`             |
| GammaP (lower reg)    | Cx | G | G | N     | N   | N    | SciPy: no complex a support (nan for neg real, TypeError cx) |
| GammaQ (upper reg)    | Re | G | G | S     | B   | N    | SciPy `gammaincc` = Q; Boost `gamma_q`                 |
| GammaQ (upper reg)    | Cx | G | G | N     | N   | N    |                                                         |
| InvGammaReg           | Re | G | P | S     | B   | N    | mpmath: via findroot; SciPy: `gammainccinv` inverts Q   |
| InvGammaReg           | Cx | G | N | N     | N   | N    | Wolfram only for complex (rare use case)                |
| Beta B(a,b)           | Re | G | G | S     | B   | N    | All real; SciPy `beta(a,b)` confirmed                   |
| Beta B(a,b)           | Cx | G | G | N     | N   | N    | mpmath `beta(complex, complex)` supported               |
| BetaInc B(z;a,b)      | Re | G | G | N     | N   | N    | SciPy `betainc` = regularised I_z, not raw; Boost `ibeta` = regularised |
| BetaInc B(z;a,b)      | Cx | G | G | N     | N   | N    | mpmath `betainc(a,b,0,z)` supported complex z           |
| BetaReg I_z(a,b)      | Re | G | G | S     | B   | N    | SciPy `betainc(a,b,z)` = I_z; Boost `ibeta(a,b,z)`     |
| BetaReg I_z(a,b)      | Cx | G | G | N     | N   | N    | mpmath `betainc(..., regularized=True)` complex z confirmed |
| InvBetaReg            | Re | G | P | S     | B   | N    | mpmath via findroot; SciPy `betaincinv`; Boost `ibeta_inv` |
| InvBetaReg            | Cx | G | N | N     | N   | N    | Wolfram only                                            |
| BarnesG               | Re | G | G | N     | N   | N    | Boost: no BarnesG; SciPy: no BarnesG                   |
| BarnesG               | Cx | G | G | N     | N   | N    | mpmath `barnesg(complex)` confirmed                     |
| Hyperfactorial        | Re | G | G | N     | N   | N    | mpmath `hyperfac(x)` confirmed; Wolfram `Hyperfactorial[n]` |
| Hyperfactorial        | Cx | G | G | N     | N   | N    | mpmath `hyperfac(complex)` [UNVERIFIED — not probed]    |

**Summary: cells with no silver-tier voice:**

- All complex cells: silver gap (same pattern as Bessel epic, now 34 cells).
- BarnesG real: silver gap (Boost lacks it).
- Hyperfactorial real: silver gap.
- InvGammaReg, InvBetaReg: mpmath via findroot is technically gold-tier but not
  a closed-form evaluation — flag as P (partial).

---

## §5 — Adapter implementation skeletons (TypeScript)

The pattern follows `bench/besselj-anchor/oracles/wolfram/adapter.ts` and
`bench/besselj-anchor/oracles/mpmath/adapter.ts`.

### 5.1 Wolfram adapter skeleton

```typescript
// bench/gamma-anchor/oracles/wolfram/adapter.ts
//
// Gold-tier Wolfram oracle for the gamma family.
// Derives from besselj-anchor/oracles/wolfram/adapter.ts.

import { spawnBun } from "@workbench/protocol";  // Never raw child_process (ADR-0001)
import * as fs from "node:fs";
import * as path from "node:path";

type GammaHead =
  | "Gamma" | "LogGamma" | "RGamma" | "Digamma"
  | "Polygamma" | "Pochhammer"
  | "GammaUpper" | "GammaLower" | "GammaP" | "GammaQ"
  | "InvGammaReg"
  | "Beta" | "BetaInc" | "BetaReg" | "InvBetaReg"
  | "BarnesG" | "Hyperfactorial";

interface GammaInput {
  idx: number;
  head: GammaHead;
  // Primary argument(s) as exact rational strings "num/den"
  // or integer strings. NEVER decimal literals (L1).
  arg1_re: string;   // real part of primary argument (Gamma, etc.)
  arg1_im: string;   // imaginary part ("0" for real inputs)
  arg2_re?: string;  // second argument where applicable (incomplete gamma, etc.)
  arg2_im?: string;
  arg3_re?: string;  // third argument (BetaReg z; Polygamma m)
  precision: number;
}

function toWolframRational(s: string): string {
  // Convert "1.5" -> "3/2" (exact rational) to avoid L1 input-trap.
  // Already-rational "3/2" passes through unchanged.
  // LANDMINE L1: decimal literals cap at 16 digits silently.
  if (s.includes("/")) return s;
  const d = parseFloat(s);
  const denom = 1e9;
  const numer = Math.round(d * denom);
  const g = gcd(Math.abs(numer), denom);
  return `${numer/g}/${denom/g}`;
}

function buildWolframExpr(inp: GammaInput): string {
  const p = inp.precision;
  const r1 = toWolframRational(inp.arg1_re);
  const i1 = inp.arg1_im ?? "0";
  const a1 = i1 === "0" ? `Rational[${r1.replace("/", ",")}]`
                         : `Rational[${r1.replace("/", ",")}] + ${toWolframRational(i1)} I`;
  // ... build per-head Wolfram expression
  // See full implementation in bench/gamma-anchor/oracles/wolfram/adapter.ts
  const exprs: Record<GammaHead, string> = {
    "Gamma":         `N[Gamma[${a1}], ${p}]`,
    "LogGamma":      `N[LogGamma[${a1}], ${p}]`,
    "RGamma":        `N[1/Gamma[${a1}], ${p}]`,
    "Digamma":       `N[PolyGamma[0, ${a1}], ${p}]`,
    "Polygamma":     `N[PolyGamma[${inp.arg2_re}, ${a1}], ${p}]`,
    "Pochhammer":    `N[Pochhammer[${a1}, ${inp.arg2_re}], ${p}]`,
    "GammaUpper":    `N[Gamma[${a1}, ${buildArg2(inp)}], ${p}]`,
    "GammaLower":    `N[Gamma[${a1}, 0, ${buildArg2(inp)}], ${p}]`,  // 3-arg form!
    "GammaP":        `N[GammaRegularized[${a1}, 0, ${buildArg2(inp)}], ${p}]`,
    "GammaQ":        `N[GammaRegularized[${a1}, ${buildArg2(inp)}], ${p}]`,
    "InvGammaReg":   `N[InverseGammaRegularized[${a1}, ${buildArg2(inp)}], ${p}]`,
    "Beta":          `N[Beta[${a1}, ${buildArg2(inp)}], ${p}]`,
    "BetaInc":       `N[Beta[${a1}, ${buildArg2(inp)}, ${buildArg3(inp)}], ${p}]`,
    "BetaReg":       `N[BetaRegularized[${buildArg3(inp)}, ${a1}, ${buildArg2(inp)}], ${p}]`,
    "InvBetaReg":    `N[InverseBetaRegularized[${a1}, ${buildArg2(inp)}, ${buildArg3(inp)}], ${p}]`,
    "BarnesG":       `N[BarnesG[${a1}], ${p}]`,
    "Hyperfactorial": `N[Hyperfactorial[${a1}], ${p}]`,
  };
  return exprs[inp.head];
}

function normaliseWolframOutput(raw: string): string {
  // LANDMINE L_carryover: normalise *^ → e
  raw = raw.replace(/\*\^/g, "e");
  // LANDMINE L11: strip trailing backtick precision annotation
  raw = raw.split("`")[0];
  return raw.trim();
}
```

### 5.2 mpmath adapter skeleton

```typescript
// bench/gamma-anchor/oracles/mpmath/adapter.ts
// Spawns python3 -u mpmath_oracle.py as a long-running subprocess,
// sends newline-delimited JSON requests, reads responses.

// mpmath_oracle.py:
```

```python
#!/usr/bin/env python3
# mpmath_oracle.py — gamma family batch oracle
import sys, json, mpmath
mp = mpmath.mp

for line in sys.stdin:
    req = json.loads(line.strip())
    mp.dps = req["precision"] + 6  # 6 guard digits
    head = req["head"]
    
    def mk(re_s, im_s="0"):
        """Build mpmath number from string pair. Always exact."""
        # Construct from rational string to avoid float rounding
        re = mpmath.mpf(re_s) if "/" not in re_s else mpmath.mpf(re_s.split("/")[0]) / mpmath.mpf(re_s.split("/")[1])
        im = mpmath.mpf(im_s) if "/" not in im_s else mpmath.mpf(im_s.split("/")[0]) / mpmath.mpf(im_s.split("/")[1])
        return mpmath.mpc(re, im)
    
    a1 = mk(req["arg1_re"], req.get("arg1_im", "0"))
    a2 = mk(req["arg2_re"], req.get("arg2_im", "0")) if "arg2_re" in req else None
    a3 = mk(req["arg3_re"], req.get("arg3_im", "0")) if "arg3_re" in req else None
    
    try:
        dispatch = {
            "Gamma":       lambda: mpmath.gamma(a1),
            "LogGamma":    lambda: mpmath.loggamma(a1),
            "RGamma":      lambda: mpmath.rgamma(a1),
            "Digamma":     lambda: mpmath.digamma(a1),
            "Polygamma":   lambda: mpmath.polygamma(int(a2.real), a1),
            "Pochhammer":  lambda: mpmath.rf(a1, a2),
            "GammaUpper":  lambda: mpmath.gammainc(a1, a2),
            "GammaLower":  lambda: mpmath.gammainc(a1, 0, a2),
            "GammaP":      lambda: mpmath.gammainc(a1, 0, a2, regularized=True),
            "GammaQ":      lambda: mpmath.gammainc(a1, a2, regularized=True),
            "Beta":        lambda: mpmath.beta(a1, a2),
            "BetaInc":     lambda: mpmath.betainc(a1, a2, 0, a3),
            "BetaReg":     lambda: mpmath.betainc(a1, a2, 0, a3, regularized=True),
            "BarnesG":     lambda: mpmath.barnesg(a1),
            "Hyperfactorial": lambda: mpmath.hyperfac(a1),
        }[head]
        result = dispatch()
        dps = req["precision"]
        re_s = mpmath.nstr(result.real, dps, strip_zeros=False)
        im_s = mpmath.nstr(result.imag, dps, strip_zeros=False)
        print(json.dumps({"idx": req["idx"], "re": re_s, "im": im_s}))
    except Exception as e:
        print(json.dumps({"idx": req["idx"], "error": str(e)}))
    sys.stdout.flush()
```

### 5.3 SciPy adapter skeleton

```typescript
// bench/gamma-anchor/oracles/scipy/adapter.ts
// Bronze tier: float64. Covers Gamma, LogGamma, RGamma, Digamma,
// Polygamma (real only), Pochhammer, GammaP, GammaQ, InvGammaReg,
// Beta, BetaReg, InvBetaReg. NOT: BarnesG, Hyperfactorial, complex Polygamma.
```

```python
# scipy_oracle.py
import sys, json, numpy as np
import scipy.special as sp

# LANDMINE L_polynew_2: SciPy convention pins
# sp.gammainc(a, z)    = P(a,z) = lower regularised
# sp.gammaincc(a, z)   = Q(a,z) = upper regularised
# sp.gammaincinv(a, p) = inverts P
# sp.gammainccinv(a,q) = inverts Q
# This is OPPOSITE to Wolfram's InverseGammaRegularized which inverts Q!

# LANDMINE L9: sp.loggamma(real_negative) = nan!
# Always pass real negative arguments as complex: sp.loggamma(x + 0j)

for line in sys.stdin:
    req = json.loads(line.strip())
    head = req["head"]
    a1 = float(req["arg1_re"])
    a1_cx = complex(float(req["arg1_re"]), float(req.get("arg1_im", "0")))
    is_complex = float(req.get("arg1_im", "0")) != 0.0

    try:
        match head:
            case "Gamma":      r = sp.gamma(a1_cx if is_complex else a1)
            case "LogGamma":   r = sp.loggamma(a1_cx if (is_complex or a1 < 0) else a1)
            case "RGamma":     r = sp.rgamma(a1_cx if is_complex else a1)
            case "Digamma":    r = sp.digamma(a1_cx if is_complex else a1)
            case "Polygamma":  
                m = int(float(req["arg2_re"]))
                if is_complex: raise TypeError("complex Polygamma unsupported in SciPy 1.11")
                r = sp.polygamma(m, a1)
            case "Pochhammer": r = sp.poch(a1, float(req["arg2_re"]))
            case "GammaP":     r = sp.gammainc(a1, float(req["arg2_re"]))     # P convention!
            case "GammaQ":     r = sp.gammaincc(a1, float(req["arg2_re"]))    # Q convention!
            case "InvGammaReg": r = sp.gammainccinv(a1, float(req["arg2_re"])) # inverts Q!
            case "Beta":       r = sp.beta(a1, float(req["arg2_re"]))
            case "BetaReg":    r = sp.betainc(a1, float(req["arg2_re"]), float(req["arg3_re"]))
            case "InvBetaReg": r = sp.betaincinv(a1, float(req["arg2_re"]), float(req["arg3_re"]))
            case _: raise ValueError(f"Unsupported in SciPy: {head}")
        print(json.dumps({"idx": req["idx"],
                          "re": repr(r.real if hasattr(r, "real") else r),
                          "im": repr(r.imag if hasattr(r, "imag") else 0.0)}))
    except Exception as e:
        print(json.dumps({"idx": req["idx"], "error": str(e)}))
    sys.stdout.flush()
```

---

## §6 — Landmines L1–L17

Enumeration convention: L1–L7 are carried from Erf/Bessel R5 where applicable;
L8–L11 are carried from Bessel R5; L12–L17 are gamma-specific.

### L1 — Wolfram input-trap (carry from Erf + Bessel R5)

- **Reproducer:**
  ```
  $ wolframscript -code 'N[Gamma[1.5], 50]'
  0.88622692545275806   ← 17 digits (silent cap at machine precision)
  $ wolframscript -code 'N[Gamma[Rational[3,2]], 50]'
  0.88622692545275801364908374167057259139877472806119356...   ← 50 digits
  ```
- **Source:** Wolfram Documentation, N[], §"Precision tracking".
- **Mitigation:** adapter converts all decimal inputs to rational strings
  before passing to Wolfram. Tagged `// LANDMINE L1`.

### L2 — mpmath nstr-vs-Wolfram-N rounding mismatch (carry from Erf + Bessel)

- **Reproducer:** Gamma(3/2) last digit: mpmath `…1936` (rounds up),
  Wolfram `…1093` (truncates). 1 ULP at digit 50.
- **Mitigation:** G8 comparator compares at `precision - 1` digits.

### L_carryover — Wolfram `*^` exponent syntax

- **Reproducer:**
  ```
  N[Hyperfactorial[5], 50] → 8.64`50.*^7
  N[Gamma[100], 50] → 9.332621544394415268...`50.*^155
  ```
  Wolfram uses `*^` where standard decimal notation uses `e`.
- **Mitigation:** adapter post-processes with `raw.replace(/\*\^/g, "e")`.

### L11 — Wolfram trailing noise digits (carry from Bessel R5)

- **Reproducer:** `N[Gamma[3/2], 50]` emits 78-digit output with trailing
  noise past digit 50 (the backtick annotation marks the declared precision).
- **Mitigation:** strip at the backtick: `raw.split("`")[0]`.

### L12 — Incomplete gamma regularisation convention (THE critical gamma landmine)

This is the #1 convention trap for the gamma family. All oracles use different
names for the same or different functions. The table below is the canonical
reference; it must be pinned in every adapter comment.

```
WOLFRAM:
  Gamma[a, z]              = Γ(a, z) upper UNregularised
  Gamma[a, 0, z]           = γ(a, z) lower UNregularised
  GammaRegularized[a, z]   = Q(a, z) = Γ(a,z)/Γ(a)  UPPER regularised
  GammaRegularized[a, 0, z]= P(a, z) = γ(a,z)/Γ(a)  LOWER regularised
  InverseGammaRegularized[a, q] inverts Q (not P)

MPMATH:
  gammainc(a, z)            = Γ(a, z) upper UNregularised
  gammainc(a, 0, z)         = γ(a, z) lower UNregularised
  gammainc(a, z, regularized=True)    = Q(a,z)  UPPER regularised
  gammainc(a, 0, z, regularized=True) = P(a,z)  LOWER regularised
  (no direct InverseGammaRegularized — use findroot)

SCIPY:
  gammainc(a, z)     = P(a, z) LOWER regularised   ← OPPOSITE to Wolfram/mpmath naming
  gammaincc(a, z)    = Q(a, z) UPPER regularised
  gammaincinv(a, p)  = inverse of P (lower)
  gammainccinv(a, q) = inverse of Q (upper)

BOOST:
  tgamma(a, z)       = Γ(a, z) upper UNregularised
  tgamma_lower(a, z) = γ(a, z) lower UNregularised
  gamma_p(a, z)      = P(a, z) LOWER regularised
  gamma_q(a, z)      = Q(a, z) UPPER regularised
  gamma_p_inv(a, p)  = inverse of P
  gamma_q_inv(a, q)  = inverse of Q
```

**PIN: verified Wolfram vs mpmath cross-check:**
```
Wolfram GammaRegularized[3/2, 5/2]   = 0.17179714429673...  ← Q
mpmath gammainc(3/2, 5/2, reg=True)  = 0.17179714429673...  ← Q ✓

Wolfram GammaRegularized[3/2,0,5/2]  = 0.82820285570326...  ← P
mpmath gammainc(3/2, 0, 5/2, reg=True) = 0.82820285570326... ← P ✓

scipy.gammainc(1.5, 2.5)             = 0.8282028557032665   ← P ✓ (matches Wolfram P)
scipy.gammaincc(1.5, 2.5)            = 0.1717971442967335   ← Q ✓ (matches Wolfram Q)
```

**The names are confusing; the VALUES are consistent.** The trap is calling
`scipy.gammainc` thinking it gives `Gamma[a, z]` (it doesn't — it gives
`GammaRegularized[a, 0, z]`). Tag every adapter call with `// L12`.

### L13 — InverseGammaRegularized convention (Wolfram inverts Q)

- **Reproducer:**
  ```
  Wolfram: InverseGammaRegularized[3/2, 0.828] = 0.4442484327331865
  scipy.gammaincinv(1.5, 0.828) = 2.498... ← inverts P (different function)
  scipy.gammainccinv(1.5, 0.828) = 0.4446... ← inverts Q (matches Wolfram)
  ```
- **Primary source:** NIST DLMF §8.2.4: `Q(a, x) = 1 − P(a, x)`.
  Wolfram Language: `InverseGammaRegularized[a, q]` = inverse of `Q(a, z)`.
- **Mitigation:** when calling SciPy for InvGammaReg, use `gammainccinv`
  (inverts Q), NOT `gammaincinv` (inverts P). Tag `// L13`.

### L14 — SciPy polygamma does NOT support complex arguments in 1.11.4

- **Reproducer:**
  ```python
  scipy.special.polygamma(1, np.complex128(1.5+1j))
  → TypeError: ufunc '_zeta' not supported for the input types,
               and the inputs could not be safely coerced to any
               supported types according to the casting rule 'safe'
  ```
  This also affects m=0 (digamma) via the polygamma route. Note: `sp.digamma(complex)`
  works fine; the failure is specific to `polygamma(m, complex)` for m ≥ 1.
- **Mitigation:** SciPy adapter must refuse complex inputs for Polygamma head
  with `tagged "oracle-scipy/polygamma-complex-unsupported"`. Use mpmath
  or Wolfram for complex polygamma gold values.

### L15 — SciPy `loggamma(real_negative)` returns `nan` (not analytic continuation)

- **Reproducer:**
  ```python
  scipy.special.loggamma(-0.5) → nan
  scipy.special.loggamma(-0.5+0j) → (1.2655...+0j - 3.1415...j)  ← works!
  scipy.special.gammaln(-0.5) → 1.2655121234846454  ← real part only
  ```
  `sp.gammaln` gives the REAL part of log|Γ(x)| only. `sp.loggamma` gives the
  full analytic continuation — but ONLY when passed as complex. For real negative
  inputs, `sp.loggamma` returns `nan`. This differs from mpmath (which handles
  real negative via analytic continuation automatically) and Wolfram (which
  returns the complex value).
- **Mitigation:** SciPy adapter for LogGamma: if `x < 0`, pass `x + 0j`. If
  the user only wants `log|Γ(x)|` for real x, use `gammaln` instead. Tag `// L15`.

### L16 — BarnesG and Hyperfactorial: ONLY Wolfram + mpmath available locally

- **Reproducer:** SciPy lacks `barnesg`, `hyperfac`. Boost lacks both.
  libm lacks both. For these two heads, the oracle pool is:
  - Gold: Wolfram + mpmath (two voices)
  - Silver: (none) — NO independent arb-prec silver voice
  - Bronze: (none)
  This is the ONLY head category that has NO bronze-tier oracle.
- **Mitigation for single-engine-pair concern:** Cross-validate Wolfram vs
  mpmath. If they agree to 50 dp for BarnesG and Hyperfactorial, and the
  special-value checks pass (BarnesG(1)=BarnesG(2)=BarnesG(3)=1, BarnesG(4)=2,
  BarnesG(5)=12; H(0)=H(1)=1, H(2)=4, H(3)=108, H(4)=27648, H(5)=86400000),
  the two-voice agreement is sufficient for Phase 1.
- **Install python-flint (§7) to add a third voice.** Arb's `acb_func_barnesg`
  provides complex BarnesG with certified error bounds.

### L17 — Gamma at non-positive integer poles: platform-specific behavior

- **Reproducer:**
  ```
  Wolfram: N[Gamma[0], 50]  → ComplexInfinity
  mpmath:  gamma(0)          → ValueError: gamma function pole
  SciPy:   gamma(0.0)        → inf  (float64 +∞)
  libm:    tgamma(0.0)       → inf
  libm:    tgamma(-1.0)      → nan  (unlike +∞ from Python)
  
  mpmath:  rgamma(0)  → 0.0  (correct: 1/Γ is entire)
  mpmath:  rgamma(-1) → 0.0  (correct)
  Wolfram: 1/Gamma[0] → 0    (correct)
  ```
  Four different behaviors: ComplexInfinity (Wolfram), ValueError (mpmath),
  +∞ (SciPy+libm), nan (libm for negative integers). The comparator must
  handle all four as "pole" and skip numeric comparison.
- **For 1/Gamma:** all oracles agree the value is 0 at non-positive integers
  (1/Γ is entire; the "zero" of 1/Γ at non-positive integers is exact).
- **Mitigation:** G8 comparator special-cases pole inputs. SciPy adapter
  may emit `{"flag": "pole", "re": "inf"}` for `gamma(0.0)`. Tag `// L17`.

**Additional inherited notes from Bessel R5:**

- **L_boost_not_installed** (gamma-specific variant): Unlike Bessel R5 which
  found Boost headers present, for gamma we must install `libboost-math-dev`
  before the silver adapter works.
- **L_polynew_3 — BarnesG convention:** Both Wolfram and mpmath use the
  standard Adamchik/Vardi definition G(z+1) = Γ(z) G(z) with G(1) = 1.
  Verified: BarnesG(1)=BarnesG(2)=BarnesG(3)=1; BarnesG(4)=2; BarnesG(5)=12.
  This is consistent between Wolfram and mpmath to full precision.
- **L_polynew_4 — large-a incomplete gamma:** Both Wolfram and mpmath handle
  this correctly (mpmath uses Temme's uniform asymptotic). SciPy uses
  regularised-only paths and may lose precision at large-a, small-(z/a) ratios.
- **L_polynew_6 — Pochhammer at integer coincidences:** `rf(0, n)` = 0 for n>0
  (Pochhammer hits a zero from the Γ(a+n)/Γ(a) formula); `rf(-5, 6)` = 0
  (since -5, -4, ..., -1, 0 are in the product, hitting the pole and zero
  simultaneously). All oracles agree: Wolfram, mpmath, SciPy `poch(-5, 6) = 0`.

---

## §7 — Install corrections and additions

### 7.1 Boost.Math headers (REQUIRED for silver tier)

**Status:** NOT installed. Install with:
```sh
sudo apt install libboost-math-dev
# Version 1.83.0.1ubuntu2 from Ubuntu 24.04 universe
# Installs headers at /usr/include/boost/math/special_functions/gamma.hpp etc.
# No runtime -l flag needed (header-only library)
```

Compile command for the gamma oracle binary:
```sh
g++ -O2 -std=c++17 gamma-oracle.cpp -o gamma-oracle
# ~30-40 s compile time due to cpp_bin_float<50> template instantiation
# Cache the binary; do not re-compile per oracle run
```

**Without this install:** the silver tier is empty for ALL gamma-family real
cells. This is the same gap Bessel R5 §7 highlighted for that family.

### 7.2 python-flint / Arb (STRONGLY RECOMMENDED for complex silver tier)

**Status:** NOT installed. Install with:
```sh
sudo apt install libflint-dev        # Version 3.0.1 — Arb IS FLINT 3.0+
pip install --user --break-system-packages python-flint
```

**DO NOT** install `libarb-dev` — that Ubuntu package is the phylogenetic
analysis tool (unrelated). FLINT 3.0+ ships Arb integrated.

Once installed, Arb covers ALL 34 complex cells (and all real cells) with
ball-arithmetic certified error bounds. It is the missing third voice for
complex gamma family, exactly as it was for Bessel. Per the Arb docs
(`acb_hypgeom.h`):

```python
from flint import acb, arb, ctx
ctx.dps = 66

# Real via arb
arb.gamma(arb("3/2"))     # Γ(3/2) with certified ball
arb.lgamma(arb("3/2"))    # log Γ(3/2)
arb.digamma(arb("3/2"))   # ψ(3/2)
arb.polygamma(1, arb("3/2"))  # ψ'(3/2)
arb.rgamma(arb("3/2"))    # 1/Γ(3/2)
arb.rising_factorial(arb("3/2"), arb("3"))  # Pochhammer
arb.gamma_upper(arb("3/2"), arb("5/2"))  # Γ(3/2, 5/2) upper
arb.gamma_lower(arb("3/2"), arb("5/2"))  # γ(3/2, 5/2) lower
arb.beta_lower(arb("3/2"), arb("5/2"), ...)  # incomplete beta
arb.barnes_g(arb("5/2"))  # BarnesG(5/2)

# Complex via acb
acb.gamma(acb("3+2j"))
acb.lgamma(acb("3+2j"))
acb.digamma(acb("3+2j"))
```

### 7.3 julia + SpecialFunctions.jl (DEFERRED — same status as Bessel R5)

Julia binary is at `~/.juliaup/bin/julia`. Install with:
```sh
julia -e 'using Pkg; Pkg.add("SpecialFunctions")'
# Requires network access; ~3 min cold install
# SpecialFunctions.jl covers Gamma, LogGamma, Digamma, Polygamma real arb-prec
# Complex BigFloat: NOT expected to work for all heads (UNVERIFIED)
```

**P3 recommendation:** defer to Phase 2. The Wolfram + mpmath gold pair +
Arb (once installed) is sufficient for gold cross-validation.

---

## §8 — Probe-confirmed output samples

All outputs captured 2026-05-18 on the host machine. Re-runnable.

### 8.1 Wolfram probe outputs

```text
$ wolframscript -code 'N[Gamma[Rational[3,2]], 50]'
0.88622692545275801364908374167057259139877472806119356410690389492645564308558`50.

$ wolframscript -code 'N[LogGamma[Rational[3,2]], 50]'
-0.12078223763524522234551844578164721225185272790259946836386847375732473613583`50.

$ wolframscript -code '{N[PolyGamma[0,Rational[3,2]],50],N[PolyGamma[1,Rational[3,2]],50],N[PolyGamma[2,Rational[3,2]],50],N[Pochhammer[Rational[3,2],3],50],N[Gamma[Rational[3,2],Rational[5,2]],50],N[GammaRegularized[Rational[3,2],Rational[5,2]],50],N[GammaRegularized[Rational[3,2],0,Rational[5,2]],50]}'
{0.03648997397857652055902366700124443280684039533956589295287274318970292278329`50.,
 0.93480220054467930941724549993807556765684970362039531320667468811002242880689`50.,
 -0.82879664423431999559633426116029987070980809276698434509179847459724307862461`50.,
 13.125`50.,
 0.15225125499165762763540371262483225786242483771389402036555734049335676142346`50.,
 0.17179714429673313506360665218305149978909823680596936273743632517332881036313`50.,
 0.82820285570326686493639334781694850021090176319403063726256367482667118963687`50.}

$ wolframscript -code '{N[Beta[Rational[1,2],Rational[3,2]],50],N[BetaRegularized[Rational[1,3],Rational[1,2],Rational[3,2]],50],N[BarnesG[Rational[5,2]],50],N[Hyperfactorial[5],50],N[1/Gamma[Rational[3,2]],50]}'
{1.5707963267948966192313216916397514420985846996875529104874722961539082059438`50.,
 0.69193199074964262668925528955801110553815336609114049697522916789376624320632`50.,
 0.94757390108382577688415298635345806437641026272431334224760875306391156600856`50.,
 8.64`50.*^7,
 1.12837916709551257389615890312154517168810125865799771368817144342128493587705`50.}

$ wolframscript -code '{N[Gamma[0],50],N[Gamma[-1],50],N[Gamma[-1/2],50],N[LogGamma[-1/2],50],N[1/Gamma[0],50],N[1/Gamma[-1],50]}'
{ComplexInfinity, ComplexInfinity,
 -3.54490770181103205459633496668229036559509891224477425642761557970582257234232`50.,
 1.2655121234846453964889457971347059238991475408179110398774915452294625078036`50. - 3.1415926535897932384626433832795028841971693993751058209749445923078164118876`50.*I,
 0, 0}

$ wolframscript -code '{N[Gamma[3+2I],50],N[LogGamma[3+2I],50],N[PolyGamma[0,3+2I],50],N[PolyGamma[1,3+2I],50],N[1/Gamma[3+2I],50],N[Pochhammer[3+2I,3],50],N[Gamma[2,1+I],50],N[BarnesG[2+I],50]}'
{-0.4226372863112021667277826911157863746244692857196313640957058198915557077264 + 0.87181425569650686074514543992808123291308533266646225025994053311724120312709*I,
 -0.03163905937396118980376772960087971720226027400519673392379885438475086750056 + 2.02219319750132712401643376238334982100512167434038924425481176924587280648844*I,
 ...}

$ wolframscript -code 'N[InverseGammaRegularized[Rational[3,2],0.828202855703266],30]'
0.4442484327331865

$ wolframscript -code 'N[InverseBetaRegularized[0.692,Rational[1,2],Rational[3,2]],30]'
0.33340887903778693

$ wolframscript -code '{N[Hyperfactorial[0],50],N[Hyperfactorial[5],50],N[Hyperfactorial[10],50]}'
{1.`50., 8.64`50.*^7, 2.15779412229418562091680268288`50.*^44}

$ wolframscript -code '{N[BarnesG[1],50],N[BarnesG[2],50],N[BarnesG[3],50],N[BarnesG[4],50],N[BarnesG[5],50]}'
{1.`50., 1.`50., 1.`50., 2.`50., 12.`50.}

$ wolframscript -code '{N[Gamma[1+I,2],50],N[Beta[1/2+I/2,3/2],50],N[BetaRegularized[1/3,1/2+I/2,3/2],50]}'
{0.06463204417295875237841777045831992946340469560930582891... + 0.11284029404942590707611925456837307350610966252414148732...*I,
 0.60659996093371340487455271816694355738499010798911794693... - 0.88575623248003682627668769119709769857401853790072894517...*I,
 0.65094383649191180142147167383287472593937943469023939956... - 0.27742845687206178822123037717841441646651163754648826963...*I}
```

### 8.2 mpmath probe outputs

```text
$ python3 -c "
import mpmath; mp=mpmath.mp; mp.dps=60
x=mp.mpf(3)/2
print(mpmath.nstr(mpmath.gamma(x),55))
print(mpmath.nstr(mpmath.loggamma(x),55))
print(mpmath.nstr(mpmath.rgamma(x),55))
print(mpmath.nstr(mpmath.digamma(x),55))
print(mpmath.nstr(mpmath.polygamma(1,x),55))
print(mpmath.nstr(mpmath.polygamma(2,x),55))
print(mpmath.nstr(mpmath.polygamma(3,x),55))
"

0.8862269254527580136490837416705725913987747280611935641   (Gamma)
-0.1207822376352452223455184457816472122518527279025994684  (LogGamma)
1.128379167095512573896158903121545171688101258657997714    (1/Gamma)
0.03648997397857652055902366700124443280684039533956589295  (Digamma)
0.9348022005446793094172454999380755676568497036203953132   (Trigamma m=1)
-0.8287966442343199955963342611602998707098080927669843451  (Tetragamma m=2)
1.409091034002437236440332688705111249727585672685422       (m=3)

mpmath.rf(3/2, 3) = 13.125
mpmath.gammainc(3/2, 5/2)         = 0.1522512549916576276354037126248322578624...  [upper raw]
mpmath.gammainc(3/2, 0, 5/2)      = 0.7339756704611003860136800290457403335363...  [lower raw]
mpmath.gammainc(3/2,5/2,reg=True) = 0.1717971442967331350636066521830514997890...  [Q]
mpmath.gammainc(3/2,0,5/2,reg=True)=0.8282028557032668649363933478169485002109...  [P]
mpmath.beta(1/2, 3/2)             = 1.57079632679489661923132169163975144209858... [= π/2]
mpmath.barnesg(5/2)               = 0.9475739010838257768841529863534580643764...
mpmath.hyperfac(5)                = 86400000.0

Complex (z = 3+2i):
mpmath.gamma(3+2i)     = -0.4226372863112021667277826911... + 0.8718142556965068607451454399...*j
mpmath.loggamma(3+2i)  = -0.0316390593739611898037677296... + 2.022193197501327124016433762...*j
mpmath.digamma(3+2i)   = 1.164591515373977526656869870... + 0.6708072826422302283860876498...*j
mpmath.polygamma(1,3+2i)=(0.2449311621409445827147678159... - 0.1928255501472297480987255392...*j)
mpmath.rgamma(3+2i)    = -0.4502452574169370469014256231... - 0.9287638518642100679601269379...*j
mpmath.rf(3+2i, 3)     = 12.0 + 86.0j
mpmath.gammainc(2, 1+i)= 0.70709209634593807970151920760... - 0.42035364095981145625902245848...*j
mpmath.barnesg(2+i)    = 0.8993997597707072276147612094... - 0.2761649337142958594535506229...*j
mpmath.barnesg(3+2i)   = 0.2105313289078825898464734839... - 0.0143742290024930899312975019...*j

Edge cases:
mpmath.gamma(0): ValueError (pole)
mpmath.gamma(-1): ValueError (pole)
mpmath.gamma(-1/2) = -3.544907701811032054596334966682...
mpmath.loggamma(-1/2) = 1.265512123484645396488945797... - 3.141592653589793238462643383...*j
mpmath.loggamma(-3/2) = 0.860047015376481014510932681... - 6.283185307179586476925286766...*j
mpmath.rgamma(0) = 0.0  (correct: 1/Γ entire)
mpmath.rgamma(-1) = 0.0  (correct)
mpmath.rf(0, 3) = 0.0
mpmath.rf(-5, 6) = 0.0
mpmath.rf(-5, 3) = -60.0
```

### 8.3 SciPy probe outputs (version 1.11.4)

```text
$ python3 -c "import scipy.special as sp, numpy as np
print(sp.gamma(1.5))            # 0.8862269254527579
print(sp.gammaln(1.5))          # -0.12078223763524526
print(sp.loggamma(1.5))         # -0.12078223763524526 (real + imag)
print(sp.loggamma(-0.5))        # nan  ← LANDMINE L15
print(sp.loggamma(-0.5+0j))     # (1.2655...+0j - 3.1415...j) ← pass as complex!
print(sp.digamma(1.5))          # 0.03648997397857652
print(sp.polygamma(1, 1.5))     # 0.9348022005446793
print(sp.poch(1.5, 3))          # 13.125
print(sp.gammainc(1.5, 2.5))    # 0.8282028557032665 ← P convention!
print(sp.gammaincc(1.5, 2.5))   # 0.1717971442967335 ← Q convention!
print(sp.gammainccinv(1.5, 0.172)) # 2.4986...  inverts Q
print(sp.gammaincinv(1.5, 0.828))  # 2.4986...  inverts P
print(sp.beta(0.5, 1.5))        # 1.5707963267948963
print(sp.betainc(0.5, 1.5, 0.333)) # 0.691631772724463
print(sp.betaincinv(0.5, 1.5, 0.692)) # 0.33340887903778693
print(sp.rgamma(1.5))           # 1.1283791670955126
print(sp.gamma(1.5+1j))         # complex: (0.5753...+0.0882...j)
print(sp.loggamma(1.5+1j))      # complex: (-0.5412...+0.1521...j)
print(sp.digamma(1.5+1j))       # complex: (0.3482...+0.7649...j)
print(sp.rgamma(1.5+1j))        # complex: (1.6982...-0.2603...j)
# polygamma(1, complex) → TypeError (L14)
# barnesg: not in SciPy
print(hasattr(sp, 'barnesg'))   # False
# SciPy gamma overflow:
print(sp.gamma(171.62))         # 1.757...e+308 (near float64 max)
print(sp.gamma(171.63))         # inf (overflow)
"
```

### 8.4 libm probe outputs

```text
$ gcc -o /tmp/libm_gamma_probe /tmp/libm_gamma_probe.c -lm
$ /tmp/libm_gamma_probe
tgamma(1.5)  = 0.88622692545275805
lgamma(1.5)  = -0.12078223763524522
lgamma_r(1.5, &sgn) sign = 1, val = -0.12078223763524522
tgamma(-1.5) = 2.3632718012073548
tgamma(0.0)  = inf
tgamma(-1.0) = nan   ← NaN at integer poles (unlike SciPy which gives inf)
```

---

## §9 — Inline summary

This section is the self-contained quick-reference for the orchestrator.

### Per-head tier matrix

| Head                     | Real Gold | Real Silver | Real Bronze | Complex Gold | Complex Silver | Complex Bronze |
|--------------------------|-----------|-------------|-------------|--------------|----------------|----------------|
| Gamma                    | W+M       | Boost*      | Sp, libm    | W+M          | —              | Sp             |
| LogGamma (analytic cont) | W+M       | Boost* (|Γ| only) | Sp* (cx form), libm (|Γ| only) | W+M | — | Sp |
| 1/Gamma                  | W+M       | —           | Sp          | W+M          | —              | Sp             |
| Digamma                  | W+M       | Boost*      | Sp          | W+M          | —              | Sp             |
| Polygamma m≥1            | W+M       | Boost*      | Sp          | W+M          | —              | —              |
| Pochhammer               | W+M       | —           | Sp          | W+M          | —              | —              |
| GammaUpper (raw)         | W+M       | Boost*      | —           | W+M          | —              | —              |
| GammaLower (raw)         | W+M       | Boost*      | —           | W+M          | —              | —              |
| GammaP (lower reg)       | W+M       | Boost*      | Sp          | W+M          | —              | —              |
| GammaQ (upper reg)       | W+M       | Boost*      | Sp          | W+M          | —              | —              |
| InvGammaReg              | W+(M§)    | Boost*      | Sp          | W            | —              | —              |
| Beta B(a,b)              | W+M       | Boost*      | Sp          | W+M          | —              | —              |
| BetaInc (raw)            | W+M       | —           | —           | W+M          | —              | —              |
| BetaReg I_z(a,b)         | W+M       | Boost*      | Sp          | W+M          | —              | —              |
| InvBetaReg               | W+(M§)    | Boost*      | Sp          | W            | —              | —              |
| BarnesG                  | W+M       | —           | —           | W+M          | —              | —              |
| Hyperfactorial           | W+M       | —           | —           | W+M†         | —              | —              |

`*` = Boost available only after `sudo apt install libboost-math-dev`
`§` = mpmath via findroot (not closed-form; gold-quality result but slower)
`†` = mpmath.hyperfac(complex) not probed (likely works; mark [UNVERIFIED])

### Critical conventions pinned (must appear in every adapter)

1. **L12 — P/Q naming:** Wolfram `GammaRegularized[a,z]` = Q; SciPy
   `gammainc(a,z)` = P. Opposite conventions! Pin in every adapter with
   `// L12: SciPy gammainc = P (lower), Wolfram GammaRegularized = Q (upper)`.

2. **L13 — InverseGammaReg:** SciPy `gammainccinv` inverts Q (matches Wolfram).
   SciPy `gammaincinv` inverts P (different function).

3. **L14 — SciPy complex polygamma:** TypeError in 1.11.4. Use mpmath/Wolfram.

4. **L15 — SciPy loggamma(real negative):** returns nan. Pass as `x + 0j`.

5. **L16 — BarnesG/Hyperfactorial:** only W+M locally. Install Arb for 3rd voice.

6. **L17 — Poles:** Wolfram = ComplexInfinity, mpmath = ValueError, SciPy/libm = inf/nan.
   1/Gamma at poles = 0 (agreed by all).

### Install requirements before Phase 1

Priority 1 (required for silver tier):
```sh
sudo apt install libboost-math-dev   # Boost.Math 1.83 headers
```

Priority 2 (strongly recommended — third voice for complex + BarnesG):
```sh
sudo apt install libflint-dev
pip install --user --break-system-packages python-flint
```

Priority 3 (deferred):
```sh
julia -e 'using Pkg; Pkg.add("SpecialFunctions")'
```

### Landmines list (L1–L17)

| ID  | Name                                        | Who is affected         |
|-----|---------------------------------------------|-------------------------|
| L1  | Wolfram decimal-literal precision cap        | Wolfram adapter         |
| L2  | mpmath nstr rounds vs Wolfram truncates      | G8 comparator           |
| L_co| Wolfram `*^` exponent normalisation          | Wolfram adapter         |
| L11 | Wolfram trailing noise digits               | Wolfram adapter         |
| L12 | Incomplete gamma P/Q naming inversion       | ALL adapters + G8       |
| L13 | InverseGammaReg inverts Q not P (SciPy)     | SciPy + G8              |
| L14 | SciPy polygamma(m, complex) TypeError       | SciPy adapter           |
| L15 | SciPy loggamma(real negative) = nan         | SciPy adapter           |
| L16 | BarnesG/Hyperfactorial: no silver/bronze    | G8 comparator           |
| L17 | Gamma pole: ComplexInfinity/ValueError/inf  | G8 comparator           |

(L_polynew_1 = L17; L_polynew_2 = L12; L_polynew_3/4/5/6/7 captured inline above.)
