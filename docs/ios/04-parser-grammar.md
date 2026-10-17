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
model. That is bigger than nine hand-written patterns, but it is _mechanical_:
each piece is a regex and twenty lines of field assignment, and there is a
reference implementation to check every one against. Hand-writing nine families
would have been smaller to type and much harder to be sure about, because
nothing would have told me where the boundary fell until a user found it.

So `crates/pikos-core/src/nlp/` is a port of that subset, not a
reimplementation:

| Module          | What it is                                                    |
| --------------- | ------------------------------------------------------------- |
| `jsdate.rs`     | JavaScript `Date` arithmetic — overflow normalisation and all |
| `components.rs` | the known/implied split the certainty flags come from         |
| `dict.rs`       | word lists and the regex fragments built from them            |
| `engine.rs`     | the parse/refine pipeline                                     |
| `parsers.rs`    | sixteen parsers                                               |
| `refiners.rs`   | thirteen refiners, in the order that decides the result       |

`jsdate.rs` is the one that looks like over-engineering and is not. chrono-node
_relies_ on `new Date(2026, 1, 31)` silently becoming 3 March: that is how
`isValidDate` rejects 31 February. Wrapping `chrono::NaiveDate`, which returns
`None` instead, would have changed which results survive the filter.

### What this means for the caveat

The caveat above no longer applies in the form it was written. `end of next
month` and `a week on Tuesday` do not parse under this engine — but they do not
parse under chrono-node either; they were never in the nine families because
they were never in the grammar. The engine's coverage _is_ chrono's coverage for
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
  pinned reference. Says _which family_ broke.
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

---

## Addendum 2: the rest of `parseInput`

The date engine was the part with no Rust equivalent. The other 861 lines of
`parser.ts` — cadence, tags, folders, priorities, durations, windows, and the
title that is whatever survives them — are now ported too, in
`crates/pikos-core/src/nlp/quick_add/`.

| Module          | What it is                                                            |
| --------------- | --------------------------------------------------------------------- |
| `text.rs`       | extract-and-strip regex replacement, and `date-fns` arithmetic        |
| `tokens.rs`     | the rewrites, then `#tag` / `~folder` / `!urgent` / duration / window |
| `recurrence.rs` | cadence detection, RRULE strings, weekly expansion                    |
| `mod.rs`        | the pipeline, date assembly, title cleanup, result type               |

`text.rs` carries `date-fns` semantics deliberately kept apart from the date
engine's `jsdate.rs`: `addMonths` on 31 January clamps to 28 February, where
JavaScript's `setMonth` rolls to 3 March. Both appear in the original — one in
`parseInput`, one inside chrono-node — and getting them the wrong way round is
a silent few-days error.

The pipeline order is load-bearing and matches the reference: rewrite, extract
markers, detect cadence, _then_ read the date. Cadence has to come first or
"every tuesday" is consumed as the date "tuesday" and the recurrence is lost.

### How it is graded

`crates/pikos-core/tests/quick_add_parity.rs` runs all 2,219 cases of
`parser.json` — 317 inputs at 7 reference times, of which 756 are recurring, 98
finite, and the rest single. The test asserts the shape of what it compared
(every case reached, enough recurring, finite and priority-carrying cases among
them), because a comparison that silently skipped everything would pass too.

All 2,219 passed on the first run. Eighteen mutations were then applied —
window arithmetic, the "tonight" cutoff, priority clearing, the connector
strip, week-start for expansion, `UNTIL` inclusivity, `INTERVAL` emission, each
cadence precedence rule — and every one failed the suite. Sixteen were caught
by the corpus itself (3 to 147 cases each); the two it cannot reach are the
"tonight" cutoff at exactly 20:00 (no corpus reference falls on that hour) and
a plural day list deferring to a cadence already set ("run m/w/f tuesdays").
Both are now unit-tested against behaviour read off the reference with
`pnpm --filter @pikos/core probe:parser`.

