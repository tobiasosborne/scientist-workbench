// =============================================================================
// oracle.cpp — silver-tier Gamma-family oracle (Boost.Math 1.83, real-only)
// =============================================================================
//
// Bead: scientist-workbench-3v35  (G5 — Boost.Math Gamma-anchor oracle).
// ADR : 0042 §"Decision 8" (oracle hierarchy: silver tier = Boost
//       cpp_bin_float<50>, real-only; gold = Wolfram + mpmath; bronze =
//       SciPy + libm). Decimal-precision tier = silver (50 dp working
//       precision; emit 50 sig-figs in the wire value).
// Ref : docs/refs/gamma-research/R5-oracle-landscape.md §3.4 (Boost
//       function-name mapping), §6 (landmines L1–L17; L12 is THE gamma
//       trap and is pinned `// L12` at every dispatcher call site below).
//
// This translation unit is invoked once per oracle run as
//
//     ./oracle < corpus.json > results.json
//
// It is *corpus-build-time tooling*: the binary is compiled by the TS
// orchestrator (adapter.ts) into ./build/ on first run, the resulting
// results.json is committed, and the binary itself is never part of the
// scientist-workbench runtime. The runtime substrate is pure TypeScript
// on Bun; Boost.Math is external ground truth that we compare against,
// not a runtime dependency.
//
// ─── Why one TU + hand-rolled JSON (carry from besselj G5 + erf G6) ───────
//
// 1. Corpus is well-formed by construction (generate-corpus.ts emits
//    canonical decimal strings, fixed key set, ASCII only). A single-pass
//    recursive-descent parser is correct, trivial to audit, and avoids
//    bringing nlohmann/json or rapidjson into the build graph just to run
//    a 377-input oracle.
//
// 2. cpp_bin_float<N> requires N at compile time. We fix N = 50 (decimal
//    digits) — the silver-tier target of ADR-0042 §Decision 8 — so a
//    single template instantiation suffices across the whole binary.
//
// 3. Boost.Math 1.83 + g++ 13.3.0 are the host versions probed in R5 §1.
//    Re-running on a different host picks up whichever Boost is in
//    /usr/include and bakes its version into oracle_version (read from
//    BOOST_LIB_VERSION at compile time).
//
// ─── L12 — incomplete-gamma regularisation convention (THE gamma trap) ────
//
// Boost spells P and Q UNAMBIGUOUSLY (`gamma_p` = P = lower regularised;
// `gamma_q` = Q = upper regularised — same convention as Wolfram/mpmath).
// Unlike SciPy (which calls `gammainc` = P, opposite to Wolfram's name),
// Boost's name and value agree. Nevertheless every dispatcher call site
// below carries a `// L12` pin so a grep across the whole oracle-adapter
// suite returns matching annotations, and so a future reader cannot
// accidentally "fix" Boost's spelling by inverting it. R5 §6 L12 is the
// canonical reference; see also corpus-spec.md §L12.
//
//   Boost name             ←→  semantics                ←→  corpus head
//   ─────────────────────────────────────────────────────────────────────
//   tgamma(a, z)               Γ(a, z) upper unregularised   IncompleteGammaUpper
//   tgamma_lower(a, z)         γ(a, z) lower unregularised   IncompleteGammaLower
//   gamma_p(a, z)              P(a, z) lower regularised     IncompleteGammaP
//   gamma_q(a, z)              Q(a, z) upper regularised     IncompleteGammaQ
//   gamma_p_inv(a, p)          inverse of P                  InverseIncompleteGammaP
//   gamma_q_inv(a, q)          inverse of Q                  InverseIncompleteGammaQ
//
// ─── L_pole — Boost throws at gamma poles ─────────────────────────────────
//
// `tgamma(0)` and `tgamma(-n)` for positive integer n raise
// `boost::math::evaluation_error` / `std::domain_error` (overflow_error
// at the pole). We catch all `std::exception` descendants and emit
// status="refused" reason="std-exception: <what>" with method=
// "boost-refused". The R5 §6 L17 comparator on the consumer side knows
// to special-case pole inputs.
//
// ─── No complex support ───────────────────────────────────────────────────
//
// `cpp_bin_float<50>` is an ordered scalar (not a field with complex
// completion in Boost.Math). The gamma / beta / digamma / polygamma
// templates instantiate only on ordered scalar types and reject
// std::complex (R5 §3.4 "No complex support"; same finding as the
// besselj G5 and erf G6 adapters). Every corpus row whose `z` field is
// an object `{re, im}` emits status="unsupported" reason="boost-no-complex".
//
// ─── Heads Boost CANNOT serve at all ──────────────────────────────────────
//
// Boost.Math has no built-in BarnesG, Hyperfactorial, or Pochhammer
// primitive (R5 §3.4 final paragraph). Three corpus heads therefore
// emit status="unsupported" with reason carrying the head name:
//
//   BarnesG       → unsupported  "boost-no-barnesg"        (11 rows)
//   Pochhammer    → unsupported  "boost-no-pochhammer"     (20 rows; we
//                                  do NOT derive via tgamma_ratio because
//                                  doing so smuggles in a competing
//                                  implementation and defeats the
//                                  silver-voice independence contract —
//                                  same discipline as Erf G6's `Erfi`
//                                  refusal)
//   Hyperfactorial→ unsupported  "boost-no-hyperfactorial" (0 rows in
//                                  v0.1 corpus, kept for forward compat)
//
// IncompleteBeta is a 3-arg head (`z`, `a`, `b`) and IS supported via
// boost::math::ibeta(a, b, z) — note Boost's `(a, b, z)` argument order
// differs from the corpus's `(z, a, b)` field order.
//
// ─── Build ────────────────────────────────────────────────────────────────
//
//     g++ -std=c++17 -O2 -I/usr/include oracle.cpp -o oracle
//
// No -lboost_* link is needed — Boost.Math is header-only. The C++17
// requirement is structural (we use `std::variant`, `std::optional`-less
// idioms, structured bindings, and `if constexpr`-free fallbacks).
//
// ─── Output schema (per record) ───────────────────────────────────────────
//
//     {
//       "input_id":            "T1-gamma-001",
//       "head":                "Gamma",
//       "args":                { ... echoed back ... },
//       "value":               "<50-sig-digit decimal>"   | null,
//       "method":              "boost-cpp_bin_float-50" | "boost-refused"
//                                                       | "boost-unsupported",
//       "achieved_precision":  50 | 0,
//       "oracle_id":           "boost",
//       "oracle_version":      "<BOOST_LIB_VERSION>",
//       "elapsed_ms":          <integer>,
//       "status":              "success" | "refused" | "unsupported",
//       "reason":              "<text>"   (present iff status != success)
//     }
//
// The `args` echo is opaque pass-through of the relevant corpus fields
// (`z` / `a` / `b` / `m` / `n`) — the comparator (G8) joins corpus rows
// to oracle records by `input_id` and reads `args` only as a sanity
// check.
// =============================================================================

