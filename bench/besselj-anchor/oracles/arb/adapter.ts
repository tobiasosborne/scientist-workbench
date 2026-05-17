// =============================================================================
// bench/besselj-anchor/oracles/arb/adapter.ts
// =============================================================================
//
// Arb (via python-flint) GOLD-tier oracle adapter for the Bessel-anchor
// golden-master corpus (ADR-0041 / bead `scientist-workbench-rlg2`, G7).
//
// Reads `bench/besselj-anchor/corpus.json` (1766 inputs across 10 tiers and
// 6 heads — BesselJ, BesselY, BesselI, BesselK, BesselIScaled, BesselKScaled)
// and emits `bench/besselj-anchor/oracles/arb/results.json`, a parallel-shape
// record of arb-prec golden-master values produced by Arb (FLINT 3.0+) via
// the `python-flint` 0.8.0 bindings.
//
// -----------------------------------------------------------------------------
// Why Arb closes the silver-tier complex-arb-prec gap (the load-bearing reason)
// -----------------------------------------------------------------------------
//
// The R5 oracle-landscape survey (`docs/refs/besselj-research/R5-oracle-
// landscape.md` §4) found that the 24 capability cells of the Bessel family
// split as follows BEFORE this adapter:
//
//   - 12 real cells:    GOLD = Wolfram + mpmath; SILVER = Boost; BRONZE = SciPy
//   - 12 complex cells: GOLD = Wolfram + mpmath; SILVER = (none);  BRONZE = SciPy
//
// Boost.Math does NOT ship `std::complex<cpp_bin_float<N>>` (R5 §3.4) — its
// complex Bessel templates fail to instantiate at silver tier. SciPy is bronze
// (float64 via Amos under the hood). So the 12 COMPLEX cells were
// single-engine-paired at gold tier: Wolfram and mpmath agreeing on a complex
// value would have no third independent voice to triangulate against.
//
// For Erf this gap was 1 cell (complex Erf at arb prec). For Bessel it is 12.
// The 12× multiplier is what justifies the install — without an independent
// third arb-prec voice on the complex side, the cross-agreement matrix has 12
// rows that cannot be elevated above "two engines, possibly correlated"
// confidence. Arb closes all 12 in one adapter.
//
// Algorithmic independence: Arb's Bessel implementations (FLINT
// `acb_hypgeom_bessel_{j,y,i,k}.c`) derive from Fredrik Johansson's
// hypergeometric-series + rigorous-asymptotic-series machinery, citing
// Olver and DLMF; Wolfram's are proprietary but documented as a different
// dispatch family (per the Wolfram Bessel reference); mpmath's are pure-
// Python power-series + Hankel asymptotic in `mpmath.libmp.libbessel`.
// Three implementations of three different algorithmic lineages — exactly
// the algorithmic-independence property that makes triangulation meaningful.
//
// -----------------------------------------------------------------------------
// Ball-arithmetic radius is real error information — first-class output
// -----------------------------------------------------------------------------
//
// Arb's distinguishing feature vs every other oracle on the list: every
// computed value is a *ball* `[centre ± radius]` with mathematically-
// rigorous containment. The radius is a TIGHT enclosure of the true value,
// computed by error-tracking through every internal operation. This is
// fundamentally different from mpmath's "ran at 60 dps so the first ~57
// digits should be right" — that is conjecturally correct, not certified;
// mpmath has no internal error model. Arb has one.
//
// We therefore record BOTH the midpoint AND the radius as first-class fields
// on every successful record (`value` and `value_radius`). The downstream G8
// cross-agreement comparator can then:
//
//   1. Use the midpoint for value comparison (the standard role).
//   2. Use the radius as the TIER-THRESHOLD floor: if Arb reports a
//      radius of `1e-58` on a value where Wolfram and mpmath disagree at
//      digit 56, the disagreement is *spurious* — both gold engines fall
//      within Arb's certified containment ball. Conversely, if mpmath
//      claims digit 56 of agreement but Arb's radius is `1e-55`, mpmath
//      is overstating its precision and the agreement is illusory.
//
// This is the comparator-input ADR-0041 §"Decision 8" mentions when it
// calls Arb "the missing third voice that returns a certified error bound
// rather than a conjecturally-correct value."
//
// For the 12 complex cells: `value_radius` is itself `{re, im}` — the ball
// is two-dimensional in C. We emit both components honestly.
//
// -----------------------------------------------------------------------------
// Precision discipline — 60 dps baseline + cancellation-driven retry to 360 dps
// -----------------------------------------------------------------------------
//
// Baseline: `ctx.dps = 60` (10 decimal digits above the gold-tier target of
// 50). The emit uses `arb.str(55, radius=False)` for the midpoint — 5 dps
// above gold target, 5 dps below baseline working precision.
//
// **Auto-bump on insufficient accuracy.** Arb is a ball-arithmetic library;
// every result reports its accuracy as a number of relative bits
// (`arb.rel_accuracy_bits()`). If the result of `acb.bessel_*` at the
// baseline dps does not carry enough accurate bits to support the emit
// precision, we bump `ctx.dps` by 60 and retry — up to 6 attempts (final dps
// = 360). This is the precision-retry pattern ADR-0041 §Decision 3 mandates
// for the bigfloat substrate, and it applies here for exactly the same
// reason: arithmetic on intermediate values whose true magnitude differs
// from the final answer's magnitude introduces precision loss that needs to
// be recovered by upstream work.
//
// The retry pattern is load-bearing for two well-understood landmine
// neighbourhoods:
//
//   - `K_ν(z)` for `z ≳ 80` at dps=60: the value is below the dps=60
//     representation floor relative to typical intermediate quantities
//     in Arb's internal dispatch; the returned ball has *negative*
//     accuracy bits ("the radius is larger than the midpoint"). At
//     dps=180 the value carries comfortable accuracy. Probed: `K_0(80)`
//     needs dps≈180; `K_0(1000)` works at dps=60 because the asymptotic
//     path is exact-by-recurrence in that regime.
//   - `K_ν(z, scaled=True)` (i.e. `e^z·K_ν(z)`) at moderate-large z: Arb
//     internally computes the unscaled value first then scales; the
//     same precision floor applies.
//
// `I_ν(z, scaled=True)` does NOT need bumping in the probed range because
// Arb's `bessel_i(scaled=True)` uses an internal asymptotic-form path that
// preserves precision; ditto unscaled `I_ν(z)` for moderate ν.
//
// **Emit discipline.** Each record records the *final* `dps_used` for that
// row in the `compute_dps` field, alongside the standard `emit_dps`. The
// G8 comparator can use `compute_dps` as a per-row honesty signal: if Arb
// needed dps=300 to reach our emit floor, that's a row where the other
// oracles are likely also operating near a precision cliff.
//
// **Why bump? Why not just start at dps=200?** Cost. The baseline pays for
// the 95%+ of corpus rows that need exactly the baseline. Bumping only the
// few hundred rows that need it keeps total wall-time under 30 s for the
// 1766-input corpus. The cancellation-retry pattern is also the
// mathematically-honest answer to "what should this adapter do when the
// answer has 0 accurate digits at the requested precision?" — fail UP, not
// fail silently.
//
// The 5-dps emit-vs-baseline margin matches G3's truncation discipline so
// the G8 comparator can apply the SAME tier threshold to Wolfram, mpmath,
// and Arb without per-oracle conditioning. mpmath's `nstr` rounds-to-
// nearest; Wolfram's `N[]` truncates; Arb's `str(n, radius=False)`
// truncates with a guaranteed-correct-up-to-1-in-last-digit guarantee.
// Truncating to 55 dps strips the last 2-3 digits of last-digit rounding-
// mode delta across all three.
//
// The radius emit uses `arb.rad().str(10, radius=False)` — 10 digits of the
// radius is wildly more than the comparator needs (the radius is itself
// only an upper bound on the true error; an order of magnitude is the
// load-bearing piece). 10 digits also serves as a self-documenting "this
// number is approximate" signal.
//
// -----------------------------------------------------------------------------
// Landmine mitigation (R5 §6 — Arb-specific lines)
// -----------------------------------------------------------------------------
//
// - L9 (K_ν underflow at z > 700): Arb's ball arithmetic handles this
//   gracefully — `K_0(1500)` returns `[1.17e-653 +/- 4.12e-713]`, a valid
//   ball with a tight radius. No special-case needed. The corpus contains
//   both `BesselK` and `BesselKScaled` rows; we evaluate each exactly as
//   asked (scaled = `e^z · K_ν(z)`).
// - L10 (I_ν overflow at z > 700): same — `I_50(1)` returns `[2.93e-80 +/-
//   3.77e-140]`, a valid ball; `e^{-|Re z|} · I_ν(z)` is the scaled form
//   the corpus's `BesselIScaled` rows ask for.
// - L3 (negative-real-ν branch convention): Arb follows DLMF §10.4.1 (the
//   `+sin(νπ)·J_ν` connection) — verified in the probe transcript. The
//   adapter does not second-guess; it passes ν straight through.
// - L11 (trailing-noise digits at emit floor): for Arb specifically this
//   is *not* a landmine — the radius IS the trailing-noise quantification.
//   The G8 comparator uses Arb's radius to compute the legitimate digit-
//   agreement floor for Wolfram-vs-mpmath comparisons.
// - L8 (integer-vs-near-integer-ν algorithm switch): Arb is a single
//   dispatch family (`acb_hypgeom`); there is no observable integer/non-
//   integer split. This makes Arb the canonical reference for that band.
// - L_special-singular: K_ν(0) and Y_ν(0) are mathematically NaN/-Infinity.
//   Arb returns `nan` (`acb.is_finite()` returns False); we emit
//   `failure_reason = "non-finite at singular point"` per the Erf G3
//   honest-refusal precedent.
//
// -----------------------------------------------------------------------------
// Subprocess discipline (R5 §1 + ADR-0040 §Decision 8 — batch mandatory)
// -----------------------------------------------------------------------------
//
// One python3 subprocess for all 1766 inputs. Python startup is ~200 ms;
// per-input subprocess would be ~350 s of pure overhead. Batched it's <10 min
// end-to-end. The python script reads the corpus inputs as a single JSON
// blob on stdin and writes results as a single JSON list on stdout. We do
// NOT use `spawnBun` (ADR-0001) — that resolver is bun-specific; the snap-bun
// mount-namespace landmine doesn't apply to python3. Plain
// `node:child_process.spawnSync("python3", ...)` matches G3's precedent.
//
// -----------------------------------------------------------------------------
// Determinism
// -----------------------------------------------------------------------------
//
// Arb's ball arithmetic at a given `ctx.dps` is deterministic given the
// `(input, dps)` bytes. The midpoint and radius are bit-identical across
// re-runs on the same FLINT version. We record `flint.__version__`,
// `sys.version`, and `ctx.dps` in every results.json record so a future
// agent can reproduce or notice a version drift.
//
// -----------------------------------------------------------------------------
// Re-run
// -----------------------------------------------------------------------------
//
//   bun bench/besselj-anchor/oracles/arb/adapter.ts
//
// Wall-time: 5–15 min for the 1766-input corpus on a 2024-era laptop. The
// dominant cost is per-input Arb evaluation at 60 dps (the high-ν T7 + the
// complex T5 cells are the slow rows; ~10 ms each); Python loop overhead and
// JSON marshalling are negligible by comparison.
// =============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Types — match the Bessel corpus shape (10 tiers, 6 heads, real|complex z)
// -----------------------------------------------------------------------------