One faithful quirk worth naming: "every 2 weeks mondays" comes out as
`FREQ=WEEKLY;BYDAY=MO`, losing the interval, because the plural-day rule
rebuilds the cadence from scratch. That is what the reference does, so it is
what this does, and there is a test saying so rather than a reader wondering.

### The FFI surface

`parse_quick_add(input, reference)` returns a `QuickAddResult` — single, finite
or recurring. `reference` is a wall-clock ISO string rather than the clock, so
the same line parses the same way in a test, a widget and the app; a malformed
one returns `nil` rather than a guess. Priority crosses as a three-state
`PriorityEdit` (`unchanged` / `cleared` / `set`), because writing nothing and
writing `!0` are different edits and an optional cannot hold both.

---

## Addendum 3: what fuzzing found that the corpus could not

The caveat at the top of this document said the corpus is a lower bound: 317
inputs scraped from the test suite, which is what the author thought to test.
The port passed all 2,219 of its cases on the first run. That was not evidence
of much, and it turned out not to be.

`packages/core/scripts/parser-grammar/fuzz.ts` composes lines from fragments —
titles, dates, times, ranges, cadences, windows, durations, markers, and junk
that has no business parsing — **in random order**, runs them through the
TypeScript reference, and writes what it got.

Random order is the point. The parser is a pipeline whose ordering is
load-bearing: cadence before date, intervals before day words, "biweekly"
before "weekly". Ordering bugs cannot show up in inputs written one feature at
a time, and every input in the hand-written corpus is written one feature at a
time.

The first sweep — 20,000 lines × 7 reference times — found **124 divergent
inputs**, in five classes:

| What was wrong                                                  | Where                  |
| --------------------------------------------------------------- | ---------------------- |
| A series dropped the end date a time range had given it         | `quick_add/mod`        |
| A series with a time but no date took the wrong branch entirely | `quick_add/mod`        |
| `ExtractTimezoneOffsetRefiner` was missing                      | `refiners`             |
| `String.substring`'s argument swap was not reproduced           | `engine`               |
| A fixed week budget capped long series below the real limit     | `quick_add/recurrence` |

A second sweep with a different seed, after all five were fixed, found a
**sixth** class the first had missed: a weekly rule injected the weekday of the
_resolved date_ rather than the weekday the text named, so "every 2 weeks on
friday dec 28" — a Friday stated over a Monday — became a Monday rule.

Three of the six deserve naming, because none of them is the kind of thing
re-reading the code finds.

**The `substring` swap.** JavaScript's `String.prototype.substring` swaps its
arguments when the start is past the end. Results can overlap — a refiner that
extends one result's text pushes its end past the next result's start — and the
reference then asks for the text "between" them with the bounds reversed. It
gets the overlapping text back, which fails the merge patterns and leaves the
pair for overlap removal. A Rust slice returns empty instead, which reads as
"nothing between these", and the two merge: `april 18-25 2024-02-26` came back
as `april 18-25 2024-0202`.

**The timezone offset.** This engine was built with no timezone concept, on the
grounds that a wall-clock app has nothing for an offset to apply to, and the
gap was documented as "a written-out timezone stays in the title". The fuzzer
showed that was too narrow a description of it. `ExtractTimezoneOffsetRefiner`
looks for a sign and one or two digits after whatever was just matched, and a
hyphen after a date is not rare: in "may 2 to 10 2026-04-01" the month-name
parser claims "may 2 to 10 2026", and the refiner reads the "-04" of the
_following date_ as UTC-4. The user typed two dates and got a four-hour shift.
It is now reproduced, because parity is the bar — but it is a bug in the
reference, and the fix belongs there, where it would land for both platforms at
once.

**The invisible second cap.** Series expansion had a documented cap of 1,000
occurrences and an undocumented `MAX_WEEKS = 520` beside it. The second one
bound first: a 2,026-page series stopped at 1,038 while the cap it was supposed
to respect still had room. The week budget is now derived from the limit, so
there is one bound rather than two, and the visible one wins.