#include <boost/math/special_functions/gamma.hpp>
#include <boost/math/special_functions/beta.hpp>
#include <boost/math/special_functions/digamma.hpp>
#include <boost/math/special_functions/trigamma.hpp>
#include <boost/math/special_functions/polygamma.hpp>
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
// Hand-rolled JSON parser (lifted verbatim from the besselj G5 oracle —
// same wire shape, same zero-deps discipline). The parser stores numeric
// literals as their raw string form so cpp_bin_float<50> can ingest the
// full 60-decimal-digit corpus input without intermediate double round.
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
// Argument parsing.
//
// The corpus encodes scalar arguments (a, b, m, n) with a discriminated
// `kind` field:
//
//     { "kind": "integer",      "value": "3"   }     → Real50(3)
//     { "kind": "half-integer", "value": "3/2" }     → Real50(3) / Real50(2)
//     { "kind": "decimal",      "value": "1.7000…"}  → Real50("1.7000…")
//
// The primary z (and complex re/im) are bare 60-digit decimal strings.
//
// Half-integer denominators are always powers of 2 in the corpus, so
// division is bit-exact in cpp_bin_float (binary-radix arithmetic with
// exact representation of all power-of-two rationals up to the mantissa
// width).
// -----------------------------------------------------------------------------

Real50 parse_kinded_arg(const json::Value& v) {
    if (v.kind() != json::Value::Obj) {
        throw std::runtime_error("expected object {kind,value}");
    }
    const json::Value* kind_v  = v.find("kind");
    const json::Value* value_v = v.find("value");
    if (!kind_v || !value_v) throw std::runtime_error("kinded arg missing kind/value");
    const std::string& kind = kind_v->as_string();
    const std::string& val  = value_v->as_string();
    if (kind == "half-integer") {
        size_t slash = val.find('/');
        if (slash == std::string::npos) throw std::runtime_error("half-integer missing '/'");
        Real50 num(val.substr(0, slash));
        Real50 den(val.substr(slash + 1));
        if (den == 0) throw std::runtime_error("half-integer zero denominator");
        return num / den;
    }
    // integer or decimal — both accepted by Real50(string)
    return Real50(val);
}

