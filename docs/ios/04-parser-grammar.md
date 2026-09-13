# What the quick-add parser actually needs from chrono-node

**Measured**, not estimated. Re-run with
`pnpm --filter @pikos/core measure:parser-grammar`; the raw output is
`parser-grammar.json` beside this file.

## Why this exists

`01-business-logic-inventory.md` records that porting `parseInput` to Rust is
larger than its 861 lines suggest, because it depends on three things
chrono-node provides and no Rust crate does: per-field certainty flags, the
match index and extent, and range ends. It set out three options and said the
third — deliberately narrowing what quick-add supports — was worth measuring
before estimating.

This is that measurement.

## Method

`scripts/parser-grammar/` installs a recording stand-in in chrono's place at
bundle time and runs every input in the parity corpus through the real parser.
Nothing in `parser.ts` is instrumented, so what is observed is exactly what the
shipped parser asks for — after its own pre-processing, which is the part that
matters. The parser rewrites "tonight", "this afternoon", "last monday" and
similar into explicit forms before chrono ever sees them, so the grammar
reaching chrono is much smaller than the grammar users can type.

## Result

Of 317 corpus inputs, **179 reach chrono**; the other 138 are resolved entirely
by the parser's own handling (recurrence, tags, priorities, folders, or no date
at all). Those 179 collapse to **92 distinct matched strings in 9 families**:

| Family            | Inputs | Forms | Examples                                                           |
| ----------------- | -----: | ----: | ------------------------------------------------------------------ |
| bare time         |     59 |    15 | `3pm`, `14:00`, `at 3:30pm`, `at 11:59pm`                          |
| today/tomorrow    |     35 |    11 | `today`, `tomorrow at 9am`                                         |
| range             |     30 |    21 | `3pm to 5pm`, `april 18-25`, `dec 28 to jan 3`, `monday to friday` |
| weekday           |     22 |    17 | `monday`, `next friday at 3pm`, `this wednesday`, `on friday`      |
| month-day         |     17 |    15 | `may 1`, `march 20 at 3pm`, `apr 13 2026 4pm`, `march20`           |
| named time of day |      4 |     3 | `noon`, `midnight`, `morning`                                      |
| relative offset   |      4 |     3 | `in 3 days`, `in 2 weeks`, `in 1 hour`                             |
| ISO date          |      4 |     3 | `2026-03-09`                                                       |
| numeric date      |      3 |     3 | `3/16`, `16/3`, `4/15 at 10am`                                     |
| relative period   |      1 |     1 | `next week`                                                        |

Nine families. Not "all of chrono-node", which also carries German, French,
Japanese, Dutch, Portuguese, Russian, Ukrainian and Chinese locales, timezone
abbreviations, ordinal weekday-of-month expressions, and a casual/strict
distinction — none of which this parser reaches.

### The certainty flags are not mysterious

The parser branches on which granularities chrono was certain about. Across the
corpus there are 12 distinct combinations, and every one is a direct
consequence of which family matched:

| Combination                    | Inputs | Comes from                        |
| ------------------------------ | -----: | --------------------------------- |
| hour, minute                   |     66 | bare time                         |
| day, month                     |     29 | month-day without a year          |
| day, hour, minute, month, year |     27 | full datetime                     |
| day, month, year               |     19 | today/tomorrow, ISO, numeric date |
| weekday                        |     12 | bare weekday                      |
| hour, minute, weekday          |     11 | weekday + time                    |
| day, hour, minute, month       |      6 | month-day + time                  |
| hour                           |      3 | named time of day                 |
| day, month, weekday, year      |      2 | weekday resolved to a date        |
| (none)                         |      2 | matched but wholly uncertain      |
| day, …, second, year           |      1 | time with seconds                 |
| month                          |      1 | bare month name                   |

A hand-written parser sets these as it matches, because "which fields did this
pattern fill in" is the same question. The flags looked like a hard dependency
when reading the call site; measured, they are bookkeeping.

## What this means for the estimate

The honest reframing: the work is not _porting chrono-node_. It is writing a
parser for nine pattern families, each of which sets known fields, plus a range
combinator over them, plus the match extent so the date can be cut out of the
title.

That is a well-bounded piece of work — meaningfully smaller than the inventory's
original framing, and squarely in reach of the corpus-graded approach already
used for recurrence and calendar layout. The corpus pins current behaviour for
all 317 inputs, so the port can be graded continuously rather than declared
finished.

