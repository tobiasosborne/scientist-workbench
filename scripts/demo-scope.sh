#!/usr/bin/env bash
# Ten demos exercising the full scope of the workbench.
# Each demo prints a header and the (post-processed) tool output.
#
# The TS port at `scripts/demo-scope.ts` (worklog 035) is the
# preferred way to run these — one bun process, ~7× faster, typed
# call sites. This shell version is preserved as a sanity-check the
# subprocess surface is healthy, and as a fallback example for
# anyone debugging without TS.

set -e
cd "$(dirname "$0")/.."
export PATH="/home/tobias/.amp/bin:$PATH"
export CAS_STORE=$(mktemp -d)

PARSE() { echo "{\"kind\":\"string\",\"value\":\"$1\"}" | bun tools/expr-parse/tool.ts; }
VERIFY() { echo "{\"kind\":\"record\",\"fields\":{\"lhs\":$1,\"rhs\":$2}}" | bun tools/cas-verify/tool.ts; }
PRETTY() { bun -e 'const v = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(v, null, 2))'; }
SHORT()  { bun -e '
  function s(v){
    if(v.kind==="integer")return v.value;
    if(v.kind==="rational")return v.num+"/"+v.den;
    if(v.kind==="symbol")return v.name;
    if(v.kind==="string")return JSON.stringify(v.value);
    if(v.kind==="boolean")return v.value;
    if(v.kind==="list")return "["+v.items.map(s).join(",")+"]";
    if(v.kind==="record"){const f=v.fields;return "{"+Object.keys(f).sort().map(k=>k+": "+s(f[k])).join(", ")+"}"}
    if(v.kind==="expression"){
      const a=v.args.map(s);
      if(["+","-","*","/","^"].includes(v.head)&&a.length>=2)return "("+a.join(" "+v.head+" ")+")";
      if(v.head==="-"&&a.length===1)return "(-"+a[0]+")";
      return v.head+"("+a.join(",")+")";
    }
    if(v.kind==="tagged")return "tagged["+v.tag+"]("+s(v.payload)+")";
    return JSON.stringify(v);
  }
  const v = JSON.parse(await Bun.stdin.text()); console.log(s(v))'; }

echo "============================================================"
echo "  Demo 1 — binomial expansion: (a+b)^4 ?= a^4+4a^3b+6a^2b^2+4ab^3+b^4"
echo "============================================================"
LHS=$(PARSE "(a+b)^4")
RHS=$(PARSE "a^4 + 4*a^3*b + 6*a^2*b^2 + 4*a*b^3 + b^4")
VERIFY "$LHS" "$RHS" | SHORT

echo
echo "============================================================"
echo "  Demo 2 — catching a real algebra error with a witness"
echo "          (a-b)^3 ?= a^3 - 3a^2 b + 3 a b^2 + b^3   (sign wrong on b^3)"
echo "============================================================"
LHS=$(PARSE "(a-b)^3")
RHS=$(PARSE "a^3 - 3*a^2*b + 3*a*b^2 + b^3")
VERIFY "$LHS" "$RHS" | SHORT
echo "  (witness shows lhs - rhs in canonical form)"

echo
echo "============================================================"
echo "  Demo 3 — Sophie Germain identity"
echo "          a^4+4b^4 ?= (a^2+2b^2+2ab)(a^2+2b^2-2ab)"
echo "============================================================"
LHS=$(PARSE "a^4 + 4*b^4")
RHS=$(PARSE "(a^2 + 2*b^2 + 2*a*b)*(a^2 + 2*b^2 - 2*a*b)")
VERIFY "$LHS" "$RHS" | SHORT

echo
echo "============================================================"
echo "  Demo 4 — symmetric-function identity"
echo "          a^3+b^3+c^3-3abc ?= (a+b+c)(a^2+b^2+c^2-ab-ac-bc)"
echo "============================================================"
LHS=$(PARSE "a^3 + b^3 + c^3 - 3*a*b*c")
RHS=$(PARSE "(a+b+c)*(a^2 + b^2 + c^2 - a*b - a*c - b*c)")
VERIFY "$LHS" "$RHS" | SHORT

echo
echo "============================================================"
echo "  Demo 5 — partial-fraction decomposition (no GCD needed)"
echo "          1/(x^2-1) ?= 1/(2(x-1)) - 1/(2(x+1))"
echo "============================================================"
LHS=$(PARSE "1/(x^2 - 1)")
RHS=$(PARSE "1/(2*(x-1)) - 1/(2*(x+1))")
VERIFY "$LHS" "$RHS" | SHORT

echo
echo "============================================================"
echo "  Demo 6 — telescoping summand"
echo "          1/(n(n+1)) ?= 1/n - 1/(n+1)"
echo "============================================================"
LHS=$(PARSE "1/(n*(n+1))")
RHS=$(PARSE "1/n - 1/(n+1)")
VERIFY "$LHS" "$RHS" | SHORT

echo
echo "============================================================"
echo "  Demo 7 — chain verification: each step of a hand derivation"
echo "          (x+1)^2 = (x+1)(x+1) = x^2 + 2x + 1"
echo "          (the second step has been done by hand and may be wrong)"
echo "============================================================"
S0=$(PARSE "(x+1)^2")
S1=$(PARSE "(x+1)*(x+1)")
S2_correct=$(PARSE "x^2 + 2*x + 1")
S2_wrong=$(PARSE "x^2 + 1")
echo "  step 0 = step 1 :"
VERIFY "$S0" "$S1" | SHORT
echo "  step 1 = step 2 (correct work):"
VERIFY "$S1" "$S2_correct" | SHORT
echo "  step 1 = step 2 (forgot the middle term — should fail):"
VERIFY "$S1" "$S2_wrong" | SHORT

echo
echo "============================================================"
echo "  Demo 8 — honest scope: sin^2(x) + cos^2(x) = 1"
echo "          (this tool does NOT know trig — should say so, not lie)"
echo "============================================================"
LHS=$(echo '{"kind":"expression","head":"+","args":[{"kind":"expression","head":"^","args":[{"kind":"expression","head":"sin","args":[{"kind":"symbol","name":"x"}]},{"kind":"integer","value":"2"}]},{"kind":"expression","head":"^","args":[{"kind":"expression","head":"cos","args":[{"kind":"symbol","name":"x"}]},{"kind":"integer","value":"2"}]}]}')
RHS=$(PARSE "1")
VERIFY "$LHS" "$RHS" | SHORT

echo
echo "============================================================"
echo "  Demo 9 — discoverability: agent plans a composition by type"
echo "          'I have plain text. What can consume strings?'"
echo "          'I want a verdict. What produces records?'"
echo "============================================================"
echo "  tools that consume kind=string :"
echo '{"kind":"record","fields":{"input_kind":{"kind":"string","value":"string"}}}' \
  | bun tools/registry-search/tool.ts \
  | bun -e 'const v=JSON.parse(await Bun.stdin.text());for(const t of v.items)console.log("    -",t.fields.name.value,"@",t.fields.version.value)'
echo "  tools that produce kind=record :"
echo '{"kind":"record","fields":{"output_kind":{"kind":"string","value":"record"}}}' \
  | bun tools/registry-search/tool.ts \
  | bun -e 'const v=JSON.parse(await Bun.stdin.text());for(const t of v.items)console.log("    -",t.fields.name.value,"@",t.fields.version.value)'

echo
echo "============================================================"
echo "  Demo 10 — re-executable provenance"
echo "          Verify (x+1)^3 = x^3+3x^2+3x+1, look up the derivation"
echo "          months later by output hash, get the SAME tool/version/inputs."
echo "============================================================"
LHS=$(PARSE "(x+1)^3")
RHS=$(PARSE "x^3 + 3*x^2 + 3*x + 1")
RESULT=$(VERIFY "$LHS" "$RHS")
echo "  verdict: $(echo $RESULT | SHORT)"
OUTHASH=$(echo "$RESULT" | bun -e 'import {hash, parse} from "@workbench/protocol"; console.log(hash(parse(await Bun.stdin.text())))')
echo "  output hash: $OUTHASH"
echo "  provenance lookup (any tool can do this — we use cas-verify):"
bun tools/cas-verify/tool.ts --provenance-of "$OUTHASH" | SHORT

echo
echo "============================================================"
echo "  Demo 11 — Sturm channel execution: Bell pair → distribution"
echo "          Construct a Bell-pair channel, simplify, execute analytically."
echo "          Expect two outcomes (r0=0,r1=0) and (r0=1,r1=1), each ≈ 0.5."
echo "============================================================"
BELL_PAIR=$(cat <<'EOF'
{"kind":"expression","head":"channel","args":[
  {"kind":"list","items":[]},
  {"kind":"list","items":[]},
  {"kind":"list","items":[
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"0"}]},
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"1"}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"0"},{"kind":"expression","head":"/","args":[{"kind":"symbol","name":"π"},{"kind":"integer","value":"2"}]},{"kind":"list","items":[]}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"1"},{"kind":"symbol","name":"π"},{"kind":"list","items":[{"kind":"integer","value":"0"}]}]},
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"0"},{"kind":"string","value":"r0"}]},
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"1"},{"kind":"string","value":"r1"}]}
  ]}
]}
EOF
)
echo "$BELL_PAIR" | bun tools/sturm-simplify/tool.ts | bun tools/sturm-execute/tool.ts | SHORT