// Parse the primary `z` field — corpus stores it as a bare decimal string.
Real50 parse_decimal_string(const std::string& s) {
    return Real50(s);
}

// -----------------------------------------------------------------------------
// 50-sig-digit emitter.
//
// std::scientific + setprecision(49) gives 1 mantissa digit + 49
// fractional = 50 sig digits. Zero is explicitly special-cased to keep
// the output canonical (std::scientific would print "0.000…e+00" with
// an arbitrary exponent for any value rounding to zero, but exact zero
// deserves an exact zero rendering).
//
// Post-emit normalisation strips the optional '+' from the exponent
// ("1.234e+05" → "1.234e+05" is already canonical for our consumer,
// but the besselj precedent strips the '+' for shorter round-trip).
// We keep the '+' here to match the besselj/erf G5 wire shape exactly;
// the TS adapter does its own post-processing if needed.
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
// Per-head dispatcher.
//
// Returns the formatted 50-sig-digit string OR throws std::exception.
// All exceptions are caught upstream and recorded as status="refused"
// reason="std-exception: <what>".
//
// L12 pins: every incomplete-gamma / inverse / regularised call carries
// a `// L12` comment so a grep returns matching annotations across the
// whole oracle-adapter family.
// -----------------------------------------------------------------------------

struct DispatchInput {
    std::string head;
    bool        has_z = false;
    Real50      z;
    bool        has_a = false;
    Real50      a;
    bool        has_b = false;
    Real50      b;
    bool        has_m = false;
    int         m = 0;      // polygamma order — Boost takes signed int
    bool        has_n = false;
    Real50      n;          // pochhammer n (corpus encodes as integer)
};

// "Unsupported" is a recoverable refusal class (the head is not in
// Boost's vocabulary at all); we throw a tagged exception that the
// caller maps to status="unsupported" rather than status="refused".
struct UnsupportedHead : std::runtime_error {
    UnsupportedHead(const std::string& msg) : std::runtime_error(msg) {}
};

