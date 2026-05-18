// =============================================================================
// bessel-oracle.cpp — silver + bronze tier Bessel oracle (Boost.Math 1.83)
// =============================================================================
//
// Bead: scientist-workbench-5zxc  (G5 — Boost.Math BesselJ-anchor oracle).
// ADR : 0041 §"Decision 8" (oracle hierarchy: gold + silver + bronze).
// Ref : docs/refs/besselj-research/R5-oracle-landscape.md §2 + §4 + §6
//       (capability matrix, Boost probe, landmines L_boost_yspell + L4 + L9 + L10).
//
// This translation unit is invoked once per oracle run as
//
//     ./bessel-oracle < corpus.json > results.json
//
// It is *corpus-build-time tooling*: the binary is compiled by the TS
// orchestrator (adapter.ts) into ./build/ on first run, the resulting
// results.json is committed, and the binary itself is never part of the
// scientist-workbench runtime. The runtime substrate is pure TypeScript on
// Bun; Boost.Math is external ground truth that we compare against, not a
// runtime dependency.
//
// ─── Why one TU + hand-rolled JSON ─────────────────────────────────────────
//
// 1. Corpus is well-formed by construction (generate-corpus.ts emits
//    canonical decimal strings, fixed key set, ASCII only). A single-pass
//    recursive-descent parser is correct, trivial to audit, and avoids
//    bringing nlohmann/json or rapidjson into the build graph just to run
//    a 1766-input oracle.
//
// 2. cpp_bin_float<N> requires N at compile time. We fix N = 50 (decimal
//    digits) — the silver-tier target of ADR-0041 — so a single template
//    instantiation suffices across the whole binary.
//
// 3. Boost.Math 1.83 + g++ 13.3.0 are the host versions probed in R5 §1
//    and §2 of the besselj research artefacts. Re-running on a different
//    host picks up whichever Boost is in /usr/include and bakes its
//    version into oracle_version (read from BOOST_LIB_VERSION).
//
// ─── L_boost_yspell — load-bearing API correction ─────────────────────────
//
// Boost spells Y_ν as `boost::math::cyl_neumann`, NOT `cyl_bessel_y`.
// `cyl_bessel_y` does not exist in Boost.Math; an attempt to call it
// fails to compile with a misleading "did you mean cyl_bessel_k?"
// suggestion. R5 §6 L_boost_yspell pins this; this comment exists so
// any future reader sees the spelling decision *before* the code.
//
// The four entry points used here:
//   BesselJ ν,z → boost::math::cyl_bessel_j(nu, z)
//   BesselY ν,z → boost::math::cyl_neumann   (nu, z)     ← NOT cyl_bessel_y
//   BesselI ν,z → boost::math::cyl_bessel_i(nu, z)
//   BesselK ν,z → boost::math::cyl_bessel_k(nu, z)
//
// Scaled variants:
//   BesselIScaled ν,z → exp(-|z|) · cyl_bessel_i(nu, z)
//   BesselKScaled ν,z →      exp(z) · cyl_bessel_k(nu, z)
//
// Both are computed in Real50 (cpp_bin_float<50>) arithmetic — the
// exponential factor would over/underflow at |z|≈700 in float64, but
// the cpp_bin_float exponent range is enormous (binary exponent ~2^31),
// so we never trip that cliff. This matches R5 §6 L9/L10's "G3 / G4 /
// G7 must emit scaled variants for |z|>700".
//
// ─── L4 — Boost Y_ν tail cancellation (observed-bounded) ──────────────────
//
// R5 §6 L4: for moderate-large z, Boost docs warn Y_ν loses bits via
// catastrophic cancellation in the Hankel tail. R5's `boost-y-tail-probe`
// observed L4 does NOT manifest at z ≤ 1e10 in Boost 1.83 — Boost still
// emits values, just at slightly less than 50 dp at the extreme tail.
//
// Adapter policy: emit at the full 50-dp width and let the G8 cross-
// agreement comparator handle per-cell precision degradation. We do not
// pre-emptively truncate or refuse on suspected L4 cases — that would
// hide silver-tier evidence from the comparator. The comparator's
// per-cell tolerance bands (ADR-0041 §"Decision 8") absorb 1-3 bit
// disagreement at tail-cancellation cells.
//
// ─── No complex Bessel at any precision ───────────────────────────────────
//
// Boost.Math's cyl_bessel_* templates instantiate only on ordered scalar
// types and reject std::complex (R5 §2 row "arb-prec complex: NO";
// confirmed by the Erf G5 compile test 2026-05-16 and the besselj R5
// `boost-complex-probe-output.txt` artefact). All 128 T5 complex
// inputs in the corpus (~7% of 1766) emit a clean refusal record:
//
//     { "method": "boost-refused",
//       "output": null,
//       "note":   "boost-no-complex-bessel" }
//
// Refusal is documented per-input rather than silently skipped (CLAUDE.md
// Rule 1, "fail loud") and the parent adapter reconciles the count
// (CLAUDE.md Rule 8, "honest scope").
//
// ─── ν parsing (3 classes) ────────────────────────────────────────────────
//
// nu_kind == "integer"      → "0", "1", "-1", "10", "100", "200", "500"
//                              parsed as int; Boost accepts integer ν
//                              into the same templated function signature
//                              (cpp_bin_float<50>::operator=(int) is well-
//                              defined).
//
// nu_kind == "half-integer" → "1/2", "-1/2", "3/2", "-3/2", "5/2", "7/2"
//                              parsed as "a/b" → Real50(a) / Real50(b).
//                              This is exact in cpp_bin_float (binary,
//                              non-power-of-two denominators round; here
//                              the denominator is always 2 which IS a
//                              power of two so the value is bit-exact).
//
// nu_kind == "decimal"      → "1.6999…", "-1.6999…", "2.2999…", "4.6999…"
//                              parsed via Real50(string) ctor (Boost
//                              accepts decimal-string fixed-point input).
//
// We carry nu as a *string* through the JSON wire. The corpus encodes ν
// without telling us its nu_kind at the call site (the C++ doesn't read
// nu_kind), so we sniff the format: starts with '+/-/digit', contains
// '/' → half-integer; contains '.' → decimal; otherwise integer.
//
// ─── Build ────────────────────────────────────────────────────────────────
//
//     g++ -std=c++17 -O2 -I/usr/include bessel-oracle.cpp -o bessel-oracle
//
// No -lboost_* link is needed — Boost.Math is header-only.
//
// ─── Output schema (per record) ───────────────────────────────────────────
//
//     {
//       "input_id":            "T1-besselj-001",
//       "head":                "BesselJ",
//       "nu":                  "<echoed string>",
//       "z":                   "<decimal>" | {"re":"…","im":"…"},
//       "value_silver":        "<decimal string ≥50 sig digits>" | null,
//       "value_bronze":        "<decimal string 17 sig digits>"  | null,
//       "method":              "boost-cpp_bin_float-50" |
//                              "boost-double"            |
//                              "boost-refused",
//       "achieved_precision":  50 | 53 | 0,
//       "oracle_id":           "boost",
//       "oracle_version":      "<BOOST_LIB_VERSION>",
//       "elapsed_ms":          <integer>,
//       "status":              "success" | "refused" | "error",
//       "reason":              "<text>"                          // present on refused/error
//     }
//
// We carry BOTH silver and bronze values per success record (rather than
// one or the other) — the bronze value gives the G8 comparator a
// platform-fingerprint-recorded float64 voice independent of libm, and
// the silver value is the arb-prec voice. Doubling the storage is
// trivial (~120 bytes/record × 1638 success records ≈ 200 KB extra).
// =============================================================================

