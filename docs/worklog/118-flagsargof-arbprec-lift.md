# 118 — `FlagsArgOf<D>`: typed-barrel `precision?: bigint` lift for `arbprec: true` tools (bead `0y27`)

**Date:** 2026-05-15
**Bead:** scientist-workbench-0y27 (closes)
**Touches:** `packages/contract/src/runner.ts`,
`packages/compose/test/compose.test.ts`

## Context

Worklog 083 (`lc1`/`rn2`) landed the *runtime* contract for the ADR-0020
`--precision=<int>` standard flag: the subprocess CLI threads it into
`flags.precision`, and `@workbench/compose::runWorkbench` validates a
caller's `partialFlags` against the merged `toolFacingFlags(def.flags
?? {}, def.arbprec === true)` schema. Both surfaces honour the flag at
runtime. **The type level lagged behind.** A caller writing the
agent-natural form

```ts
const out = await wb.hypergeometricPfq(input, { precision: 50n });
```

through the typed barrel got `TS2345: precision is not assignable to
Partial<FlagsOf<EmptyFlags>>` and had to write `{ precision: 50n } as
never`. Two `as never` casts sat in `compose.test.ts`'s arbprec block —
inscrutable type-system defeats in the codebase, exactly what a TS
expert won't tolerate.

The diagnosis was already in the bead description: `defineTool<I, O,
Fl>` did not preserve the `arbprec: true` *literal* in the returned
`ToolDefinition`'s static type (the field was typed `arbprec?:
boolean`), so `FlagsArgOf`'s conditional `D extends { arbprec: true }`
never fired at the typed-barrel call site.

## What changed

**One file: `packages/contract/src/runner.ts`.** Four coupled edits.

1. **`ToolDefinition` gets a fourth generic, `Ar extends boolean =
   boolean`, with the field re-typed `arbprec?: Ar`.** The slot carries
   the `true` literal through into the def's static type. The default
   is the *wide* `boolean`, not the narrow `false`, so internal
   functions typed `def: ToolDefinition<...>` without specifying `Ar`
   still read `def.arbprec` as `boolean | undefined` and can compare it
   to `=== true` — no churn on the five existing internal call sites
   (`runner.ts:570,614,699`, `execute.ts:140`, `run.ts:90`).

2. **`defineTool` mirrors the generic: `const Ar extends boolean =
   boolean`.** A tool author writing `arbprec: true` inline gets `Ar =
   true` baked into the returned definition's type, which `FlagsArgOf`
   then reads. *Honest note:* the `const` modifier here is defensive,
   not strictly load-bearing — TS's regular inference *already* narrows
   `arbprec: true` to literal `true` when the parameter constraint is
   `Ar extends boolean`, because TS picks the narrowest type satisfying
   both the constraint and the input. Verified in an isolated probe
   (`dt1`/`dt2` parallel functions, no-const and const, both narrow
   identically; a `boolean` variable widens as expected for both).
   Kept for consistency with the existing `const Fl extends FlagSchema`
   sibling slot and as belt-and-suspenders for unusual call patterns
   (e.g. `arbprec: someBooleanExpression` would widen to `boolean` —
   honest, since we can't statically know the value).

3. **`FlagsArgOf<D>` becomes a two-tier conditional, no intersection.**

   ```ts
   D extends { arbprec?: infer Ar }
     ? [Exclude<Ar, undefined>] extends [true]
       ? // arbprec — lift `precision?: bigint`, fold in any declared flags
         D extends { flags?: infer Fl }
           ? Fl extends FlagSchema
             ? [keyof Fl] extends [never]
               ? { precision?: bigint }
               : Partial<FlagsOf<Fl>> & { precision?: bigint }
             : { precision?: bigint }
           : { precision?: bigint }
       : // non-arbprec — strict declared flags or strict-empty
         D extends { flags?: infer Fl }
           ? Fl extends FlagSchema
             ? [keyof Fl] extends [never]
               ? Record<string, never>
               : Partial<FlagsOf<Fl>>
             : Record<string, never>
           : Record<string, never>
     : Record<string, never>;
   ```

   The `[.]`-wrappers on `extends` are load-bearing: `Ar` from
   `infer Ar` on an *optional* field is `true | undefined`, and naked
   `Exclude<true | undefined, undefined> extends true` would
   distribute over the union. `[Exclude<…>] extends [true]` blocks
   distribution. Same trick on `[keyof Fl] extends [never]`.

   `EmptyFlags` (the default `Fl`) is now `Record<never, never>` (was
   `Record<string, never>`) so `FlagsOf<EmptyFlags>` is genuinely
   `{}` — without keys, without the poisoning `[K in string]: never`
   index signature — which is what the comment next to it had *claimed*
   it was all along. This change is the only `EmptyFlags`-touching
   edit; downstream is unaffected because every caller that cares only
   reads `keyof EmptyFlags` (now `never`, was `string`) or
   `FlagsOf<EmptyFlags>` (now `{}`, was `Record<string, never>` —
   functionally identical for non-intersection uses).

4. **Two `as never` casts deleted from `compose.test.ts`** — the bead's
   acceptance witness. The remaining `input as never` on those same
   lines is a *separate* concern (the loose-`Value` builder doesn't
   narrow to the tool's input record shape) and not in `0y27`'s scope.

## Why these choices

- **No intersection.** The first cut assembled `<flags-branch> &
  <arbprec-lift>` and immediately ran into the tension that took two
  iterations to resolve:
  - the flags branch's empty case wants to be *strict*
    (`Record<string, never>`, "no flags allowed") so non-arbprec tools
    reject random keys at compile time;
  - but intersecting strict-empty with `{ precision?: bigint }`
    poisons the `precision` slot to `never`;
  - loosening to `{}` fixed the intersection but accepted any flag on
    any no-flag tool — `wb.modPow(input, { precision: 50n })` would
    silently typecheck. The negative test caught this immediately.

  The nested conditional sidesteps the whole intersection by *replacing*
  the strict-empty with the precision-only type in the arbprec branch
  and folding declared flags in only when `Fl` has actual keys. Cleaner
  semantically, and the diagnostic types TS produces on regression are
  more readable.

- **Defaults `Ar extends boolean = boolean` (not `= false`).** With the
  narrow `false` default, the *interface* `ToolDefinition<...>` (with
  unspecified `Ar`) read `arbprec?: false`, and every internal
  `def.arbprec === true` check became "this comparison appears to be
  unintentional because the types `false | undefined` and `true` have
  no overlap." Wide default removes that friction without weakening the
  literal-capture path — `defineTool`'s `const Ar` (and TS's regular
  narrowing) still drives `Ar = true` for arbprec tools at the call
  site.

- **Kept `EmptyFlags` private (still `type`, not `export`).** No tool
  needs to reference it directly. The widening from `Record<string,
  never>` to `Record<never, never>` is an internal cleanup that fixes
  a documentation-vs-reality gap (the existing comment claimed
  `FlagsOf<{}>` is `{}`; only after this change is that actually true).

- **Comment block above the lift documents the algebra**, including
  *why* the `[.]` brackets and the `[keyof Fl] extends [never]`
  discriminator are load-bearing. That's the kind of code where the
  *why* is the entire content; a future reader who removes either
  guard would find these tests RED, and the comment tells them which
  invariant they tripped.

## Frictions surfaced

- **The first positive type-level test was too loose.** I asserted
  `FlagsArgOf<typeof hypergeometricPfqDef> extends { precision?:
  bigint }`. That passed even when the lift was completely *gone* —
  because `{}` trivially extends `{ precision?: bigint }` (an *optional*
  field is satisfied by its absence). A mutation-proof requires
  `Required<FlagsArgOf<...>> extends { precision: bigint }`: forcing
  the slot to actually be present in the type. Caught only by running
  the mutation — the assertion's looseness wasn't visible by inspection.
  Rule 7 ("a test that asserts only 'didn't throw' is broken") applies
  equally to type-level: an `extends` assertion that holds on the
  empty type isn't a test, it's a syntactic check.

- **The `const Ar` modifier turned out to be redundant.** I added it
  reflexively, by analogy with `const Fl extends FlagSchema` next to
  it, and the bead description explicitly proposed it as the
  literal-preserving mechanism. But the isolated probe showed plain
  inference (no `const`) narrows `arbprec: true` to `true` whenever
  the type parameter is constrained `Ar extends boolean` — TS picks the
  narrowest. I kept `const` for the consistency / defensive reasons
  documented inline, but renamed the comments to be honest. If the
  bead's diagnosis was "without `const`, the literal widens to
  `boolean`," that diagnosis was slightly off; the *real* missing
  piece was the slot being typed `arbprec?: boolean` instead of
  `arbprec?: Ar`. Mutation proof confirms: re-widening just the slot
  (leaving `const Ar` in place) still kills the lift; removing just
  the `const` (leaving the `Ar` slot) does *not*.

- **Two iterations on the negative test.** First version asserted only
  the positive lift; the `@ts-expect-error` on `wb.modPow(input,
  { precision: 50n })` actually compiled clean because `{}` accepts
  any object. Required adding the `[keyof Fl] extends [never] ?
  Record<string, never> : ...` discriminator on the non-arbprec branch
  too. The strict-empty fallback `Record<string, never>` is what makes
  the negative case bite — `{ precision: 50n }` is rejected because
  `bigint extends never` is false.

## Acceptance

- **Two `as never` casts deleted** at `compose.test.ts:566` and
  `:634` — the bead's stated acceptance criterion (`typed-barrel call
  wb.hypergeometricPfq(input, { precision: 50n }) typechecks with no
  'as never' cast`).
- **31 compose tests pass** (was 28; +3 new `typed barrel — arbprec
  lift (bead 0y27)` block):
  1. positive type-level — `Required<FlagsArgOf<typeof
     hypergeometricPfqDef>> extends { precision: bigint }`,
     mutation-proven to RED on lift drop and slot re-widening;
  2. negative type-level — `@ts-expect-error` pinning that
     `FlagsArgOf<typeof modPowDef>` *rejects* `{ precision: 50n }`,
     where `modPow` is symbolic. The directive itself becomes invalid
     (and `tsc` fails with "unused @ts-expect-error") if a future
     refactor accidentally lifts `precision` onto every tool;
  3. runtime — cast-free end-to-end call mirrors the existing
     `wb.hypergeometricPfq(input, { precision: 30n })` integration
     test, with the second arg's `as never` removed.
- **Mutation-proven** (Rule 6):
  1. drop the `{ precision?: bigint }` lift in `FlagsArgOf` → positive
     test RED (`Type 'true' is not assignable to type '"MISSING
     ARBPREC LIFT"'`);
  2. re-widen the slot to `arbprec?: boolean` on `ToolDefinition` →
     positive test RED *and* every typed-barrel arbprec call site goes
     RED (`Type 'bigint' is not assignable to type 'never'`) because
     the lift collapses back to the strict-empty fallback.
- `bun test packages/contract/` 57/57 pass; `bun test packages/compose/`
  31/31; `bun test packages/bigfloat/` 257/257 — no fallout from the
  `EmptyFlags` widening.
- Full `bun run check` — green (see commit).

## Pointers

- `docs/adr/0020-arbitrary-precision-tier.md` — the `arbprec: true`
  tier; runtime contract for the `--precision=<int>` standard flag.
- `docs/adr/0012-composition-layer.md` — the byte-identical contract
  between subprocess and in-process surfaces that this lift makes
  cast-free.
- `docs/worklog/083-arbprec-precision-flag-wiring.md` — the prior
  worklog landing `lc1`/`rn2`, the *runtime* path; this shard finishes
  the type-level half.
- `packages/contract/src/runner.ts` — `FlagsArgOf`, `ToolDefinition.Ar`,
  `defineTool.Ar`, `EmptyFlags`.
- `packages/compose/test/compose.test.ts` — `describe("typed barrel —
  arbprec lift (bead 0y27)")` block, the type-level assertions and
  mutation-proof commentary.
