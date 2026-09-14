import CoreGraphics
import Foundation

/// Turning a wall-clock schedule into a position in a day column.
///
/// The shared Rust decides *structure* — which cascade column a timed event
/// occupies, which row and span an all-day bar gets — and deliberately stops
/// there. Pixel mapping encodes one renderer's font metrics and row heights,
/// and inheriting the desktop's would be a bug dressed as reuse. This is iOS
/// making that call for itself.
///
/// Everything here is string arithmetic on wall-clock values, with no
/// `DateFormatter` and no `Calendar`. Two reasons. It is called once per block
/// per frame, and a formatter costs about a hundred microseconds. More
/// importantly, these values *are* wall clocks — `09:00` on a column headed
/// `2026-03-23` means nine in the morning, full stop — and routing them through
/// a type that carries a time zone is how an event lands an hour out twice a
/// year.
public enum CalendarGeometry {

    /// How tall an hour is, and the floors that keep short events legible.
    ///
    /// Not the desktop's numbers. Its `HOUR_HEIGHT` of 64px makes a 15-minute
    /// slot 16px, which is fine for a mouse and well under the 44pt touch
    /// target a finger needs. Rather than pick a bigger constant and call it
    /// solved — an hour tall enough to tap a 15-minute event would put barely
    /// six hours on a phone screen — short events keep their true position and
    /// gain a minimum *height*, so they stay both readable and roughly where
    /// they belong.
    public struct Metrics: Equatable, Sendable {
        public var hourHeight: CGFloat
        /// Floor on a timed block's height. A zero-length event still needs to
        /// be visible and hittable.
        public var minBlockHeight: CGFloat
        /// Pitch of one row in the all-day section.
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
    }

    // MARK: - Reading wall-clock strings

    /// The `YYYY-MM-DD` part of a wall-clock string.
    ///
    /// Dates compare correctly as strings when they are zero-padded ISO, which
    /// is what the storage format guarantees — the same property the Rust
    /// all-day packer relies on. Returns nil for anything too short to be a
    /// date rather than trusting the caller.
    public static func day(of iso: String) -> String? {
        iso.count >= 10 ? String(iso.prefix(10)) : nil
    }

    /// True when the value carries no time — an all-day schedule.
    public static func isAllDay(_ iso: String) -> Bool {
        !iso.contains("T")
    }

    /// Minutes from midnight, for the time half of a wall-clock string.
    ///
    /// Nil for an all-day value, which has no time to read, and for anything
    /// malformed. Seconds are floored rather than rounded: a block's top edge
    /// should never render below its stated minute.
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
    /// starts at the top and one running into tomorrow ends at the bottom. The
    /// Rust already reports which of those happened — `isContinuationBefore` and
    /// `isContinuationAfter` — so the renderer can cut the corresponding edge
    /// square and show that the block carries on.
    ///
    /// Returns nil when the event does not touch this day at all, which is a
    /// caller error rather than something to render as a zero-height sliver.
    public static func placement(
        start: String,
        end: String?,
        on day: String,
        metrics: Metrics
    ) -> (top: CGFloat, height: CGFloat)? {
        guard let startDay = self.day(of: start) else { return nil }

        // `end` is the *stored* end. Absent means a point in time, which gets
        // the minimum height — not a zero-height block, and not an assumed
        // duration the user never typed.
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

        // Never let a block overflow the grid it sits in: a late event given a
        // minimum height would otherwise hang past midnight.
        let clampedTop = min(top, metrics.dayHeight - metrics.minBlockHeight)
        let clampedHeight = min(height, metrics.dayHeight - clampedTop)
        return (max(0, clampedTop), max(metrics.minBlockHeight, clampedHeight))
    }

    /// Horizontal inset for a cascade column, as a fraction of the day column.
    ///
    /// Overlapping events cascade — each one offset to the right of its host so
    /// the host's title stays readable — rather than splitting the width, which
    /// at four events on a phone would leave four unreadable slivers.
    ///
    /// The desktop folds anything past depth 1 into a "+N more" pill. That is
    /// not reproduced here, deliberately: the pill needs the cluster's
    /// membership and the Rust reports only a per-event depth, so building it
    /// would mean sending cluster identity across the boundary for a case that
    /// is rare on a phone. Instead the inset stops growing, which keeps deep
    /// events on screen. The honest cost is that events past the cap sit at the
    /// same inset and the deeper one covers the shallower; `04-calendar.md`
    /// records it as the thing to revisit if dense days turn out to be common.
    public static func cascadeInset(depth: Int, columnWidth: CGFloat) -> CGFloat {
        let step: CGFloat = 0.14
        let cappedDepth = CGFloat(min(max(depth, 0), 3))
        return columnWidth * step * cappedDepth
    }

    // MARK: - Touching an empty slot

    /// The minute a touch in a day column lands on, snapped to a slot.
    ///
    /// A long press on empty grid means "a page here", and "here" has to be a
    /// time somebody would actually type. Nobody schedules anything for 14:37,
    /// so the touch is snapped down to the nearest `slotMinutes` — half an hour
    /// by default, which is what a calendar's own picker offers. Down rather
    /// than to the nearest, because a finger resting a little below the 3pm
    /// rule meant 3pm, and rounding it up to 3:30 would put the page after the
    /// line the finger was on.
    ///
    /// Clamped into the day, so a press at the very bottom of the grid yields
    /// the last slot rather than midnight tomorrow.
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

    /// The wall-clock string for a minute of a day — `2026-09-14T15:30:00`.
    ///
    /// The inverse of `minutesIntoDay`, for the one caller that starts from a
    /// position rather than a stored value. Seconds are always zero: a slot
    /// is a whole minute by construction.
    public static func wallClock(day: String, minute: Int) -> String {
        let clamped = min(max(0, minute), 24 * 60 - 1)
        return String(format: "%@T%02d:%02d:00", day, clamped / 60, clamped % 60)
    }

    // MARK: - The now indicator

    /// Where "now" sits in a day column, or nil if that day is not today.
    ///
    /// Takes both as wall-clock strings so it is testable without waiting for a
    /// particular minute to come round.
    public static func nowOffset(now: String, on day: String, metrics: Metrics) -> CGFloat? {
        guard self.day(of: now) == day, let minute = minutesIntoDay(now) else { return nil }
        return CGFloat(minute) * metrics.hourHeight / 60
    }
}
