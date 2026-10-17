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
///     the reader is, so these must *not* be converted. `wallClock(_:in:)`
///     below reads those; `utc(_:)` must not be pointed at them.
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

    /// Parses a local wall-clock column, in either of its shapes: `yyyy-MM-dd`
    /// for an all-day value, `yyyy-MM-ddTHH:mm:ss` for a timed one.
    ///
    /// Resolved in `calendar`'s time zone — the reader's own by default, which
    /// is what makes 09:00 mean 09:00 everywhere — and always on the Gregorian
    /// calendar, because that is the one the stored string is written in.
    ///
    /// An all-day value lands on noon rather than midnight. Midnight is the one
    /// instant a spring-forward can delete, and in a zone that moves at 00:00
    /// asking for it yields either nil or the previous day.
    ///
    /// Field ranges are checked; validity beyond that is left to `Calendar`. A
    /// timed value inside a DST gap — 02:30 on a day that jumps from 02:00 to
    /// 03:00 — is a real stored value that no instant matches, and having
    /// `Calendar` shift it forward is a better answer than refusing to show the
    /// page at all.
    public static func wallClock(_ stamp: String, in calendar: Calendar = .current) -> Date? {
        let halves = stamp.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false)
        guard let day = halves.first.map(String.init),
            let noon = DayLabel.date(from: day, in: calendar)
        else { return nil }
        guard halves.count == 2 else { return noon }

        let time = halves[1].split(separator: ":")
        guard time.count >= 2,
            let hour = Int(time[0]), let minute = Int(time[1]),
            (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        let second = time.count > 2 ? Int(time[2]) : 0
        guard let second, (0...59).contains(second) else { return nil }

        let gregorian = DayLabel.gregorian(like: calendar)
        var parts = gregorian.dateComponents([.year, .month, .day], from: noon)
        parts.hour = hour
        parts.minute = minute
        parts.second = second
        return gregorian.date(from: parts)
    }

    private static let withMillis = Date.ISO8601FormatStyle(
        includingFractionalSeconds: true, timeZone: .gmt)
    private static let wholeSeconds = Date.ISO8601FormatStyle(
        includingFractionalSeconds: false, timeZone: .gmt)
}
