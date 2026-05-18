// =============================================================================
// erf-oracle.cpp — silver + bronze tier Erf oracle (Boost.Math 1.83)
// =============================================================================
//
// Bead: scientist-workbench-x1lt  (G6 — Boost.Math oracle adapter).
// ADR : 0040 §"Decision 8" (oracle hierarchy).
// Ref : docs/refs/erf-research/R5-oracle-landscape.md §1, §2.4.
//
// This translation unit is invoked once per oracle run as
//
//     ./erf-oracle < corpus.json > results.json
//
// It is *corpus-build-time tooling*: the binary is compiled by the TS
// orchestrator (adapter.ts) into ./build/ at install time, the resulting
// results.json is committed, and the binary itself is never part of the
// scientist-workbench runtime. The runtime substrate is pure TypeScript on
// Bun; Boost.Math is external ground truth that we compare against, not a
// runtime dependency.
//
// ─── Why this file is a single translation unit, hand-rolled JSON parser,
//     and zero third-party JSON dependency ────────────────────────────────
//
// 1. The corpus is well-formed by construction (generate-corpus.ts emits
//    canonical decimal strings, fixed key set, no unicode, no escapes
//    beyond ASCII). A 200-line single-pass parser is correct and trivial
//    to audit; pulling in nlohmann/json or rapidjson would inflate the
//    build dependency surface and force agents to reason about a vendored
//    third-party tree just to run a 271-input oracle.
//
// 2. cpp_bin_float<N> requires N at compile time. We fix N = 50 (decimal
//    digits) — the silver-tier target of ADR-0040 — so a single template
//    instantiation suffices. The R5 three-way-agreement headline
//    (`mpmath = sympy = Boost cpp_bin_float<50>` at 50 dp for
//    erf(123/100)) was computed with precisely this configuration.
//
// 3. Boost.Math 1.83 + g++ 13.3.0 are the host versions probed in R5 §1;
//    re-running the adapter on a different host will pick up whichever
//    Boost is in /usr/include and bake its version into oracle_version
//    (read from BOOST_LIB_VERSION at compile time).
//
// ─── Two precision lanes ───────────────────────────────────────────────────
//
// Silver  — boost::multiprecision::cpp_bin_float<50> (50 decimal digits).
//           REAL inputs only — Boost's erf template instantiates only on
//           ordered scalar types and rejects std::complex (R5 §2.4
//           "Boost is real-only"; confirmed by compile test 2026-05-16:
//           erf<std::complex<double>> fails with
//           "no match for 'operator<' (operand types are
//           'std::complex<double>' and 'int')" inside erf_imp's
//           `if (z < 0)` guard at erf.hpp:146).
//
// Bronze  — boost::math::erf<double> + double arithmetic. Same real-only
//           constraint as silver: Boost has no std::complex<double>
//           specialisation for erf at any precision.
//
// The prompt's specification anticipated a complex-double lane via
// boost::math::erf<std::complex<double>>; the 2026-05-16 compile test
// proved this does not exist. The honest answer (CLAUDE.md Rule 8) is
// that Boost is real-only at every tier. All 105 complex inputs in the
// corpus, plus the 8 real Erfi T6 edge cases (Boost exposes no erfi
// primitive), emit a clean refusal record:
//
//     { "method": "boost-refused",
//       "output": null,
//       "note":   "<R5 §1 / mechanical reason>" }
//
// Refusal is documented per-input rather than silently skipped (CLAUDE.md
// Rule 1, "fail loud"), and the parent adapter reconciles the count.
//
// ─── Head coverage ─────────────────────────────────────────────────────────
//
// Boost.Math exposes erf, erfc, erf_inv, erfc_inv as templates over its
// real types. It does NOT expose erfcx or erfi as standalone primitives.
//
//   Erf         — boost::math::erf       (direct)
//   Erfc        — boost::math::erfc      (direct)
//   Erfcx       — exp(x²) · boost::math::erfc(x)   (algebraic combination
//                  of two Boost primitives in arb-prec arithmetic; still a
//                  Boost-computed value — the scaled-erfc identity is the
//                  textbook definition of erfcx, not a competing algorithm)
//   InverseErf  — boost::math::erf_inv   (direct)
//   InverseErfc — boost::math::erfc_inv  (direct)
//   Erfi        — REFUSED in both lanes (no Boost erfi primitive; cannot
//                  derive without smuggling in a competing implementation,
//                  which would defeat the purpose of being an independent
//                  silver-tier voice). The 8 real Erfi inputs in the
//                  corpus are all T6 float64 edge cases (±0, ±∞, NaN,
//                  largest-finite) — degenerate inputs where the silver
//                  voice carries no information beyond what gold already
//                  provides.
//
// ─── Build ─────────────────────────────────────────────────────────────────
//
//     g++ -std=c++17 -O2 -I/usr/include erf-oracle.cpp -o erf-oracle
//
// No -lboost_* link is needed — Boost.Math is header-only.
//
// ─── Output schema (per record) ────────────────────────────────────────────
//
//     {
//       "input_id":            "T1-erf-001",
//       "head":                "Erf",
//       "z":                   "0.000…"  | {"re":"…","im":"…"},
//       "output":              "<decimal string ≥50 digits>"
//                              | {"re":"…","im":"…"}
//                              | null,            // on refusal
//       "method":              "boost-cpp_bin_float-50" |
//                              "boost-double"            |
//                              "boost-refused",
//       "achieved_precision":  50 | 53 | 0,
//       "oracle_id":           "boost",
//       "oracle_version":      "<BOOST_LIB_VERSION>",
//       "elapsed_ms":          <integer>,
//       "note":                "<reason>"        // present on refusal only
//     }
//
// =============================================================================