Real50 dispatch(const DispatchInput& in) {
    const std::string& h = in.head;

    // ── Unary gamma-family (z only) ───────────────────────────────────
    if (h == "Gamma") {
        if (!in.has_z) throw std::runtime_error("Gamma: missing z");
        return boost::math::tgamma(in.z);
    }
    if (h == "LogGamma") {
        // Boost's lgamma exposes a sign-tracking overload via int* parameter.
        // We extract the sign so the wire form carries `log Γ(z) =
        // sign * exp(lgamma_abs)` — but the corpus / comparator wants
        // the analytic LogGamma value, which for real z is:
        //   log|Γ(z)|           when sign > 0  (z ∈ (0, +∞) or paired-poles)
        //   log|Γ(z)|           when sign < 0  (Boost still returns the real
        //                                       part log|Γ(z)|; the +iπk
        //                                       branch contribution is a
        //                                       gold-tier-only concern)
        // R5 §3.4 + ADR-0042 §"What we will not decide" §LogGamma-real-x<0:
        // Boost lgamma returns log|Γ(x)| (real part only). The G8
        // comparator on the consumer side knows to compare against
        // Wolfram's Re(LogGamma) for x < 0. We emit the real value here
        // and let the comparator handle the branch.
        if (!in.has_z) throw std::runtime_error("LogGamma: missing z");
        int sign = 1;
        Real50 val = boost::math::lgamma(in.z, &sign);
        // Apply the algebraic sign in the log domain: log(-x) for real
        // x<0 is undefined in pure-real arithmetic; Boost returns
        // log|Γ| and the sign of Γ separately. We emit log|Γ| (the
        // real part of LogGamma) unchanged — the sign is recorded
        // implicitly by the value's relationship to the gold-tier
        // complex LogGamma.
        (void) sign;
        return val;
    }
    if (h == "Digamma") {
        if (!in.has_z) throw std::runtime_error("Digamma: missing z");
        return boost::math::digamma(in.z);
    }
    if (h == "Trigamma") {
        if (!in.has_z) throw std::runtime_error("Trigamma: missing z");
        return boost::math::trigamma(in.z);
    }
    if (h == "Polygamma") {
        // boost::math::polygamma(n, x) where n is the derivative order
        // (n=0 → digamma, n=1 → trigamma, n≥2 → tetragamma+). Boost
        // requires n to be a non-negative integer; the corpus's m field
        // is `{kind:"integer", value:"<int>"}` for all rows in this
        // head's tier, so the int cast is safe.
        if (!in.has_m || !in.has_z) throw std::runtime_error("Polygamma: missing m / z");
        return boost::math::polygamma(in.m, in.z);
    }
    if (h == "BarnesG") {
        throw UnsupportedHead("boost-no-barnesg");
    }
    if (h == "Pochhammer") {
        // Boost has no direct Pochhammer; we deliberately do NOT derive
        // via tgamma_ratio because doing so smuggles in a competing
        // implementation and defeats the silver-voice independence
        // contract. Same discipline as Erf G6's `Erfi` refusal: when a
        // primitive is absent, the honest answer is "Boost cannot
        // serve this head" rather than "Boost can serve this head via
        // a hand-rolled identity that nobody asked for".
        throw UnsupportedHead("boost-no-pochhammer");
    }
    if (h == "Hyperfactorial") {
        throw UnsupportedHead("boost-no-hyperfactorial");
    }

    // ── Two-argument: incomplete gamma family (a, z) ──────────────────
    if (h == "IncompleteGammaUpper") {
        if (!in.has_a || !in.has_z) throw std::runtime_error("IncompleteGammaUpper: missing a / z");
        return boost::math::tgamma(in.a, in.z);                 // L12: upper unregularised
    }
    if (h == "IncompleteGammaLower") {
        if (!in.has_a || !in.has_z) throw std::runtime_error("IncompleteGammaLower: missing a / z");
        return boost::math::tgamma_lower(in.a, in.z);           // L12: lower unregularised
    }
    if (h == "IncompleteGammaP") {
        if (!in.has_a || !in.has_z) throw std::runtime_error("IncompleteGammaP: missing a / z");
        return boost::math::gamma_p(in.a, in.z);                // L12: P = lower regularised
    }
    if (h == "IncompleteGammaQ") {
        if (!in.has_a || !in.has_z) throw std::runtime_error("IncompleteGammaQ: missing a / z");
        return boost::math::gamma_q(in.a, in.z);                // L12: Q = upper regularised
    }
    if (h == "InverseIncompleteGammaP") {
        // The corpus encodes the inverse-input probability in the `z`
        // field semantically (corpus-spec.md table: "z semantically is
        // q ∈ (0, 1)"). For the P-inverse we feed it to gamma_p_inv.
        if (!in.has_a || !in.has_z) throw std::runtime_error("InverseIncompleteGammaP: missing a / z(=p)");
        return boost::math::gamma_p_inv(in.a, in.z);            // L12: inverts P
    }
    if (h == "InverseIncompleteGammaQ") {
        if (!in.has_a || !in.has_z) throw std::runtime_error("InverseIncompleteGammaQ: missing a / z(=q)");
        return boost::math::gamma_q_inv(in.a, in.z);            // L12: inverts Q
    }
    if (h == "GammaPDerivative") {
        if (!in.has_a || !in.has_z) throw std::runtime_error("GammaPDerivative: missing a / z");
        return boost::math::gamma_p_derivative(in.a, in.z);     // ∂P/∂x
    }

    // ── Beta family ───────────────────────────────────────────────────
    if (h == "Beta") {
        if (!in.has_a || !in.has_b) throw std::runtime_error("Beta: missing a / b");
        return boost::math::beta(in.a, in.b);
    }
    if (h == "LogBeta") {
        // Boost has no lbeta; we compute log B(a,b) = lgamma(a)+lgamma(b)-lgamma(a+b)
        // in cpp_bin_float<50> arithmetic. This is NOT a competing
        // algorithm (it is the textbook definition of log B from
        // gamma's primitives) so it stays consistent with the
        // independent-voice contract: all three lgamma calls are
        // Boost's own, the subtraction is exact arb-prec.
        if (!in.has_a || !in.has_b) throw std::runtime_error("LogBeta: missing a / b");
        int sa = 1, sb = 1, sab = 1;
        Real50 la  = boost::math::lgamma(in.a,         &sa);
        Real50 lb  = boost::math::lgamma(in.b,         &sb);
        Real50 lab = boost::math::lgamma(in.a + in.b, &sab);
        (void) sa; (void) sb; (void) sab;
        return la + lb - lab;
    }
    if (h == "IncompleteBeta") {
        // Boost: ibeta(a, b, z) = I_z(a, b) regularised. Corpus stores
        // (z, a, b) in field order; we dispatch with (a, b, z).
        if (!in.has_a || !in.has_b || !in.has_z) throw std::runtime_error("IncompleteBeta: missing a / b / z");
        return boost::math::ibeta(in.a, in.b, in.z);
    }

    // ── Gamma-ratio variants ──────────────────────────────────────────
    if (h == "GammaRatio") {
        // Boost: tgamma_ratio(a, b) = Γ(a)/Γ(b). Both Boost docs and
        // mpmath note the function is numerically stable across a wide
        // range of a, b including pairs where direct Γ(a)/Γ(b) would
        // over/underflow.
        if (!in.has_a || !in.has_b) throw std::runtime_error("GammaRatio: missing a / b");
        return boost::math::tgamma_ratio(in.a, in.b);
    }
    if (h == "GammaDeltaRatio") {
        // Boost: tgamma_delta_ratio(a, delta) = Γ(a) / Γ(a + delta).
        // The corpus's `b` field IS the delta (corpus-spec.md row:
        // "GammaDeltaRatio: a, b (no z)" — but `notes` reveals the
        // convention is Γ(a)/Γ(a+b), so b is the delta).
        if (!in.has_a || !in.has_b) throw std::runtime_error("GammaDeltaRatio: missing a / delta(=b)");
        return boost::math::tgamma_delta_ratio(in.a, in.b);
    }

    throw UnsupportedHead("boost-unsupported-head: " + h);
}