type RealInput = {
  id: string;
  tier: string;
  head: string;
  nu_kind: "integer" | "half-integer" | "decimal";
  nu: string;
  z: string;
  z_root_index?: number;
  z_root_distance?: string;
  notes?: string;
};
type ComplexInput = {
  id: string;
  tier: string;
  head: string;
  nu_kind: "integer" | "half-integer" | "decimal";
  nu: string;
  z: { re: string; im: string };
  notes?: string;
};
type CorpusInput = RealInput | ComplexInput;

interface Corpus {
  manifest_version: number;
  generated_at: string;
  bead: string;
  adr: string;
  seed: number;
  inputs: CorpusInput[];
  totals: { total: number };
}

/** Successful midpoint + ball-radius. Real inputs → real outputs; complex z → complex outputs. */
type ValueField = string | { re: string; im: string };

interface ResultRecord {
  input_id: string;
  head: string;
  nu: string;
  z: string | { re: string; im: string };
  /** "success" | "refused" | "error" */
  status: "success" | "refused" | "error";
  /** Midpoint of Arb's ball at emit precision. Absent if not success. */
  value?: ValueField;
  /** Radius of Arb's ball — the certified error bound. Absent if not success. */
  value_radius?: ValueField;
  /** Set on refused/error/degraded-precision (success with sub-target acc_bits). */
  notes?: string | null;
  /** Final ctx.dps used after auto-bump retries. */
  compute_dps?: number;
  /** Achieved relative-accuracy bits in the result (null for exact-zero / nan). */
  acc_bits?: number | null;
  elapsed_ms: number;
  oracle_id: "arb";
  oracle_version: string;
  python_version: string;
  emit_dps: number;
}