#include <boost/math/special_functions/bessel.hpp>
#include <boost/multiprecision/cpp_bin_float.hpp>
#include <boost/version.hpp>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace mp = boost::multiprecision;
using Real50 = mp::number<mp::cpp_bin_float<50>>;

// -----------------------------------------------------------------------------
// Hand-rolled JSON parser (lifted verbatim from the Erf G6 oracle —
// same corpus generator, same wire shape, same zero-deps discipline).
// -----------------------------------------------------------------------------

namespace json {

struct Value;
using Array  = std::vector<Value>;
using Object = std::vector<std::pair<std::string, Value>>;

struct Value {
    // Variant slot ordering matters: index() result is used as the kind tag.
    //   0=null, 1=bool, 2=number-as-string, 3=string, 4=array, 5=object.
    std::variant<std::monostate, bool, std::string, std::string, Array, Object> v;
    enum Kind { Null = 0, Bool = 1, Number = 2, String = 3, Arr = 4, Obj = 5 };
    Kind kind() const { return static_cast<Kind>(v.index()); }

    static Value make_null()                 { Value x; x.v = std::monostate{}; return x; }
    static Value make_bool(bool b)           { Value x; x.v = b;                return x; }
    static Value make_number(std::string s)  { Value x; x.v.emplace<2>(std::move(s)); return x; }
    static Value make_string(std::string s)  { Value x; x.v.emplace<3>(std::move(s)); return x; }
    static Value make_array(Array a)         { Value x; x.v = std::move(a);     return x; }
    static Value make_object(Object o)       { Value x; x.v = std::move(o);     return x; }