// -----------------------------------------------------------------------------
// Output-record container.
// -----------------------------------------------------------------------------

struct ResultRecord {
    std::string input_id;
    std::string head;
    // Echoed args. We carry the JSON serialisation of the relevant
    // corpus fields verbatim so the comparator can sanity-check the
    // joining without re-reading the corpus.
    std::string args_json;
    bool        value_is_null = true;
    std::string value;                  // 50-sig-digit decimal scientific
    std::string method;                 // "boost-cpp_bin_float-50" |
                                        // "boost-refused" | "boost-unsupported"
    int         achieved_precision = 0; // 50 on success, 0 otherwise
    std::string oracle_version;
    long        elapsed_ms = 0;
    std::string status;                 // "success" | "refused" | "unsupported"
    std::string reason;                 // optional
};

void emit_record(std::ostream& os, const ResultRecord& r, bool last) {
    os << "    {\n";
    os << "      \"input_id\": \"" << json::escape_str(r.input_id) << "\",\n";
    os << "      \"head\": \""     << json::escape_str(r.head)     << "\",\n";
    os << "      \"args\": "       << r.args_json << ",\n";
    if (r.value_is_null) os << "      \"value\": null,\n";
    else                 os << "      \"value\": \"" << json::escape_str(r.value) << "\",\n";
    os << "      \"method\": \""             << json::escape_str(r.method)         << "\",\n";
    os << "      \"achieved_precision\": "   << r.achieved_precision               << ",\n";
    os << "      \"oracle_id\": \"boost\",\n";
    os << "      \"oracle_version\": \""     << json::escape_str(r.oracle_version) << "\",\n";
    os << "      \"elapsed_ms\": "           << r.elapsed_ms                       << ",\n";
    os << "      \"status\": \""             << json::escape_str(r.status)         << "\"";
    if (!r.reason.empty()) {
        os << ",\n      \"reason\": \"" << json::escape_str(r.reason) << "\"";
    }
    os << "\n    }" << (last ? "" : ",") << "\n";
}

