import CoreGraphics
import Foundation
import PikosCore

/// Turning a wall-clock schedule into a position in a day column.
///
/// The shared Rust decides structure (cascade column, all-day row and span) and stops
/// there: pixel mapping encodes one renderer's metrics, so iOS does its own.
///
/// Everything here is string arithmetic on wall-clock values, with no
/// `DateFormatter` or `Calendar`. It runs once per block per frame, and routing
/// a wall clock through a type that carries a time zone lands an event an hour
/// out twice a year.
public enum CalendarGeometry {

    /// How tall an hour is, and the floors that keep short events legible.
    ///
    /// A 15-minute slot at 64pt per hour is 16pt, well under a 44pt touch
    /// target, and an hour tall enough to tap it would show barely six hours.
    /// So short events keep their true position and gain a minimum height.
    public struct Metrics: Equatable, Sendable {
        public var hourHeight: CGFloat
        /// Floor on a timed block's height, so a zero-length event stays visible and hittable.
        public var minBlockHeight: CGFloat
        public var allDayRowHeight: CGFloat

        public init(
            hourHeight: CGFloat = 64,
            minBlockHeight: CGFloat = 22,
            allDayRowHeight: CGFloat = 24
        ) {
            self.hourHeight = hourHeight
            self.minBlockHeight = minBlockHeight
            self.allDayRowHeight = allDayRowHeight
        }

        public var dayHeight: CGFloat { hourHeight * 24 }

        /// The minimum block height as minutes of this grid, which is how the
        /// column layout reads it: a floored block overlaps what its drawn height covers.
        public var shortestBlockMinutes: Double { Double(minBlockHeight / hourHeight * 60) }
    }

    // MARK: - Reading wall-clock strings

    /// The `YYYY-MM-DD` part of a wall-clock string, or nil if it is too short.
    ///
    /// Zero-padded ISO dates compare correctly as strings, which the storage format guarantees.
    public static func day(of iso: String) -> String? {
        iso.count >= 10 ? String(iso.prefix(10)) : nil
    }

    /// True when the value carries no time.
    public static func isAllDay(_ iso: String) -> Bool {
        !iso.contains("T")
    }

    /// Minutes from midnight, for the time half of a wall-clock string.
    ///
    /// Nil for an all-day or malformed value. Seconds are floored, so a block's
    /// top edge never renders below its stated minute.
    public static func minutesIntoDay(_ iso: String) -> Int? {
        guard iso.count >= 16 else { return nil }
        let characters = Array(iso)
        guard characters[10] == "T", characters[13] == ":" else { return nil }
        guard
            let hour = Int(String(characters[11...12])),
            let minute = Int(String(characters[14...15]))
        else { return nil }
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return hour * 60 + minute
    }

    // MARK: - Placing a timed block

    /// Where a timed event sits in the column headed `day`, in points.
    ///
    /// Both edges are clamped into the day, so an event that began yesterday
    /// starts at the top and one running into tomorrow ends at the bottom.
    ///
    /// Returns nil when the event does not touch this day, a caller error.
    public static func placement(
        start: String,
        end: String?,
        on day: String,
        metrics: Metrics
    ) -> (top: CGFloat, height: CGFloat)? {
        guard let startDay = self.day(of: start) else { return nil }

        // No stored end is a point in time: minimum height, not an assumed duration.
        let endDay = end.flatMap { self.day(of: $0) }

        let startsBefore = startDay < day
        let endsAfter = (endDay ?? startDay) > day
        guard startsBefore || startDay == day else { return nil }
        guard endsAfter || (endDay ?? startDay) >= day else { return nil }

        let startMinute = startsBefore ? 0 : (minutesIntoDay(start) ?? 0)
        let endMinute: Int
        if endsAfter {
            endMinute = 24 * 60
        } else if let end, let minute = minutesIntoDay(end) {
            endMinute = minute
        } else {
            endMinute = startMinute
        }

        let perMinute = metrics.hourHeight / 60
        let top = CGFloat(startMinute) * perMinute
        let height = max(metrics.minBlockHeight, CGFloat(endMinute - startMinute) * perMinute)

        // A late event given the minimum height would otherwise hang past midnight.
        let clampedTop = min(top, metrics.dayHeight - metrics.minBlockHeight)
        let clampedHeight = min(height, metrics.dayHeight - clampedTop)
        return (max(0, clampedTop), max(metrics.minBlockHeight, clampedHeight))
    }