    const std::string& as_string() const { return std::get<3>(v); }
    const std::string& as_number() const { return std::get<2>(v); }
    const Array&       as_array()  const { return std::get<4>(v); }
    const Object&      as_object() const { return std::get<5>(v); }

    const Value* find(const std::string& key) const {
        if (kind() != Obj) return nullptr;
        for (const auto& [k, val] : as_object()) {
            if (k == key) return &val;
        }
        return nullptr;
    }
};

class Parser {
public:
    explicit Parser(const std::string& s) : s_(s), i_(0) {}

    Value parse_value() {
        skip_ws();
        if (i_ >= s_.size()) throw std::runtime_error("json: unexpected EOF");
        char c = s_[i_];
        if (c == '{')                                    return parse_object();
        if (c == '[')                                    return parse_array();
        if (c == '"')                                    return Value::make_string(parse_string());
        if (c == 't' || c == 'f')                        return parse_bool();
        if (c == 'n')                                    return parse_null();
        if (c == '-' || c == '+' || (c >= '0' && c <= '9')) return Value::make_number(parse_number_raw());
        throw std::runtime_error("json: unexpected char '" + std::string(1, c) + "' at " + std::to_string(i_));
    }

private:
    const std::string& s_;
    size_t i_;

    void skip_ws() {
        while (i_ < s_.size()) {
            char c = s_[i_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++i_;
            else break;
        }
    }

    void expect(char c) {
        skip_ws();
        if (i_ >= s_.size() || s_[i_] != c) {
            throw std::runtime_error("json: expected '" + std::string(1, c) + "' at " + std::to_string(i_));
        }
        ++i_;
    }

    Value parse_object() {
        expect('{');
        Object obj;
        skip_ws();
        if (i_ < s_.size() && s_[i_] == '}') { ++i_; return Value::make_object(std::move(obj)); }
        for (;;) {
            skip_ws();
            std::string key = parse_string();
            expect(':');
            Value val = parse_value();
            obj.emplace_back(std::move(key), std::move(val));
            skip_ws();
            if (i_ < s_.size() && s_[i_] == ',') { ++i_; continue; }
            expect('}');
            break;
        }
        return Value::make_object(std::move(obj));
    }

    Value parse_array() {
        expect('[');
        Array arr;
        skip_ws();
        if (i_ < s_.size() && s_[i_] == ']') { ++i_; return Value::make_array(std::move(arr)); }
        for (;;) {
            arr.push_back(parse_value());
            skip_ws();
            if (i_ < s_.size() && s_[i_] == ',') { ++i_; continue; }
            expect(']');
            break;
        }
        return Value::make_array(std::move(arr));
    }

    std::string parse_string() {
        expect('"');
        std::string out;
        while (i_ < s_.size()) {
            char c = s_[i_++];
            if (c == '"') return out;
            if (c == '\\') {
                if (i_ >= s_.size()) throw std::runtime_error("json: trailing backslash");
                char esc = s_[i_++];
                switch (esc) {
                    case '"':  out.push_back('"');  break;
                    case '\\': out.push_back('\\'); break;
                    case '/':  out.push_back('/');  break;
                    case 'b':  out.push_back('\b'); break;
                    case 'f':  out.push_back('\f'); break;
                    case 'n':  out.push_back('\n'); break;
                    case 'r':  out.push_back('\r'); break;
                    case 't':  out.push_back('\t'); break;
                    default:   throw std::runtime_error("json: unsupported escape \\" + std::string(1, esc));
                }
            } else {
                out.push_back(c);
            }
        }
        throw std::runtime_error("json: unterminated string");
    }

    std::string parse_number_raw() {
        size_t start = i_;
        if (i_ < s_.size() && (s_[i_] == '+' || s_[i_] == '-')) ++i_;
        while (i_ < s_.size()) {
            char c = s_[i_];
            if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') ++i_;
            else break;
        }
        if (i_ == start) throw std::runtime_error("json: empty number");
        return s_.substr(start, i_ - start);
    }

    Value parse_bool() {
        if (s_.compare(i_, 4, "true")  == 0) { i_ += 4; return Value::make_bool(true);  }
        if (s_.compare(i_, 5, "false") == 0) { i_ += 5; return Value::make_bool(false); }
        throw std::runtime_error("json: bad bool literal at " + std::to_string(i_));
    }

    Value parse_null() {
        if (s_.compare(i_, 4, "null") == 0) { i_ += 4; return Value::make_null(); }
        throw std::runtime_error("json: bad null literal at " + std::to_string(i_));
    }
};

// JSON string-escaper for output. Corpus + outputs are ASCII; we only
// need to quote double-quotes, backslashes, and the three control chars.
std::string escape_str(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n')        { out += "\\n"; }
        else if (c == '\r')        { out += "\\r"; }
        else if (c == '\t')        { out += "\\t"; }
        else                       { out.push_back(c); }
    }
    return out;
}

}  // namespace json