// -----------------------------------------------------------------------------
// Helpers for echoing the corpus argument fields back into the output
// record. We render each present field as a "key": "<raw>" pair into a
// compact JSON object. This is opaque pass-through — no semantic parsing,
// just shape preservation so the comparator sees what we evaluated.
// -----------------------------------------------------------------------------

// Render a kinded-arg value object back into the result-args object:
//   { "kind": "integer", "value": "3" }
std::string render_kinded(const json::Value& v) {
    if (v.kind() != json::Value::Obj) return "null";
    std::ostringstream os;
    os << "{";
    bool first = true;
    for (const auto& [k, val] : v.as_object()) {
        if (!first) os << ", ";
        first = false;
        os << "\"" << json::escape_str(k) << "\": ";
        if (val.kind() == json::Value::String)      os << "\"" << json::escape_str(val.as_string()) << "\"";
        else if (val.kind() == json::Value::Number) os << val.as_number();
        else                                        os << "null";
    }
    os << "}";
    return os.str();
}

std::string render_args_echo(const json::Value& input) {
    // The fields we echo: head, z, a, b, m, n. Skip id/tier/notes
    // (the comparator addresses by id and already has the corpus
    // metadata).
    std::ostringstream os;
    os << "{";
    bool first = true;
    auto emit_kv = [&](const std::string& key, const std::string& json_value) {
        if (!first) os << ", ";
        first = false;
        os << "\"" << json::escape_str(key) << "\": " << json_value;
    };

    const json::Value* z = input.find("z");
    if (z) {
        if (z->kind() == json::Value::String) {
            emit_kv("z", "\"" + json::escape_str(z->as_string()) + "\"");
        } else if (z->kind() == json::Value::Obj) {
            // complex {re, im}
            const json::Value* re = z->find("re");
            const json::Value* im = z->find("im");
            std::string re_s = re ? re->as_string() : "";
            std::string im_s = im ? im->as_string() : "";
            emit_kv("z", "{\"re\": \"" + json::escape_str(re_s) + "\", \"im\": \"" + json::escape_str(im_s) + "\"}");
        }
    }
    const json::Value* a = input.find("a");
    if (a) emit_kv("a", render_kinded(*a));
    const json::Value* b = input.find("b");
    if (b) emit_kv("b", render_kinded(*b));
    const json::Value* m = input.find("m");
    if (m) emit_kv("m", render_kinded(*m));
    const json::Value* n = input.find("n");
    if (n) emit_kv("n", render_kinded(*n));

    os << "}";
    return os.str();
}