    /// Horizontal inset for a cascade column, as a fraction of the day column.
    ///
    /// Overlapping events cascade, each offset right of its host so the host's
    /// title stays readable, rather than splitting the width into slivers.
    ///
    /// The desktop's "+N more" pill is not reproduced: it needs cluster
    /// membership and the Rust reports only a per-event depth. Instead the inset
    /// stops growing at depth 3, so events past the cap share an inset and the
    /// deeper one covers the shallower.
    public static func cascadeInset(depth: Int, columnWidth: CGFloat) -> CGFloat {
        let step: CGFloat = 0.14
        let cappedDepth = CGFloat(min(max(depth, 0), 3))
        return columnWidth * step * cappedDepth
    }

    // MARK: - Touching an empty slot

    /// The minute a touch in a day column lands on, snapped to a slot.
    ///
    /// Snapped down to `slotMinutes`, not to the nearest: a finger resting a
    /// little below the 3pm rule meant 3pm, and rounding up would land after the
    /// line it was on.
    ///
    /// Clamped into the day, so a press at the very bottom yields the last slot.
    public static func slotMinute(
        atY y: CGFloat, metrics: Metrics, slotMinutes: Int = 30
    ) -> Int {
        let slot = max(1, slotMinutes)
        let perMinute = metrics.hourHeight / 60
        guard perMinute > 0 else { return 0 }
        let minute = Int((y / perMinute).rounded(.down))
        let snapped = (minute / slot) * slot
        return min(max(0, snapped), 24 * 60 - slot)
    }

    public enum BlockEdge: Sendable {
        case top, bottom
    }

    /// A timed page with one edge dragged to `minute`; `resizeSchedule` in Rust holds the rule.
    public static func resized(
        start: String, end: String?, edge: BlockEdge, toMinute minute: Int
    ) -> (start: String, end: String)? {
        let edge: PikosCore.BlockEdge = edge == .top ? .top : .bottom
        return resizeSchedule(start: start, end: end, edge: edge, minute: Int32(minute))
            .map { ($0.start, $0.end) }
    }

    /// The minutes a new block covers while a finger that pressed at `from` is drawn to `y`;
    /// `stretchNewBlock` in Rust holds the rule.
    public static func stretched(from start: Int, toY y: CGFloat, metrics: Metrics) -> (start: Int, end: Int) {
        let perMinute = metrics.hourHeight / 60
        guard perMinute > 0 else { return (start, start + 15) }
        let range = stretchNewBlock(pressed: Int32(start), reached: Double(y / perMinute))
        return (Int(range.start), Int(range.end))
    }

    /// The wall-clock string for a minute of a day, like `2026-09-14T15:30:00`.
    /// The inverse of `minutesIntoDay`; seconds are always zero.
    public static func wallClock(day: String, minute: Int) -> String {
        let clamped = min(max(0, minute), 24 * 60 - 1)
        return String(format: "%@T%02d:%02d:00", day, clamped / 60, clamped % 60)
    }

    // MARK: - Dropping a page on a day

    /// The schedule a page dropped at `minute` of `day` takes; `dropSchedule` in Rust holds the rule.
    public static func dropSchedule(
        day: String, minute: Int, previousStart: String?, previousEnd: String?
    ) -> (start: String, end: String?) {
        let dropped = PikosCore.dropSchedule(
            day: day, minute: Int32(minute), previousStart: previousStart, previousEnd: previousEnd)
        return (dropped.start, dropped.end)
    }

    /// A position over a day into a minute, snapped down to the quarter hour the desktop snaps to.
    public static func dropMinute(atY y: CGFloat, firstHour: Int, hourHeight: CGFloat) -> Int {
        guard hourHeight > 0 else { return firstHour * 60 }
        let minute = firstHour * 60 + Int((y / hourHeight * 60).rounded(.down))
        return min(max(0, (minute / 15) * 15), 24 * 60 - 15)
    }

    // MARK: - The now indicator

    /// Where "now" sits in a day column, or nil if that day is not today.
    ///
    /// Takes both as wall-clock strings so tests need not wait for a particular minute.
    public static func nowOffset(now: String, on day: String, metrics: Metrics) -> CGFloat? {
        guard self.day(of: now) == day, let minute = minutesIntoDay(now) else { return nil }
        return CGFloat(minute) * metrics.hourHeight / 60
    }
}
