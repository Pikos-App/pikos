import Foundation

/// Reads the UTC instant columns the data layer writes.
///
/// Pikos stores dates two ways, and they are not interchangeable:
///
///   - **UTC instants** (`created_at`, `updated_at`, `deleted_at`), written by
///     Rust's `now_iso()` with milliseconds and a `Z` suffix. `utc(_:)` reads them.
///   - **Local wall clocks** (`scheduled_start` and friends), written with no
///     zone suffix. 09:00 means 09:00 wherever the reader is, so they must not
///     be converted. `wallClock(_:in:)` reads them; `utc(_:)` must not be
///     pointed at them.
///
/// A wall clock read as UTC shifts by the reader's offset: invisible in London,
/// a day off near midnight in Auckland.
public enum StorageTimestamp {
    /// Parses a UTC instant column.
    ///
    /// Returns nil for anything unreadable so the caller can show the raw value:
    /// a malformed stamp is worth seeing; a plausible wrong date is not.
    public static func utc(_ stamp: String) -> Date? {
        // Each style rejects the other's shape, so try both.
        (try? withMillis.parse(stamp)) ?? (try? wholeSeconds.parse(stamp))
    }

    /// Parses a local wall-clock column, in either of its shapes: `yyyy-MM-dd`
    /// for an all-day value, `yyyy-MM-ddTHH:mm:ss` for a timed one.
    ///
    /// Resolved in `calendar`'s time zone (the reader's by default, which is what
    /// makes 09:00 mean 09:00 everywhere) on the Gregorian calendar, which is
    /// what the stored string is written in.
    ///
    /// An all-day value lands on noon, since a spring-forward can delete midnight.
    ///
    /// Field ranges are checked; the rest is left to `Calendar`. A timed value
    /// inside a DST gap matches no instant, and `Calendar` shifting it forward
    /// beats refusing to show the page.
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