// -----------------------------------------------------------------------------
// Per-input driver.
//
// Discipline:
//
//   complex z              → unsupported; reason="boost-no-complex"
//                            (Boost cpp_bin_float<50> has no std::complex
//                            instantiation for any gamma-family head).
//
//   head ∈ {BarnesG, Pochhammer, Hyperfactorial}
//                          → unsupported; reason carries head name.
//
//   real-valued + supported head, dispatcher succeeds
//                          → success; method="boost-cpp_bin_float-50",
//                            achieved_precision=50, value = 50 sig-digit
//                            decimal.
//
//   real-valued + supported head, Boost throws (poles, domain errors)
//                          → refused; reason="std-exception: <what>",
//                            method="boost-refused".
// -----------------------------------------------------------------------------

ResultRecord process(const json::Value& input,
                     const std::string& boost_version) {
    using clock = std::chrono::steady_clock;
    auto t0 = clock::now();

    ResultRecord r;
    r.oracle_version = boost_version;

    const json::Value* id_v   = input.find("id");
    const json::Value* head_v = input.find("head");
    if (!id_v || !head_v) throw std::runtime_error("corpus: input missing id/head");
    r.input_id  = id_v->as_string();
    r.head      = head_v->as_string();
    r.args_json = render_args_echo(input);

    const json::Value* z_v = input.find("z");
    const bool z_is_complex = (z_v && z_v->kind() == json::Value::Obj);

    if (z_is_complex) {
        // R5 §3.4 + ADR-0042 §"What we will not decide": Boost has no
        // std::complex<cpp_bin_float<N>> instantiation for any gamma-
        // family head. All complex rows refuse cleanly with the
        // canonical token.
        r.method             = "boost-unsupported";
        r.achieved_precision = 0;
        r.status             = "unsupported";
        r.reason             = "boost-no-complex";
        // value_is_null remains true by construction.
        auto t1 = clock::now();
        r.elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
        return r;
    }

    // Build the dispatcher input from whichever corpus fields are present.
    DispatchInput di;
    di.head = r.head;
    try {
        if (z_v && z_v->kind() == json::Value::String) {
            di.z     = parse_decimal_string(z_v->as_string());
            di.has_z = true;
        }
        const json::Value* a_v = input.find("a");
        if (a_v) { di.a = parse_kinded_arg(*a_v); di.has_a = true; }
        const json::Value* b_v = input.find("b");
        if (b_v) { di.b = parse_kinded_arg(*b_v); di.has_b = true; }
        const json::Value* m_v = input.find("m");
        if (m_v) {
            // polygamma order must fit in int. The corpus uses
            // small non-negative integers exclusively (m ∈ {1, 2, 3, 4}).
            Real50 m_real = parse_kinded_arg(*m_v);
            di.m     = static_cast<int>(m_real);
            di.has_m = true;
        }
        const json::Value* n_v = input.find("n");
        if (n_v) { di.n = parse_kinded_arg(*n_v); di.has_n = true; }
    } catch (const std::exception& e) {
        r.method             = "boost-refused";
        r.achieved_precision = 0;
        r.status             = "refused";
        r.reason             = std::string("input-parse: ") + e.what();
        auto t1 = clock::now();
        r.elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
        return r;
    }

    try {
        Real50 y = dispatch(di);
        r.value          = format_silver(y);
        r.value_is_null  = false;
        r.method             = "boost-cpp_bin_float-50";
        r.achieved_precision = 50;
        r.status             = "success";
    } catch (const UnsupportedHead& uh) {
        r.method             = "boost-unsupported";
        r.achieved_precision = 0;
        r.status             = "unsupported";
        r.reason             = uh.what();
    } catch (const std::exception& e) {
        // Boost throws boost::math::evaluation_error / std::domain_error
        // / std::overflow_error at poles (Γ(0), Γ(-n)) and for some
        // ill-conditioned inputs. We classify all of these uniformly as
        // status="refused" with the exception text preserved verbatim
        // for the comparator's pole-classification logic (R5 §6 L17).
        r.method             = "boost-refused";
        r.achieved_precision = 0;
        r.status             = "refused";
        r.reason             = std::string("std-exception: ") + e.what();
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

    // 1. Slurp stdin (corpus is < 200 KB; one-shot slurp is fine).
    std::ostringstream buf;
    buf << std::cin.rdbuf();
    std::string src = buf.str();

    // 2. Parse top-level object, locate "inputs" array.
    json::Parser parser(src);
    json::Value root = parser.parse_value();
    if (root.kind() != json::Value::Obj) {
        std::cerr << "oracle: corpus root is not an object\n";
        return 1;
    }
    const json::Value* inputs_v = root.find("inputs");
    if (!inputs_v || inputs_v->kind() != json::Value::Arr) {
        std::cerr << "oracle: corpus has no 'inputs' array\n";
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
    std::cout << "  \"tier\": \"silver\",\n";
    std::cout << "  \"substrate\": \"cpp_bin_float<50>\",\n";
    std::cout << "  \"precision_emit_decimals\": 50,\n";
    std::cout << "  \"real_only\": true,\n";
    if (!corpus_seed_str.empty()) {
        std::cout << "  \"corpus_seed\": " << corpus_seed_str << ",\n";
    }
    std::cout << "  \"input_count\": " << inputs.size() << ",\n";
    std::cout << "  \"results\": [\n";

    int success = 0, refused = 0, unsupported_complex = 0, unsupported_head = 0, errors = 0;
    for (size_t i = 0; i < inputs.size(); ++i) {
        try {
            ResultRecord r = process(inputs[i], boost_version);
            emit_record(std::cout, r, i + 1 == inputs.size());
            if      (r.status == "success") ++success;
            else if (r.status == "refused") ++refused;
            else if (r.status == "unsupported") {
                if (r.reason == "boost-no-complex") ++unsupported_complex;
                else                                ++unsupported_head;
            }
        } catch (const std::exception& e) {
            // A truly malformed corpus input (contract violation) — emit
            // a placeholder record so the count stays consistent.
            ResultRecord r;
            r.input_id           = "<unknown:" + std::to_string(i) + ">";
            r.head               = "<unknown>";
            r.args_json          = "{}";
            r.method             = "boost-refused";
            r.achieved_precision = 0;
            r.oracle_version     = boost_version;
            r.status             = "refused";
            r.reason             = std::string("driver error: ") + e.what();
            emit_record(std::cout, r, i + 1 == inputs.size());
            ++errors;
        }
    }

    std::cout << "  ],\n";
    std::cout << "  \"totals\": {\n";
    std::cout << "    \"success\":              " << success             << ",\n";
    std::cout << "    \"refused\":              " << refused             << ",\n";
    std::cout << "    \"unsupported_complex\":  " << unsupported_complex << ",\n";
    std::cout << "    \"unsupported_head\":     " << unsupported_head    << ",\n";
    std::cout << "    \"driver_error\":         " << errors              << "\n";
    std::cout << "  }\n";
    std::cout << "}\n";

    return 0;
}