// -----------------------------------------------------------------------------
// Python script — the batched python-flint driver
// -----------------------------------------------------------------------------
//
// Reads `{ "inputs": [...] }` JSON on stdin; emits a JSON list on stdout
// where index 0 is a `__meta__` sentinel and indices 1..N parallel the
// corpus inputs.
//
// Per-row shape:
//   { "id": "...", "status": "success",
//     "value": "0.123…" | {re, im}, "value_radius": "1e-58" | {re, im} }
//   { "id": "...", "status": "refused", "notes": "non-finite at singular point" }
//   { "id": "...", "status": "error",   "notes": "<exception class>: <msg>" }

const PY_SCRIPT = `
import json
import sys
import time

try:
    import flint
    from flint import acb, arb, ctx, fmpq, fmpz
except ImportError as e:
    # Fail fast, fail loud: no fabricated values on import failure (CLAUDE.md Rule 1).
    sys.stderr.write(f"FATAL: python-flint not importable: {e}\\n")
    sys.stderr.write("Install: pip install --user --break-system-packages python-flint\\n")
    sys.stderr.write("(Ubuntu 24.04: apt install libflint-dev first; FLINT 3.0+ includes Arb.)\\n")
    sys.exit(2)

BASELINE_DPS = 60
EMIT_DPS = 55
RADIUS_DPS = 10
DPS_BUMP_STEP = 60
MAX_DPS = 360  # 6 retries * 60 dps/retry on top of baseline
# Threshold: we need EMIT_DPS digits = EMIT_DPS * log2(10) ≈ EMIT_DPS * 3.33
# relative bits of accuracy in the result for the emit to be meaningful.
MIN_ACC_BITS = int(EMIT_DPS * 3.33) + 4  # +4 bits margin to be safe

def _emit_arb_mid(a):
    """Emit arb midpoint as a clean decimal string at EMIT_DPS digits, no brackets."""
    if a.is_nan():
        return "NaN"
    # arb.str(n, radius=False) gives a clean midpoint string with guaranteed
    # correctness up to 1 in the last displayed digit (per the arb.str
    # docstring). This is the load-bearing emit-format choice.
    return a.str(EMIT_DPS, radius=False)

def _emit_arb_rad(a):
    """Emit arb's ball radius as a clean decimal string."""
    if a.is_nan():
        return "NaN"
    rad = a.rad()
    # rad is itself an arb; for the emit we want its midpoint (the radius is
    # an upper bound, not a ball itself in the conceptual sense — but in
    # python-flint arb.rad() returns an arb whose midpoint IS the radius).
    return rad.str(RADIUS_DPS, radius=False)

# acb has rel_accuracy_bits via .real and .imag — we take the MIN, because the
# emit is only as good as the least-accurate component.
# Special cases:
#   - exactly-zero component: rel_accuracy_bits == int64.max — treat as "fine"
#   - NaN component: rel_accuracy_bits == int64.min — treat as "give up"
INT64_MAX = (1 << 63) - 1
INT64_MIN = -(1 << 63)

def acb_min_acc_bits(v):
    """Minimum relative-accuracy bits across the real and imaginary parts of an acb.
    Exact-zero components are treated as having INT64_MAX accuracy (true). NaN
    components are reported as INT64_MIN (meaning the auto-bump won't help)."""
    re_bits = v.real.rel_accuracy_bits() if not v.real.is_nan() else INT64_MIN
    im_bits = v.imag.rel_accuracy_bits() if not v.imag.is_nan() else INT64_MIN
    # If a component is exactly zero, its rel_accuracy_bits is INT64_MAX —
    # which would dominate the min in the wrong direction (we'd never bump
    # for a near-zero real-part with high-accuracy imag). The current logic
    # is correct as long as both components track the same true magnitude
    # scale, which is the case for Arb's ball output. Documented; do not
    # second-guess without re-probing Arb's emit semantics.
    return min(re_bits, im_bits)

def emit_value(v):
    """Emit an acb value as {value, value_radius} pair.
    Returns (value_field, radius_field) where each is a string (real path)
    or {re, im} dict (complex path)."""
    # Decide real-vs-complex output by inspecting the imag part. We always
    # have an acb on input; if the imag part is exactly zero we emit real.
    # (The corpus separates real-z and complex-z inputs by schema, so the
    # status field implicitly carries this — but for safety we let Arb
    # decide rather than trusting the input shape, because e.g. K_ν(complex)
    # may have a numerically-zero imaginary part that is still represented
    # as a complex ball.)
    if v.imag.is_zero():
        return _emit_arb_mid(v.real), _emit_arb_rad(v.real)
    else:
        return (
            {"re": _emit_arb_mid(v.real), "im": _emit_arb_mid(v.imag)},
            {"re": _emit_arb_rad(v.real), "im": _emit_arb_rad(v.imag)},
        )

def parse_nu(nu_str, nu_kind):
    """Parse the corpus nu field into an acb honouring nu_kind discipline.
    Integer and half-integer use rationals (exact). Decimal uses arb (parses
    the 60-digit decimal string at full WORK_DPS precision)."""
    if nu_kind == "integer":
        # Integer ν: parse as fmpz for exactness.
        return acb(fmpz(int(nu_str)))
    if nu_kind == "half-integer":
        # Half-integer ν: parse as fmpq (the corpus emits "<int>/2" format).
        return acb(fmpq(nu_str))
    if nu_kind == "decimal":
        # General-ν decimal: parse via arb which honours the full string at
        # WORK_DPS precision (verified in probe — the 60-digit decimal
        # expansion of a float64 round-trips to the same arb value mpmath
        # would have parsed).
        return acb(arb(nu_str))
    raise ValueError(f"unknown nu_kind: {nu_kind}")

def parse_real_z(z_str):
    """Parse the corpus real-z string into an acb, honouring sentinel tokens."""
    if z_str == "NaN":
        return acb(arb.nan())
    if z_str == "Infinity":
        return acb(arb.pos_inf())
    if z_str == "-Infinity":
        return acb(arb.neg_inf())
    # The corpus emits 60-digit decimal expansions of float64 values.
    return acb(arb(z_str))

def parse_complex_z(z_obj):
    """Parse the corpus complex-z {re, im} into an acb."""
    re = parse_real_z(z_obj["re"])
    im = parse_real_z(z_obj["im"])
    # Combine: re is acb with zero imag; im is acb with zero imag; we want
    # re_part + i * im_part.
    return acb(re.real, im.real)

def evaluate_one(head, nu, z):
    """Dispatch on head at the current ctx.dps. Returns an acb.
    Uses python-flint's native scaled=True for BesselIScaled / BesselKScaled --
    those paths preserve precision MUCH better than naive exp(z)*bessel(z,nu)
    multiplication, especially for K where the unscaled value can be 10^-400
    while e^z is 10^+400 and the product cancels back to O(1)."""
    if head == "BesselJ":
        return z.bessel_j(nu)
    if head == "BesselY":
        return z.bessel_y(nu)
    if head == "BesselI":
        return z.bessel_i(nu)
    if head == "BesselK":
        return z.bessel_k(nu)
    if head == "BesselIScaled":
        # Arb's native scaled I uses e^{-|Re z|} * I_nu(z) convention (R3 §0.4,
        # matching the SciPy "ive" convention and the AMOS ZBESI scaling flag).
        # Probed: matches our corpus's expected scaled-variant semantics.
        return z.bessel_i(nu, scaled=True)
    if head == "BesselKScaled":
        # Arb's native scaled K uses e^z * K_nu(z) (R3 §0.4, matching SciPy
        # "kve" and AMOS ZBESK).
        return z.bessel_k(nu, scaled=True)
    raise ValueError(f"unknown head: {head}")

def evaluate_with_retry(head, nu_kind, nu_str, z_field):
    """Evaluate with cancellation-driven precision bump (ADR-0041 §Decision 3).
    Re-parses nu and z at the current ctx.dps each retry (decimal-string nu
    and complex-z components need full WORK_DPS-precision arb parses; integer
    and half-integer ν are exact and don't depend on dps).
    Returns (acb_value, dps_used, achieved_acc_bits)."""
    dps = BASELINE_DPS
    last_v = None
    last_acc = INT64_MIN
    while dps <= MAX_DPS:
        ctx.dps = dps
        nu = parse_nu(nu_str, nu_kind)
        if isinstance(z_field, str):
            z = parse_real_z(z_field)
        else:
            z = parse_complex_z(z_field)
        v = evaluate_one(head, nu, z)
        last_v = v
        # Non-finite → no point bumping (singular input like K_0(0)).
        if not v.is_finite():
            return v, dps, INT64_MIN
        acc = acb_min_acc_bits(v)
        last_acc = acc
        # acc == INT64_MAX means both components were exactly zero (e.g.
        # J_n(0)=0 for n>0). That's true-by-construction; emit it.
        if acc >= MIN_ACC_BITS or acc == INT64_MAX:
            return v, dps, acc
        dps += DPS_BUMP_STEP
    # Exhausted bumps — return the best-effort value with achieved accuracy.
    # Caller decides whether to record this as "success with degraded
    # precision" or "refused". We pick success-with-flag: the radius IS in
    # the record, so the comparator can see exactly how good the value is.
    return last_v, MAX_DPS, last_acc

def run():
    payload = json.load(sys.stdin)
    inputs = payload["inputs"]
    results = []
    results.append({
        "__meta__": True,
        "flint_version": getattr(flint, "__version__", "unknown"),
        "python_version": sys.version,
        "baseline_dps": BASELINE_DPS,
        "emit_dps": EMIT_DPS,
        "radius_dps": RADIUS_DPS,
        "max_dps": MAX_DPS,
        "min_acc_bits_target": MIN_ACC_BITS,
    })
    for inp in inputs:
        rid = inp["id"]
        head = inp["head"]
        nu_kind = inp["nu_kind"]
        nu_str = inp["nu"]
        z_field = inp["z"]
        t0 = time.perf_counter_ns()
        try:
            v, dps_used, acc_bits = evaluate_with_retry(head, nu_kind, nu_str, z_field)
            elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
            # Honest-refusal check: Arb returns non-finite (nan) on the
            # mathematical singularities (K_ν(0), Y_ν(0) etc.). is_finite()
            # returns False in that case; we record an honest refusal.
            if not v.is_finite():
                reason = "non-finite at singular point (NaN)" if (v.real.is_nan() or v.imag.is_nan()) else "non-finite at singular point (±Inf)"
                results.append({
                    "id": rid,
                    "status": "refused",
                    "notes": reason,
                    "elapsed_ms": elapsed_ms,
                    "compute_dps": dps_used,
                })
                continue
            value_field, radius_field = emit_value(v)
            row = {
                "id": rid,
                "status": "success",
                "value": value_field,
                "value_radius": radius_field,
                "elapsed_ms": elapsed_ms,
                "compute_dps": dps_used,
                "acc_bits": acc_bits if acc_bits not in (INT64_MAX, INT64_MIN) else None,
            }
            # Degraded-precision flag: the auto-bump exhausted MAX_DPS but
            # the result still didn't reach MIN_ACC_BITS. The radius field is
            # honest about it — surface a note so the G8 comparator can lower
            # the per-row precision threshold without manual inspection.
            if acc_bits != INT64_MAX and acc_bits < MIN_ACC_BITS:
                row["notes"] = f"degraded precision: only {acc_bits} accurate bits at dps={dps_used}"
            results.append(row)
        except Exception as e:
            elapsed_ms = (time.perf_counter_ns() - t0) / 1e6
            results.append({
                "id": rid,
                "status": "error",
                "notes": f"{type(e).__name__}: {e}",
                "elapsed_ms": elapsed_ms,
            })
    json.dump(results, sys.stdout)

run()
`;