#include <boost/math/special_functions/erf.hpp>
#include <boost/multiprecision/cpp_bin_float.hpp>
#include <boost/version.hpp>

#include <chrono>
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
// Hand-rolled JSON parser.
//
// The corpus structure consumed here is fixed and minimal:
//
//   { "manifest_version": …, "inputs": [
//       { "id": "...", "tier": "...", "head": "...",
//         "z": "<decimal>" | {"re":"<dec>", "im":"<dec>"},
//         "notes": "..." }, …
//     ], … }
//
// We tolerate arbitrary other top-level keys (they are skipped during
// generic-value parsing) and arbitrary nested values. The parser is a
// recursive-descent single-pass over a std::string buffer.
//
// Numbers are read as raw decimal strings (we never convert to double on
// the wire), because every number-bearing field that matters to the
// oracle ("z.re", "z.im", "z" itself) is in the wire-encoded
// fixed-decimal form generate-corpus.ts produces, and any conversion to
// double would clobber the trailing digits Boost is supposed to honour.
// -----------------------------------------------------------------------------

namespace json {

struct Value;
using Array  = std::vector<Value>;
using Object = std::vector<std::pair<std::string, Value>>;

struct Value {
    // Variant order: null, bool, number-as-string, string, array, object.
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
        // numbers: digits, sign, exponent, decimal point — captured as the
        // raw substring so we don't lose trailing-zero / precision info.
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
                    // \uXXXX: pass through as ASCII surrogate (corpus is ASCII
                    // by construction, so we never expect to see this).
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

// JSON string-escaper for output. We only ever emit ASCII (decimal digits,
// identifier-style heads, decimal points, hyphens, plus). Quoting double-
// quotes and backslashes is sufficient.
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
    // Echoed-back input z: either decimal string (real) or re/im pair.
    bool        z_is_complex = false;
    std::string z_real;
    std::string z_real_im;  // only used if z_is_complex
    // Output: either a decimal string (real), or re/im pair (complex), or
    // omitted (refusal — `output: null`).
    bool        out_is_null    = false;
    bool        out_is_complex = false;
    std::string out_real;
    std::string out_real_im;
    // Method / precision / note.
    std::string method;            // "boost-cpp_bin_float-50" | "boost-double" | "boost-refused"
    int         achieved_precision = 0;  // 50, 53, or 0 (refused)
    std::string oracle_version;
    long        elapsed_ms = 0;
    std::string note;              // optional, present iff method == "boost-refused"
};

void emit_record(std::ostream& os, const ResultRecord& r, bool last) {
    os << "    {\n";
    os << "      \"input_id\": \"" << json::escape_str(r.input_id) << "\",\n";
    os << "      \"head\": \""     << json::escape_str(r.head)     << "\",\n";
    if (r.z_is_complex) {
        os << "      \"z\": { \"re\": \"" << json::escape_str(r.z_real)
           << "\", \"im\": \"" << json::escape_str(r.z_real_im) << "\" },\n";
    } else {
        os << "      \"z\": \"" << json::escape_str(r.z_real) << "\",\n";
    }
    if (r.out_is_null) {
        os << "      \"output\": null,\n";
    } else if (r.out_is_complex) {
        os << "      \"output\": { \"re\": \"" << json::escape_str(r.out_real)
           << "\", \"im\": \"" << json::escape_str(r.out_real_im) << "\" },\n";
    } else {
        os << "      \"output\": \"" << json::escape_str(r.out_real) << "\",\n";
    }
    os << "      \"method\": \"" << json::escape_str(r.method) << "\",\n";
    os << "      \"achieved_precision\": " << r.achieved_precision << ",\n";
    os << "      \"oracle_id\": \"boost\",\n";
    os << "      \"oracle_version\": \"" << json::escape_str(r.oracle_version) << "\",\n";
    os << "      \"elapsed_ms\": " << r.elapsed_ms;
    if (!r.note.empty()) {
        os << ",\n      \"note\": \"" << json::escape_str(r.note) << "\"";
    }
    os << "\n    }" << (last ? "" : ",") << "\n";
}

// -----------------------------------------------------------------------------
// Real-input string sanity.
//
// The corpus carries real edge values as the literal strings "Infinity",
// "-Infinity", "NaN". cpp_bin_float's string constructor does not accept
// these. We classify them up-front and route to a non-finite refusal: the
// silver / bronze lane has nothing useful to say about NaN-vs-NaN equality
// (Boost's erf-of-NaN is libm-defined; the gold tier already covers this
// territory) and Boost's arb-prec erf-at-Infinity literally exits with an
// overflow error rather than the saturating "1.0" libm convention.
//
// This is honest scope (CLAUDE.md Rule 8): we refuse what we cannot deliver
// a confidence-50-digit answer on, rather than smuggling in a plausible-but-
// non-Boost value.
// -----------------------------------------------------------------------------

bool is_nonfinite_real_literal(const std::string& s) {
    return s == "Infinity" || s == "-Infinity" || s == "+Infinity"
        || s == "NaN" || s == "nan" || s == "-NaN" || s == "+NaN";
}

// -----------------------------------------------------------------------------
// Silver-lane number formatter.
//
// Silver tier's contract is "50 significant decimal digits". std::fixed
// gives N *fractional* digits, which loses information at both extremes:
//
//   (a) std::setprecision(50) (no fixed) on a Real50 value of exactly 1.0
//       emits the bare string "1" — losing the precision-50 contract.
//   (b) std::fixed + std::setprecision(50) on erfc(13) ≈ 6.88e-69 emits
//       "0.000…000" — losing every significant digit since 50 fractional
//       places only reach 1e-50.
//   (c) std::fixed + std::setprecision(50) on erf(0.001) ≈ 1.13e-3 emits
//       50 fractional digits = 47 *significant* digits — still 3 short of
//       the 50-digit silver contract.
//
// Policy: always emit silver values in scientific notation with 50
// significant decimal digits via std::scientific +
// std::setprecision(49) (49 fractional + 1 leading mantissa digit = 50
// sig digits). Saturation values (erf(very-large) = 1) emit as
// "1.000…000e+00", small-magnitude values as "6.879…e-69". The shape is
// uniform across the whole real number line, which keeps the G8 cross-
// oracle comparator's canonicalisation logic simple: it strips the
// exponent, normalises the mantissa to a canonical (leading-1, no-
// trailing-zeros) form, then compares.
//
// Zero is the one edge case where std::scientific would emit
// "0.000…e+00" with an arbitrary exponent — explicit special-casing keeps
// the wire shape unambiguous.
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
// Silver-lane dispatch (cpp_bin_float<50>, real inputs only).
//
// Heads handled directly by Boost: Erf, Erfc, InverseErf, InverseErfc.
// Erfcx: computed as exp(x²) · erfc(x) — both Boost arb-prec primitives,
// composed in cpp_bin_float<50> arithmetic. This is the textbook scaled-
// erfc identity, not a competing implementation.
//
// Throws std::runtime_error on out-of-domain / unsupported configurations.
// The caller catches and emits a refusal record.
// -----------------------------------------------------------------------------

std::string silver_eval(const std::string& head, const std::string& z_str) {
    if (is_nonfinite_real_literal(z_str)) {
        throw std::runtime_error("silver: non-finite input (" + z_str + ") — "
                                 "cpp_bin_float does not accept Infinity/NaN literals");
    }
    Real50 x;
    try {
        x = Real50(z_str);
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("silver: cpp_bin_float ctor failed: ") + e.what());
    }
    Real50 y;
    if      (head == "Erf")          y = boost::math::erf(x);
    else if (head == "Erfc")         y = boost::math::erfc(x);
    else if (head == "Erfcx")        y = exp(x * x) * boost::math::erfc(x);
    else if (head == "InverseErf")   y = boost::math::erf_inv(x);
    else if (head == "InverseErfc")  y = boost::math::erfc_inv(x);
    else if (head == "Erfi")         throw std::runtime_error("silver: Boost.Math exposes no erfi primitive; "
                                                              "refusing rather than smuggling a non-Boost algorithm");
    else                              throw std::runtime_error("silver: unknown head '" + head + "'");