// -----------------------------------------------------------------------------
// Output-record container.
// -----------------------------------------------------------------------------

struct ResultRecord {
    std::string input_id;
    std::string head;
    std::string nu_echoed;          // verbatim copy of corpus nu (e.g. "0", "1/2", "1.6999…")
    // Echoed-back z: either a decimal string (real) or re/im pair (complex).
    bool        z_is_complex = false;
    std::string z_real;
    std::string z_real_im;
    // Values: silver/bronze each null on refusal or non-applicable.
    bool        silver_is_null = true;
    bool        bronze_is_null = true;
    std::string value_silver;       // 50-sig-digit decimal scientific
    std::string value_bronze;       // 17-sig-digit decimal
    // Method / precision / status / reason.
    std::string method;             // "boost-cpp_bin_float-50" | "boost-double" | "boost-refused"
    int         achieved_precision = 0;  // 50 (silver), 53 (bronze only), 0 (refused/error)
    std::string oracle_version;
    long        elapsed_ms = 0;
    std::string status;             // "success" | "refused" | "error"
    std::string reason;             // optional, present iff status ∈ {refused, error}
};

void emit_record(std::ostream& os, const ResultRecord& r, bool last) {
    os << "    {\n";
    os << "      \"input_id\": \"" << json::escape_str(r.input_id) << "\",\n";
    os << "      \"head\": \""     << json::escape_str(r.head)     << "\",\n";
    os << "      \"nu\": \""       << json::escape_str(r.nu_echoed) << "\",\n";
    if (r.z_is_complex) {
        os << "      \"z\": { \"re\": \"" << json::escape_str(r.z_real)
           << "\", \"im\": \"" << json::escape_str(r.z_real_im) << "\" },\n";
    } else {
        os << "      \"z\": \"" << json::escape_str(r.z_real) << "\",\n";
    }
    if (r.silver_is_null) os << "      \"value_silver\": null,\n";
    else                  os << "      \"value_silver\": \"" << json::escape_str(r.value_silver) << "\",\n";
    if (r.bronze_is_null) os << "      \"value_bronze\": null,\n";
    else                  os << "      \"value_bronze\": \"" << json::escape_str(r.value_bronze) << "\",\n";
    os << "      \"method\": \"" << json::escape_str(r.method) << "\",\n";
    os << "      \"achieved_precision\": " << r.achieved_precision << ",\n";
    os << "      \"oracle_id\": \"boost\",\n";
    os << "      \"oracle_version\": \"" << json::escape_str(r.oracle_version) << "\",\n";
    os << "      \"elapsed_ms\": " << r.elapsed_ms << ",\n";
    os << "      \"status\": \"" << json::escape_str(r.status) << "\"";
    if (!r.reason.empty()) {
        os << ",\n      \"reason\": \"" << json::escape_str(r.reason) << "\"";
    }
    os << "\n    }" << (last ? "" : ",") << "\n";
}