echo
echo "============================================================"
echo "  Demo 12 — Sturm equivalence: Bell pair vs Bell pair + ry(0)"
echo "          The two circuits differ syntactically (extra ry(0) on wire 0)"
echo "          but are equivalent. sturm-simplify removes the redundancy;"
echo "          sturm-equivalent confirms equality."
echo "============================================================"
BELL_REDUNDANT=$(cat <<'EOF'
{"kind":"expression","head":"channel","args":[
  {"kind":"list","items":[]},
  {"kind":"list","items":[]},
  {"kind":"list","items":[
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"0"}]},
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"1"}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"0"},{"kind":"expression","head":"/","args":[{"kind":"symbol","name":"π"},{"kind":"integer","value":"2"}]},{"kind":"list","items":[]}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"0"},{"kind":"integer","value":"0"},{"kind":"list","items":[]}]},
    {"kind":"expression","head":"ry","args":[{"kind":"integer","value":"1"},{"kind":"symbol","name":"π"},{"kind":"list","items":[{"kind":"integer","value":"0"}]}]},
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"0"},{"kind":"string","value":"r0"}]},
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"1"},{"kind":"string","value":"r1"}]}
  ]}
]}
EOF
)
echo "{\"kind\":\"record\",\"fields\":{\"lhs\":${BELL_PAIR},\"rhs\":${BELL_REDUNDANT}}}" \
  | bun tools/sturm-equivalent/tool.ts | SHORT