    return format_silver(y);
}

// -----------------------------------------------------------------------------
// Bronze-lane dispatch (double, real inputs only).
//
// We re-evaluate at double precision so the result.json carries a true
// float64 Boost value (independent from libm and from scipy), for the
// G8 cross-oracle matrix at the bronze tier. Same head coverage as silver;
// same refusal policy for Erfi (no Boost primitive) and complex inputs
// (no template instantiation).
//
// The double-precision result is emitted as a 17-significant-digit string
// (round-trip-exact for IEEE 754 binary64), produced via
// std::ostringstream + setprecision(17). Hex repr (std::hexfloat) would
// be more rigorous, but the bronze comparator wants decimal for
// human-readable diffing against scipy / libm; 17 sig digits is the
// IEEE-mandated round-trip-exact width.
// -----------------------------------------------------------------------------

std::string bronze_eval(const std::string& head, const std::string& z_str) {
    if (is_nonfinite_real_literal(z_str)) {
        throw std::runtime_error("bronze: non-finite input (" + z_str + ") — "
                                 "skipping rather than relying on libm corner-behaviour");
    }
    double x;
    try {
        x = std::stod(z_str);
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("bronze: stod failed: ") + e.what());
    }
    double y;
    if      (head == "Erf")          y = boost::math::erf(x);
    else if (head == "Erfc")         y = boost::math::erfc(x);
    else if (head == "Erfcx")        y = std::exp(x * x) * boost::math::erfc(x);
    else if (head == "InverseErf")   y = boost::math::erf_inv(x);
    else if (head == "InverseErfc")  y = boost::math::erfc_inv(x);
    else if (head == "Erfi")         throw std::runtime_error("bronze: Boost.Math exposes no erfi primitive");
    else                              throw std::runtime_error("bronze: unknown head '" + head + "'");
    std::ostringstream os;
    os << std::setprecision(17) << y;
    return os.str();
}