// -----------------------------------------------------------------------------
// ν parsing (3 classes: integer / half-integer / decimal).
//
// We don't read the corpus's nu_kind tag — instead we sniff the wire
// string. This keeps the C++ insensitive to a future corpus field
// rename. Format matrix:
//
//   "0", "1", "-1", "10", "100", "200", "500"     → integer
//   "1/2", "-1/2", "3/2", "-3/2", "5/2", "7/2"     → half-integer
//   "1.6999…", "-1.6999…", "2.2999…", "4.6999…"   → decimal
//
// The "half-integer" case is special: cpp_bin_float<50> string-ctor does
// not accept "a/b" syntax. We split on '/' and divide. Both numerator
// and denominator are guaranteed integer; we delegate to cpp_bin_float's
// integer-string ctor and let it produce the exact rational.
// -----------------------------------------------------------------------------

Real50 parse_nu(const std::string& nu_str) {
    if (nu_str.find('/') != std::string::npos) {
        // half-integer "a/b"
        size_t slash = nu_str.find('/');
        std::string num_str = nu_str.substr(0, slash);
        std::string den_str = nu_str.substr(slash + 1);
        Real50 num(num_str);
        Real50 den(den_str);
        if (den == 0) throw std::runtime_error("nu: zero denominator in '" + nu_str + "'");
        return num / den;
    }
    // integer or decimal — both accepted by Real50(string)
    return Real50(nu_str);
}

// -----------------------------------------------------------------------------
// Non-finite real-z detection (T6 edge-case literals).
//
// The corpus carries Infinity / -Infinity / NaN as literal strings in
// the z field. cpp_bin_float's string ctor does NOT accept these
// (throws boost::wrapexcept<std::runtime_error>). Boost's bessel-of-
// infinity also throws boost::math::evaluation_error. Both lanes refuse
// these inputs with status="refused" reason="non-finite-real-input".
//
// This matches Erf G6's policy: the silver/bronze lane has nothing
// useful to say about NaN-vs-NaN equality; the gold tier (Wolfram +
// mpmath + Arb) covers the limit-of-representation territory.
// -----------------------------------------------------------------------------

bool is_nonfinite_real_literal(const std::string& s) {
    return s == "Infinity" || s == "-Infinity" || s == "+Infinity"
        || s == "NaN" || s == "nan" || s == "-NaN" || s == "+NaN";
}

// -----------------------------------------------------------------------------
// True-zero detection for the z string. Y_ν(0) and K_ν(0) are
// mathematical singularities (DLMF 10.7.2 / 10.30.2) — Boost's
// arb-prec lanes throw "Overflow Error". We classify these as
// `status="refused" reason="singular-at-z-zero"` rather than letting
// them surface as opaque driver errors, because the underlying
// behaviour is fully understood: Y_n(0) = ±∞, K_n(0) = +∞, neither
// has a finite-precision decimal representation.
//
// The corpus encodes z=0 as fixed-decimal-zero strings of the form
// "0.000…000" or "-0.000…000" — i.e. a leading optional sign, then
// '0', '.', and zero or more '0' digits, optionally followed by an
// 'e+00' / 'e-00' exponent. We parse leniently.
// -----------------------------------------------------------------------------

bool is_true_zero_string(const std::string& s) {
    if (s.empty()) return false;
    size_t i = 0;
    if (s[i] == '+' || s[i] == '-') ++i;
    bool saw_digit = false;
    for (; i < s.size(); ++i) {
        const char c = s[i];
        if (c == '0')      { saw_digit = true; continue; }
        if (c == '.')      { continue; }
        if (c == 'e' || c == 'E') {
            // exponent — must be ±0+ for the whole string to mean zero
            ++i;
            if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
            for (; i < s.size(); ++i) if (s[i] != '0') return false;
            return saw_digit;
        }
        return false;
    }
    return saw_digit;
}

// -----------------------------------------------------------------------------
// Silver-lane formatter — 50 significant decimal digits in scientific.
//
// std::scientific + setprecision(49) gives 1 mantissa digit + 49
// fractional = 50 sig digits. This is uniform across magnitudes (tiny
// K_0(700) ≈ 4.67e-306 and saturating I_0(700) ≈ 1.53e+302 both serialise
// to 50-sig-digit form). Zero is explicitly special-cased — std::scientific
// would emit a misleading exponent for an exact zero.
// -----------------------------------------------------------------------------