That 2,026-page series is itself worth knowing about. "mon/wed/fri 10 times"
resolves "fri 10" to a concrete date, leaving "2026 times" behind, which the
window rule reads as a count of 2026. The reference then hands that number
straight to the expander — it has no cap of any kind, so "99999 times" would
try to build 99,999 pages. This port caps at 10,000, which is a deliberate
divergence at the extreme and the one place the two do not agree.

### Where it stands

Three independent seeds, 20,000 / 25,000 / 30,000 lines each, at seven
reference times: **no divergences**. Every class found is also pinned by a unit
test, because a regression corpus says _that_ something broke and a unit test
says _what_.

A 500-line sample is committed as `tests/corpus/parser-fuzz.json`, seeded and
regenerable, with every input that ever diverged included by name in
`fuzz-regressions.json`. CI generates a fresh 8,000-line sweep on every run with
the run number as its seed, so successive runs explore different ground and a
failure uploads the offending inputs as an artifact.

The honest summary: the hand-written corpus proved the port handled what
someone thought to write down. The fuzzer proved it handles what they did not —
and it took six fixes to get there.

### The same technique on recurrence

`parity.rs` grades the recurrence port — next occurrence, carried end, anchor
snapping, range expansion — against 35 hand-written cases, and found nothing.
That is the same thing the 317-input parser corpus said.

`fuzz-recurrence.ts` composes rules the same way: frequencies, intervals,
`BYDAY` including ordinals like `3TU`, `BYMONTHDAY` including days a month does
not have, `BYHOUR`, `COUNT` and `UNTIL`, exdates placed near the anchor so they
have a real chance of landing on an occurrence, and anchors chosen for their
edges — a leap day, month ends, both sides of a DST transition, a year end.

Three seeds of 20,000 cases each found **no divergences**, which is a different
statement from "the 35 cases passed": five mutations of the Rust side — ignoring
exdates, treating all-day as timed, seeding the search at midnight instead of
end-of-day, dropping the wall-clock reapplication in snapping, and cutting the
occurrence limit — each fail between 393 and 4,750 comparisons. The corpus is
gradient, not a pass/fail bit.

One of those five is worth noting: the wall-clock reapplication in snapping
survived the first fuzz run, because every rule the generator produced inherited
its time from `DTSTART`, which makes "keep the anchor's time" and "keep the
occurrence's time" indistinguishable. Adding `BYHOUR` to the generator killed
it, with 2,394 differences. A fuzzer is only as good as the axes it varies, and
that one had to be added deliberately.

### And on calendar layout

Layout is the weakest case of all for hand-written scenarios, because the
behaviour is combinatorial. Which column an event lands in depends on which
others it overlaps and in what order they were considered; which row an all-day
bar takes depends on span lengths, ties broken by creation time, and gaps a
later event may or may not fit into. Thirty-two arrangements cannot cover that,
and nobody can write the one that breaks it — the difficulty is precisely that
it is not obvious which one does.

`apps/desktop/scripts/fuzz-calendar-parity.ts` composes days and weeks of
events: overlapping and back-to-back, zero-length, spilling over midnight in
either direction, wholly outside the day, and missing an end entirely. Creation
times come from a pool of four so ties are common, because a tiebreaker is only
tested when two things actually tie. It keeps the density guard from the
hand-written generator: every scenario is laid out at all three rendering
densities and a disagreement stops the run, because the port assumes column
assignment is pixel-independent.

Three seeds of 10,000 scenarios each: no divergences. Seven mutations of the
Rust side each fail between 21 and 3,193 scenarios.

One of the seven needed an axis added, the same way `BYHOUR` did for recurrence.
Both sorts fall back to the page id only after everything else ties, and a
generator that emits pages already in id order makes that tiebreak invisible —
a stable sort preserves the order either way. Shuffling the pages before layout
killed the mutation with 270 differences, and is the more realistic input
besides: layout is handed whatever order the database returned.

That is twice now that a fuzzer passed for the wrong reason until an axis was
added deliberately. It is worth stating as a rule: a clean fuzz run is evidence
about the axes the generator varies, and about nothing else. Mutation testing
is what tells you which those are.