// -----------------------------------------------------------------------------
// Per-input driver.
//
// Discipline: silver first if real → on failure, fall back to bronze (which
// will succeed for finite real inputs the silver lane refused for non-Boost
// reasons, e.g. silver Erfi refusal — though bronze refuses the same set).
// For complex inputs both lanes refuse with the same "Boost has no complex
// erf at any precision" note, citing R5 §1 (which surveyed Boost's
// capability table) and the 2026-05-16 compile-test evidence.
// -----------------------------------------------------------------------------

ResultRecord process(const json::Value& input,
                     const std::string& boost_version) {
    using clock = std::chrono::steady_clock;
    auto t0 = clock::now();

    ResultRecord r;
    r.oracle_version = boost_version;

    const json::Value* id_v   = input.find("id");
    const json::Value* head_v = input.find("head");
    const json::Value* z_v    = input.find("z");

    if (!id_v || !head_v || !z_v) {
        throw std::runtime_error("corpus: input missing one of {id,head,z}");
    }

    r.input_id = id_v->as_string();
    r.head     = head_v->as_string();

    const bool z_is_complex = (z_v->kind() == json::Value::Obj);
    r.z_is_complex = z_is_complex;

    if (z_is_complex) {
        const json::Value* re_v = z_v->find("re");
        const json::Value* im_v = z_v->find("im");
        if (!re_v || !im_v) throw std::runtime_error("corpus: complex z missing re/im");
        r.z_real    = re_v->as_string();
        r.z_real_im = im_v->as_string();

        // Both lanes refuse complex (R5 §1 + compile test).
        r.method             = "boost-refused";
        r.out_is_null        = true;
        r.achieved_precision = 0;
        r.note = "Boost.Math erf has no std::complex specialisation at any "
                 "precision (R5 §1: 'arb-prec complex: NO'; compile test "
                 "2026-05-16: boost::math::erf<std::complex<double>> fails "
                 "instantiation in erf_imp at erf.hpp:146 'if (z < 0)').";
    } else {
        r.z_real = z_v->as_string();
        // Silver lane attempt.
        std::string silver_note;
        try {
            std::string out = silver_eval(r.head, r.z_real);
            r.out_real           = out;
            r.method             = "boost-cpp_bin_float-50";
            r.achieved_precision = 50;
        } catch (const std::exception& e) {
            silver_note = e.what();
            // Fall through to bronze attempt.
            try {
                std::string out = bronze_eval(r.head, r.z_real);
                r.out_real           = out;
                r.method             = "boost-double";
                r.achieved_precision = 53;
                r.note = std::string("silver refused: ") + silver_note +
                         "; bronze succeeded";
            } catch (const std::exception& e2) {
                r.method             = "boost-refused";
                r.out_is_null        = true;
                r.achieved_precision = 0;
                r.note = std::string("silver refused: ") + silver_note +
                         "; bronze refused: " + e2.what();
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

    // 1. Slurp stdin in one go (corpus is ~140 KB; full slurp is trivial).
    std::ostringstream buf;
    buf << std::cin.rdbuf();
    std::string src = buf.str();

    // 2. Parse top-level object, locate "inputs" array.
    json::Parser parser(src);
    json::Value root = parser.parse_value();
    if (root.kind() != json::Value::Obj) {
        std::cerr << "erf-oracle: corpus root is not an object\n";
        return 1;
    }
    const json::Value* inputs_v = root.find("inputs");
    if (!inputs_v || inputs_v->kind() != json::Value::Arr) {
        std::cerr << "erf-oracle: corpus has no 'inputs' array\n";
        return 1;
    }
    const json::Array& inputs = inputs_v->as_array();

    // 3. Pull Boost version from the macro baked in at compile time.
    const std::string boost_version = BOOST_LIB_VERSION;  // e.g. "1_83"

    // 4. Emit header + per-input records as a single JSON object with
    //    "results" array (matches the schema the prompt specifies and lets
    //    downstream readers carry forward provenance fields without
    //    cross-referencing the corpus).
    std::cout << "{\n";
    std::cout << "  \"oracle_id\": \"boost\",\n";
    std::cout << "  \"oracle_version\": \"" << boost_version << "\",\n";
    std::cout << "  \"silver_precision_decimals\": 50,\n";
    std::cout << "  \"bronze_precision_bits\": 53,\n";
    std::cout << "  \"input_count\": " << inputs.size() << ",\n";
    std::cout << "  \"results\": [\n";

    int silver_ok = 0, bronze_ok = 0, refused = 0, errors = 0;
    for (size_t i = 0; i < inputs.size(); ++i) {
        try {
            ResultRecord r = process(inputs[i], boost_version);
            emit_record(std::cout, r, i + 1 == inputs.size());
            if      (r.method == "boost-cpp_bin_float-50") ++silver_ok;
            else if (r.method == "boost-double")           ++bronze_ok;
            else                                            ++refused;
        } catch (const std::exception& e) {
            // A truly malformed input (corpus contract violation) — emit
            // a placeholder record so the count stays consistent.
            ResultRecord r;
            r.input_id           = "<unknown:" + std::to_string(i) + ">";
            r.head               = "<unknown>";
            r.out_is_null        = true;
            r.method             = "boost-refused";
            r.achieved_precision = 0;
            r.oracle_version     = boost_version;
            r.note               = std::string("driver error: ") + e.what();
            emit_record(std::cout, r, i + 1 == inputs.size());
            ++errors;
        }
    }

    std::cout << "  ],\n";
    std::cout << "  \"silver_success_count\": " << silver_ok << ",\n";
    std::cout << "  \"bronze_success_count\": " << bronze_ok << ",\n";
    std::cout << "  \"refused_count\":        " << refused << ",\n";
    std::cout << "  \"driver_error_count\":   " << errors << "\n";
    std::cout << "}\n";

    return 0;
}
