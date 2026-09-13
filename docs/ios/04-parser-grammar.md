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