std::string format_silver(const Real50& y) {
    if (y == 0) {
        return std::string("0.") + std::string(49, '0') + "e+00";
    }
    std::ostringstream os;
    os << std::scientific << std::setprecision(49) << y;
    return os.str();
}

// -----------------------------------------------------------------------------
// Silver lane: cpp_bin_float<50> dispatch.
//
// Boost.Math entry points (R5 §4 reference):
//   BesselJ       → boost::math::cyl_bessel_j(nu, z)
//   BesselY       → boost::math::cyl_neumann  (nu, z)     ← NOT cyl_bessel_y!
//   BesselI       → boost::math::cyl_bessel_i(nu, z)
//   BesselK       → boost::math::cyl_bessel_k(nu, z)
//   BesselIScaled → exp(-|z|) · cyl_bessel_i(nu, z)
//   BesselKScaled →      exp(z) · cyl_bessel_k(nu, z)
//
// Scaled forms are computed in Real50 arithmetic; cpp_bin_float<50>'s
// exponent range (≈ ±2^31 in binary) means we never trip the |z|≈700
// float64 over/underflow cliff. R5 §6 L9/L10 pin this as the canonical
// silver-tier dodge.
//
// Boost throws boost::math::evaluation_error for various out-of-domain
// edges (e.g. negative-real-z to I/K, ν=0 z=0 to Y). We let those
// propagate to the caller, which catches and emits status="error" with
// the exception text.
// -----------------------------------------------------------------------------

std::string silver_eval(const std::string& head,
                        const std::string& nu_str,
                        const std::string& z_str) {
    if (is_nonfinite_real_literal(z_str)) {
        throw std::runtime_error("silver: non-finite real input '" + z_str + "'");
    }
    Real50 nu, z;
    try { nu = parse_nu(nu_str); }
    catch (const std::exception& e) {
        throw std::runtime_error(std::string("silver: nu parse failed: ") + e.what());
    }
    try { z = Real50(z_str); }
    catch (const std::exception& e) {
        throw std::runtime_error(std::string("silver: z parse failed: ") + e.what());
    }
    Real50 y;
    if      (head == "BesselJ")       y = boost::math::cyl_bessel_j(nu, z);
    else if (head == "BesselY")       y = boost::math::cyl_neumann  (nu, z);   // L_boost_yspell
    else if (head == "BesselI")       y = boost::math::cyl_bessel_i(nu, z);
    else if (head == "BesselK")       y = boost::math::cyl_bessel_k(nu, z);
    else if (head == "BesselIScaled") y = exp(-abs(z)) * boost::math::cyl_bessel_i(nu, z);
    else if (head == "BesselKScaled") y = exp(z)       * boost::math::cyl_bessel_k(nu, z);
    else throw std::runtime_error("silver: unknown head '" + head + "'");
    return format_silver(y);
}

// -----------------------------------------------------------------------------
// Bronze lane: double dispatch.
//
// We re-evaluate at double precision so results.json carries a true
// float64 Boost value (independent from libm and from SciPy) for the
// G8 cross-oracle matrix at the bronze tier.
//
// For scaled variants: at very large |z| the unscaled I and K
// over/underflow at the double-precision step before we apply the
// scale factor. We accept the resulting Inf/NaN as honest — the
// bronze lane's contract is "what Boost in float64 produces"; the
// silver lane carries the dodge.
//
// 17 significant digits is round-trip-exact for IEEE 754 binary64
// (std::numeric_limits<double>::max_digits10 == 17).
// -----------------------------------------------------------------------------

std::string bronze_eval(const std::string& head,
                        const std::string& nu_str,
                        const std::string& z_str) {
    if (is_nonfinite_real_literal(z_str)) {
        throw std::runtime_error("bronze: non-finite real input '" + z_str + "'");
    }
    double nu, z;
    try {
        if (nu_str.find('/') != std::string::npos) {
            size_t slash = nu_str.find('/');
            nu = std::stod(nu_str.substr(0, slash)) / std::stod(nu_str.substr(slash + 1));
        } else {
            nu = std::stod(nu_str);
        }
        z = std::stod(z_str);
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("bronze: input parse failed: ") + e.what());
    }
    double y;
    if      (head == "BesselJ")       y = boost::math::cyl_bessel_j(nu, z);
    else if (head == "BesselY")       y = boost::math::cyl_neumann  (nu, z);   // L_boost_yspell
    else if (head == "BesselI")       y = boost::math::cyl_bessel_i(nu, z);
    else if (head == "BesselK")       y = boost::math::cyl_bessel_k(nu, z);
    else if (head == "BesselIScaled") y = std::exp(-std::abs(z)) * boost::math::cyl_bessel_i(nu, z);
    else if (head == "BesselKScaled") y = std::exp(z)            * boost::math::cyl_bessel_k(nu, z);
    else throw std::runtime_error("bronze: unknown head '" + head + "'");
    std::ostringstream os;
    os << std::setprecision(17) << y;
    return os.str();
}

