# Pikos docs

The parts of how Pikos works that you'd otherwise have to read the source to work out.

- **[functionality-matrix.md](./functionality-matrix.md)**: every user-facing operation
  against the origin of the thing it acts on. Made in Pikos, mirrored live from an external
  calendar, or a mirror whose link got cut. Each cell names the guard behind it, so a "no"
  is something you can check rather than take on faith.
- **[glossary.md](./glossary.md)**: the domain vocabulary, one definition each.
- **[time-handling.md](./time-handling.md)**: why a scheduled time is stored as the clock
  reading you saw instead of a UTC instant, and where that model stops.

These describe 0.4.0. The code is the source of truth for what happens. These files are
here for the why, which code can't carry.