## The caveat that matters

**The corpus comes from the test suite, not from users.** It is what the
author thought to test, which is a lower bound on what people type, not a
census. Two consequences worth holding onto:

1. The nine families are almost certainly right in _shape_ — they are the
   obvious ways to write a date — but the long tail is unmeasured. A user
   typing `end of next month` or `a week on Tuesday` gets a date today, via
   chrono, and would not under a hand-written parser unless it is added.
2. A Rust parser should therefore **fail visibly rather than silently**. When
   no pattern matches, quick-add should create the page without a date and say
   so, not guess. Today chrono's breadth hides the boundary; a narrower parser
   makes it real, and the user needs to be able to see where it is.

The safest sequencing follows from that: build the Rust parser, run it against
the corpus alongside the TypeScript one, and ship it behind a flag on desktop
first — the same approach that let recurrence and calendar layout land without
risk. Real usage will then show what the test suite did not.

---

## Addendum: what was actually built

The plan above — write a parser for the nine families and accept a narrower
boundary — was not what shipped. Reading chrono-node's source changed the
estimate in the other direction.

The English casual locale is **~1,400 lines**, and the part Pikos reaches is
eleven parsers and thirteen refiners over a shared known/implied component
model. That is bigger than nine hand-written patterns, but it is *mechanical*:
each piece is a regex and twenty lines of field assignment, and there is a
reference implementation to check every one against. Hand-writing nine families
would have been smaller to type and much harder to be sure about, because
nothing would have told me where the boundary fell until a user found it.

So `crates/pikos-core/src/nlp/` is a port of that subset, not a
reimplementation:

| Module          | What it is                                                       |
| --------------- | ---------------------------------------------------------------- |
| `jsdate.rs`     | JavaScript `Date` arithmetic — overflow normalisation and all     |
| `components.rs` | the known/implied split the certainty flags come from             |
| `dict.rs`       | word lists and the regex fragments built from them                |
| `engine.rs`     | the parse/refine pipeline                                        |
| `parsers.rs`    | sixteen parsers                                                  |
| `refiners.rs`   | thirteen refiners, in the order that decides the result          |

`jsdate.rs` is the one that looks like over-engineering and is not. chrono-node
*relies* on `new Date(2026, 1, 31)` silently becoming 3 March: that is how
`isValidDate` rejects 31 February. Wrapping `chrono::NaiveDate`, which returns
`None` instead, would have changed which results survive the filter.

### What this means for the caveat

The caveat above no longer applies in the form it was written. `end of next
month` and `a week on Tuesday` do not parse under this engine — but they do not
parse under chrono-node either; they were never in the nine families because
they were never in the grammar. The engine's coverage *is* chrono's coverage for
English casual text, so there is no new boundary for users to discover, and
nothing needs to fail visibly that did not already.

Two narrowings are real and deliberate, both recorded in the module docs:

1. **No timezones.** `3pm EST` parses as 3pm and leaves `EST` in the title,
   where chrono-node would absorb it and shift the result. Pikos stores
   wall-clock values, so there is nothing for an offset to apply to.
2. **English only, casual only.** The other eight locales and the strict
   configuration are not built. Quick-add never reaches them.

### How it is graded

Two corpora, both generated from the TypeScript reference:

- `date-expressions.json` — 644 cases: each distinct expression alone, at every
  pinned reference. Says *which family* broke.
- `date-calls.json` — 1,628 cases: what chrono-node was actually asked,
  recorded through the real parser. Whole titles, so it grades match extents
  and candidate choice. **596 of its cases contain no date at all**, which is
  what catches over-matching — the likelier failure mode, and the one a
  corpus of only-positive cases would miss entirely.

Both passed on the first run, which is not by itself evidence of anything.
Fifteen deliberate mutations — implied hour, overlap ordering, the `may` verb
check, each refiner removed in turn, pm arithmetic, slash-date field order —
were each confirmed to fail the suite. Five initially survived the corpora;
every one was a corpus gap rather than a test bug, and each is now covered by a
unit test whose expectation was read off the reference with
`pnpm --filter @pikos/core probe:chrono`, not reasoned out.

### What is still TypeScript

`parseInput`'s pre-processing: recurrence, tags, priority, folder, duration,
and the rewriting that turns "tonight" and "this afternoon" into explicit forms
before the date engine sees them. That is the rest of the port, and it is where
the remaining 138 corpus inputs live.