echo
echo "============================================================"
echo "  Bonus — every byte everywhere is content-addressed"
echo "============================================================"
H1=$(PARSE "x + 1" | bun -e 'import {hash,parse} from "@workbench/protocol"; console.log(hash(parse(await Bun.stdin.text())))')
H2=$(PARSE "1 + x" | bun -e 'import {hash,parse} from "@workbench/protocol"; console.log(hash(parse(await Bun.stdin.text())))')
echo "  hash of parsed 'x + 1': $H1"
echo "  hash of parsed '1 + x': $H2"
echo "  (different hashes — the trees differ; cas-simplify normalises both to the same form,"
echo "   but cas-verify decides them equal, exposing the agent to the choice)"
S1=$(PARSE "x + 1" | bun tools/cas-simplify/tool.ts | bun -e 'import {hash,parse} from "@workbench/protocol"; console.log(hash(parse(await Bun.stdin.text())))')
S2=$(PARSE "1 + x" | bun tools/cas-simplify/tool.ts | bun -e 'import {hash,parse} from "@workbench/protocol"; console.log(hash(parse(await Bun.stdin.text())))')
echo "  hash of simplify(x + 1): $S1"
echo "  hash of simplify(1 + x): $S2"
echo "  (same hash — cas-simplify makes them content-identical)"

echo
echo "============================================================"
echo "  Demo 13 — Channel combinators: build a channel from pieces"
echo "          sturm-then composes a prepare-only channel with"
echo "          an observe-only channel into a deterministic"
echo "          prepare-and-observe pipeline."
echo "============================================================"
PREP_W0=$(cat <<'JSON'
{"kind":"expression","head":"channel","args":[
  {"kind":"list","items":[]},
  {"kind":"list","items":[{"kind":"record","fields":{"id":{"kind":"integer","value":"0"},"kind":{"kind":"string","value":"quantum"}}}]},
  {"kind":"list","items":[
    {"kind":"expression","head":"prepare","args":[{"kind":"rational","num":"0","den":"1"},{"kind":"integer","value":"0"}]}
  ]}
]}
JSON
)
OBS_W0=$(cat <<'JSON'
{"kind":"expression","head":"channel","args":[
  {"kind":"list","items":[{"kind":"record","fields":{"id":{"kind":"integer","value":"0"},"kind":{"kind":"string","value":"quantum"}}}]},
  {"kind":"list","items":[]},
  {"kind":"list","items":[
    {"kind":"expression","head":"observe","args":[{"kind":"integer","value":"0"},{"kind":"string","value":"r"}]}
  ]}
]}
JSON
)
COMPOSED=$(echo "{\"kind\":\"record\",\"fields\":{\"first\":${PREP_W0},\"second\":${OBS_W0}}}" \
  | bun tools/sturm-then/tool.ts)
echo "  composed channel:"
echo "$COMPOSED" | SHORT
echo "  end-to-end through sturm-execute (P(r=0) should be 1):"
echo "$COMPOSED" | bun tools/sturm-execute/tool.ts | SHORT

echo
echo "============================================================"
echo "  Demo 14 — Grover's algorithm: find a marked basis state"
echo "          n=3 search space (8 items), marked=5,"
echo "          predicted P(observed=5) ≈ 0.945 after 2 iterations."
echo "          The whole circuit is built top-down via"
echo "          @workbench/sturm-lib's `find` + `equalTo`,"
echo "          and run through sturm-execute end-to-end."
echo "============================================================"
echo '{"kind":"record","fields":{"n_bits":{"kind":"integer","value":"3"},"marked":{"kind":"list","items":[{"kind":"integer","value":"5"}]}}}' \
  | bun tools/sturm-find/tool.ts | SHORT