// -----------------------------------------------------------------------------
// Per-input driver.
//
// Discipline:
//
//   complex z              → refuse both lanes; reason="boost-no-complex-bessel".
//   non-finite real z      → refuse both lanes; reason="non-finite-real-input".
//   finite real z, success → silver + bronze both attempted; on silver
//                            success we record method="boost-cpp_bin_float-50"
//                            with achieved_precision=50; bronze value
//                            is stored alongside for the G8 comparator.
//   silver throws bronze OK → method="boost-double" (achieved_precision=53),
//                            reason notes the silver throw.
//   both throw             → status="error", method="boost-refused"
//                            (achieved_precision=0), reason carries both
//                            exception texts.
// -----------------------------------------------------------------------------

ResultRecord process(const json::Value& input,
                     const std::string& boost_version) {
    using clock = std::chrono::steady_clock;
    auto t0 = clock::now();

    ResultRecord r;
    r.oracle_version = boost_version;

    const json::Value* id_v   = input.find("id");
    const json::Value* head_v = input.find("head");
    const json::Value* nu_v   = input.find("nu");
    const json::Value* z_v    = input.find("z");

    if (!id_v || !head_v || !nu_v || !z_v) {
        throw std::runtime_error("corpus: input missing one of {id,head,nu,z}");
    }

    r.input_id  = id_v->as_string();
    r.head      = head_v->as_string();
    r.nu_echoed = nu_v->as_string();

    const bool z_is_complex = (z_v->kind() == json::Value::Obj);
    r.z_is_complex = z_is_complex;

    if (z_is_complex) {
        const json::Value* re_v = z_v->find("re");
        const json::Value* im_v = z_v->find("im");
        if (!re_v || !im_v) throw std::runtime_error("corpus: complex z missing re/im");
        r.z_real    = re_v->as_string();
        r.z_real_im = im_v->as_string();

        // Boost has NO std::complex<cpp_bin_float<N>> Bessel — refuse cleanly.
        r.method             = "boost-refused";
        r.achieved_precision = 0;
        r.status             = "refused";
        r.reason             = "boost-no-complex-bessel";
        // silver_is_null and bronze_is_null remain true by construction.
    } else {
        r.z_real = z_v->as_string();
        std::string silver_err;
        bool silver_ok = false;
        bool bronze_ok = false;
        try {
            r.value_silver  = silver_eval(r.head, r.nu_echoed, r.z_real);
            r.silver_is_null = false;
            silver_ok = true;
        } catch (const std::exception& e) {
            silver_err = e.what();
        }
        std::string bronze_err;
        try {
            r.value_bronze  = bronze_eval(r.head, r.nu_echoed, r.z_real);
            r.bronze_is_null = false;
            bronze_ok = true;
        } catch (const std::exception& e) {
            bronze_err = e.what();
        }

        if (silver_ok) {
            r.method             = "boost-cpp_bin_float-50";
            r.achieved_precision = 50;
            r.status             = "success";
        } else if (bronze_ok) {
            r.method             = "boost-double";
            r.achieved_precision = 53;
            r.status             = "success";
            r.reason             = std::string("silver refused: ") + silver_err;
        } else {
            r.method             = "boost-refused";
            r.achieved_precision = 0;
            // Classify the refusal cause from coarsest to finest:
            //   1. non-finite literal (T6 ±∞ / NaN)
            //   2. known mathematical singularity (Y_ν / K_ν at z=0)
            //   3. anything else → driver "error"
            // The first two are honest scope (CLAUDE.md Rule 8); only #3
            // surfaces as status="error" warranting a closer look.
            if (is_nonfinite_real_literal(r.z_real)) {
                r.status = "refused";
                r.reason = "non-finite-real-input";
            } else if (is_true_zero_string(r.z_real) &&
                       (r.head == "BesselY" || r.head == "BesselK" ||
                        r.head == "BesselKScaled")) {
                r.status = "refused";
                r.reason = "singular-at-z-zero";
            } else {
                r.status = "error";
                r.reason = std::string("silver: ") + silver_err +
                           " | bronze: " + bronze_err;
            }
        }
    }

    auto t1 = clock::now();
    r.elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    return r;
}

