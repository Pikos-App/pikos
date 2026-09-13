import Foundation

/// Reads the UTC instant columns the data layer writes.
///
/// Pikos stores dates two ways, and they are not interchangeable:
///
///   - **UTC instants** — `created_at`, `updated_at`, `deleted_at`. Rust's
///     `now_iso()` formats `%Y-%m-%dT%H:%M:%S%.3fZ`: milliseconds, `Z` suffix.
///     These are moments in time and must be read as UTC. This type reads them.
///   - **Local wall clocks** — `scheduled_start` and friends, written by
///     `now_local_iso()` with no zone suffix at all. 09:00 means 09:00 wherever
///     the reader is, so these must *not* be converted, and this type must not
///     be pointed at them. `ScheduleLabel` reads those.
///
/// Confusing the two fails quietly in the worst way: a wall clock read as UTC
/// shifts by the reader's offset, which is invisible in London and wrong by a
/// day near midnight in Auckland. Hence one named place for the instant format
/// rather than a format string copied into every view that shows one.
///
/// Here rather than in the app target so it can be tested without a simulator —
/// the same reason `CalendarGeometry` lives here.
public enum StorageTimestamp {
    /// Parses a UTC instant column.
    ///
    /// Returns nil rather than a substitute for anything it cannot read, so the
    /// caller can fall back to showing the raw value. A malformed stamp is
    /// worth seeing; a plausible wrong date is not.
    public static func utc(_ stamp: String) -> Date? {
        // Fractional seconds are not optional within one style: a style that
        // requires them rejects a stamp without, and one that forbids them
        // rejects a stamp with. Only `now_iso()` writes these columns today and
        // it always emits milliseconds, but a stamp arriving from an import or
        // a future writer should still read as a date.
        (try? withMillis.parse(stamp)) ?? (try? wholeSeconds.parse(stamp))
    }

    private static let withMillis = Date.ISO8601FormatStyle(
        includingFractionalSeconds: true, timeZone: .gmt)
    private static let wholeSeconds = Date.ISO8601FormatStyle(
        includingFractionalSeconds: false, timeZone: .gmt)
}