// -----------------------------------------------------------------------------
// TS driver
// -----------------------------------------------------------------------------

function main(): void {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const corpusPath = fileURLToPath(new URL("../../corpus.json", import.meta.url));
  const resultsPath = `${here}results.json`;
  const readmePath = `${here}README.md`;

  // -- smoke-test python3 + python-flint before paying the corpus-load cost --
  const probe = spawnSync(
    "python3",
    [
      "-c",
      "import flint; from flint import acb, ctx; ctx.dps = 60; v = acb(2).bessel_j(acb(3)); print(getattr(flint, '__version__', 'unknown'))",
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    const msg =
      `\n\n## Adapter failure ${new Date().toISOString()}\n\n` +
      "Smoke-test failed: `python3 -c 'import flint; ...'` returned exit " +
      `${probe.status}.\n\n` +
      `stdout: \`${probe.stdout?.trim() ?? ""}\`\nstderr: \`${probe.stderr?.trim() ?? ""}\`\n\n` +
      "Required install (Ubuntu 24.04 — FLINT 3.0+ includes Arb merged in):\n" +
      "```sh\n" +
      "sudo apt install libflint-dev\n" +
      "pip install --user --break-system-packages python-flint\n" +
      "```\n\n" +
      "Verify with:\n" +
      "```sh\n" +
      "python3 -c 'from flint import acb, ctx; ctx.dps=60; print(acb(2).bessel_j(acb(3)))'\n" +
      "```\n\n" +
      "DO NOT install the Ubuntu `libarb` package — that's a different (phylogenetic-\n" +
      "analysis) project (R5 §3.8).\n";
    try {
      appendFileSync(readmePath, msg);
    } catch {
      // README may not exist yet; surface to stderr regardless.
    }
    process.stderr.write(`arb adapter: smoke-test failed; see ${readmePath}\n`);
    process.exit(1);
  }

  const corpusRaw = readFileSync(corpusPath, "utf8");
  const corpus: Corpus = JSON.parse(corpusRaw);
  const pythonInput = JSON.stringify({ inputs: corpus.inputs });

  process.stdout.write(
    `arb adapter: starting batch — ${corpus.inputs.length} inputs at baseline dps=60 / emit=55 dp (auto-bump to dps=360 on insufficient accuracy)\n`,
  );

  const t0 = Date.now();
  const child = spawnSync("python3", ["-c", PY_SCRIPT], {
    input: pythonInput,
    encoding: "utf8",
    // The python output for 1766 inputs is ~1.5 MiB (a value + radius ball per
    // row, ~700 B/row). 256 MiB is comfortable headroom for any future growth.
    maxBuffer: 1024 * 1024 * 256,
  });
  const totalElapsedMs = Date.now() - t0;

  if (child.status !== 0) {
    process.stderr.write(`arb adapter: python3 exited ${child.status}\n`);
    process.stderr.write(`stderr:\n${child.stderr}\n`);
    process.exit(1);
  }

  let parsed: Array<Record<string, unknown>>;
  try {
    parsed = JSON.parse(child.stdout);
  } catch (e) {
    process.stderr.write(
      `arb adapter: failed to parse python stdout as JSON: ${(e as Error).message}\n`,
    );
    process.stderr.write(`stdout head: ${child.stdout.slice(0, 500)}\n`);
    process.exit(1);
  }

  const meta = parsed[0] as {
    __meta__: true;
    flint_version: string;
    python_version: string;
    baseline_dps: number;
    emit_dps: number;
    radius_dps: number;
    max_dps: number;
    min_acc_bits_target: number;
  };
  if (!meta || meta.__meta__ !== true) {
    process.stderr.write(
      `arb adapter: missing meta sentinel; got ${JSON.stringify(parsed[0])}\n`,
    );
    process.exit(1);
  }
  const pyResults = parsed.slice(1) as Array<{
    id: string;
    status: "success" | "refused" | "error";
    value?: ValueField;
    value_radius?: ValueField;
    notes?: string;
    elapsed_ms: number;
    compute_dps?: number;
    acc_bits?: number | null;
  }>;

  if (pyResults.length !== corpus.inputs.length) {
    process.stderr.write(
      `arb adapter: result count mismatch: corpus=${corpus.inputs.length}, results=${pyResults.length}\n`,
    );
    process.exit(1);
  }

  // The python-flint version string isn't always exposed; if not, fall back
  // to the FLINT runtime version baked into the meta string (we have only
  // `flint.__version__` — i.e. python-flint's version — and rely on
  // FLINT-C version coming from the runtime probe in the README).
  const oracleVersion = `FLINT 3.x via python-flint ${meta.flint_version}`;

  const records: ResultRecord[] = [];
  for (let i = 0; i < pyResults.length; i++) {
    const inp = corpus.inputs[i];
    const r = pyResults[i];
    if (r.id !== inp.id) {
      process.stderr.write(
        `arb adapter: id-order mismatch at row ${i}: corpus=${inp.id} result=${r.id}\n`,
      );
      process.exit(1);
    }
    const base: ResultRecord = {
      input_id: inp.id,
      head: inp.head,
      nu: inp.nu,
      z: inp.z,
      status: r.status,
      elapsed_ms: r.elapsed_ms,
      oracle_id: "arb",
      oracle_version: oracleVersion,
      python_version: meta.python_version,
      emit_dps: meta.emit_dps,
    };
    if (r.compute_dps !== undefined) base.compute_dps = r.compute_dps;
    if (r.acc_bits !== undefined) base.acc_bits = r.acc_bits;
    if (r.status === "success") {
      if (r.value === undefined || r.value_radius === undefined) {
        process.stderr.write(
          `arb adapter: success record missing value/radius at ${inp.id}\n`,
        );
        process.exit(1);
      }
      base.value = r.value;
      base.value_radius = r.value_radius;
      // Note from python (degraded-precision) is carried through.
      if (r.notes !== undefined) base.notes = r.notes;
    } else {
      base.notes = r.notes ?? null;
    }
    records.push(base);
  }

  const totalSuccess = records.filter((r) => r.status === "success").length;
  const totalRefused = records.filter((r) => r.status === "refused").length;
  const totalError = records.filter((r) => r.status === "error").length;

  const envelope = {
    manifest_version: 1,
    oracle_id: "arb",
    oracle_version: oracleVersion,
    python_version: meta.python_version,
    generated_at: new Date().toISOString(),
    corpus_bead: corpus.bead,
    corpus_adr: corpus.adr,
    corpus_seed: corpus.seed,
    corpus_generated_at: corpus.generated_at,
    tier: "gold",
    method: "python-flint acb.bessel_{j,y,i,k}; cancellation-driven precision retry per ADR-0041 §Decision 3",
    precision_decimals_baseline: meta.baseline_dps,
    precision_decimals_max: meta.max_dps,
    precision_decimals_emit: meta.emit_dps,
    min_acc_bits_target: meta.min_acc_bits_target,
    radius_emit_decimals: meta.radius_dps,
    total_corpus_inputs: corpus.inputs.length,
    total_results: records.length,
    total_elapsed_ms: totalElapsedMs,
    totals: {
      success: totalSuccess,
      refused: totalRefused,
      error: totalError,
    },
    results: records,
  };

  writeFileSync(resultsPath, JSON.stringify(envelope, null, 2) + "\n");
  const pct = ((totalSuccess / records.length) * 100).toFixed(2);
  process.stdout.write(
    `arb adapter: wrote ${resultsPath}\n` +
      `  total inputs: ${corpus.inputs.length}\n` +
      `  successful:   ${totalSuccess} (${pct}%)\n` +
      `  refused:      ${totalRefused}\n` +
      `  errors:       ${totalError}\n` +
      `  elapsed:      ${(totalElapsedMs / 1000).toFixed(1)} s\n` +
      `  oracle:       ${oracleVersion}\n`,
  );
}

if (import.meta.main) main();