// -----------------------------------------------------------------------------
// Main: slurp stdin, parse corpus, emit results.json on stdout.
// -----------------------------------------------------------------------------

int main(int argc, char** argv) {
    (void) argc; (void) argv;

    // 1. Slurp stdin (corpus is ~700 KB; one-shot slurp is fine).
    std::ostringstream buf;
    buf << std::cin.rdbuf();
    std::string src = buf.str();

    // 2. Parse top-level object, locate "inputs" array.
    json::Parser parser(src);
    json::Value root = parser.parse_value();
    if (root.kind() != json::Value::Obj) {
        std::cerr << "bessel-oracle: corpus root is not an object\n";
        return 1;
    }
    const json::Value* inputs_v = root.find("inputs");
    if (!inputs_v || inputs_v->kind() != json::Value::Arr) {
        std::cerr << "bessel-oracle: corpus has no 'inputs' array\n";
        return 1;
    }
    const json::Array& inputs = inputs_v->as_array();

    // Optional: read corpus_seed if present, for provenance.
    const json::Value* seed_v = root.find("seed");
    std::string corpus_seed_str;
    if (seed_v && seed_v->kind() == json::Value::Number) {
        corpus_seed_str = seed_v->as_number();
    }

    // 3. Pull Boost version baked in at compile time.
    const std::string boost_version = BOOST_LIB_VERSION;  // e.g. "1_83"

    // 4. Emit results.json. Wall-clock starts now (overhead amortised
    //    across inputs is far below the per-input cost we already track).
    std::cout << "{\n";
    std::cout << "  \"oracle_id\": \"boost\",\n";
    std::cout << "  \"oracle_version\": \"Boost.Math " << boost_version
              << " (header-only) / g++ " << __VERSION__ << "\",\n";
    std::cout << "  \"tier_silver\": \"cpp_bin_float<50>\",\n";
    std::cout << "  \"tier_bronze\": \"double\",\n";
    std::cout << "  \"precision_emit_silver_decimals\": 50,\n";
    std::cout << "  \"precision_emit_bronze\": \"float64 17-digit repr\",\n";
    if (!corpus_seed_str.empty()) {
        std::cout << "  \"corpus_seed\": " << corpus_seed_str << ",\n";
    }
    std::cout << "  \"input_count\": " << inputs.size() << ",\n";
    std::cout << "  \"results\": [\n";

    int success = 0, refused_complex = 0, refused_other = 0, errors = 0;
    for (size_t i = 0; i < inputs.size(); ++i) {
        try {
            ResultRecord r = process(inputs[i], boost_version);
            emit_record(std::cout, r, i + 1 == inputs.size());
            if      (r.status == "success") ++success;
            else if (r.status == "refused") {
                if (r.reason == "boost-no-complex-bessel") ++refused_complex;
                else                                       ++refused_other;
            }
            else /* "error" */                              ++errors;
        } catch (const std::exception& e) {
            // A truly malformed corpus input (contract violation) — emit
            // a placeholder record so the count stays consistent.
            ResultRecord r;
            r.input_id           = "<unknown:" + std::to_string(i) + ">";
            r.head               = "<unknown>";
            r.method             = "boost-refused";
            r.achieved_precision = 0;
            r.oracle_version     = boost_version;
            r.status             = "error";
            r.reason             = std::string("driver error: ") + e.what();
            emit_record(std::cout, r, i + 1 == inputs.size());
            ++errors;
        }
    }

    std::cout << "  ],\n";
    std::cout << "  \"totals\": {\n";
    std::cout << "    \"success\":         " << success << ",\n";
    std::cout << "    \"refused_complex\": " << refused_complex << ",\n";
    std::cout << "    \"refused_other\":   " << refused_other << ",\n";
    std::cout << "    \"error\":           " << errors << "\n";
    std::cout << "  }\n";
    std::cout << "}\n";

    return 0;
}
