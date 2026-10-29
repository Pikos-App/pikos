import CoreGraphics
import Foundation
import PikosCore

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
        /// The early and late hours folded into bands, or none.
        public var collapse: Collapse

        public init(
            hourHeight: CGFloat = 64,
            minBlockHeight: CGFloat = 22,
            allDayRowHeight: CGFloat = 24,
            collapse: Collapse = .none
        ) {
            self.hourHeight = hourHeight
            self.minBlockHeight = minBlockHeight
            self.allDayRowHeight = allDayRowHeight
            self.collapse = collapse
        }

        /// How tall the early hours are drawn: a band when folded, their hours when open.
        public var topBandHeight: CGFloat {
            collapse.isTopFolded ? Collapse.bandHeight : CGFloat(collapse.topHour) * hourHeight
        }

        /// Where the hours between the bands end.
        public var middleEnd: CGFloat {
            topBandHeight + CGFloat(collapse.bottomHour - collapse.topHour) * hourHeight
        }

        public var bottomBandHeight: CGFloat {
            collapse.isBottomFolded ? Collapse.bandHeight : CGFloat(24 - collapse.bottomHour) * hourHeight
        }

        public var dayHeight: CGFloat { middleEnd + bottomBandHeight }

        /// Where a minute of the day sits. Inside a folded band its hours are pressed into the band;
        /// everywhere else an hour is `hourHeight` tall, as the desktop's `mapHourToY` has it.
        public func y(atMinute minute: Double) -> CGFloat {
            let hour = minute / 60
            let top = Double(collapse.topHour)
            let bottom = Double(collapse.bottomHour)
            if hour <= top {
                return collapse.isTopFolded
                    ? CGFloat(hour / max(top, 1)) * topBandHeight : CGFloat(hour) * hourHeight
            }
            if hour >= bottom {
                let past = hour - bottom
                return middleEnd
                    + (collapse.isBottomFolded
                        ? CGFloat(past / max(24 - bottom, 1)) * bottomBandHeight : CGFloat(past) * hourHeight)
            }
            return topBandHeight + CGFloat(hour - top) * hourHeight
        }

        /// The minute at a point down the day: the inverse of `y(atMinute:)`.
        public func minute(atY y: CGFloat) -> Double {
            let top = Double(collapse.topHour)
            let bottom = Double(collapse.bottomHour)
            guard hourHeight > 0 else { return 0 }
            if y <= topBandHeight {
                return collapse.isTopFolded
                    ? Double(y / max(topBandHeight, 1)) * top * 60 : Double(y / hourHeight) * 60
            }
            if y >= middleEnd {
                let into = Double(y - middleEnd)
                let hours =
                    collapse.isBottomFolded
                    ? into / Double(max(bottomBandHeight, 1)) * (24 - bottom) : into / Double(hourHeight)
                return min(24 * 60, (bottom + hours) * 60)
            }
            return (top + Double((y - topBandHeight) / hourHeight)) * 60
        }

        /// The minimum block height as minutes of this grid, which is how the
        /// column layout reads it: a floored block overlaps what its drawn height covers.
        public var shortestBlockMinutes: Double { Double(minBlockHeight / hourHeight * 60) }
    }

    /// The early and late hours, folded into bands so the day opens on the hours that get used,
    /// as the desktop folds them (`DEFAULT_COLLAPSE_CONFIG`, `buildCollapseGeometry`).
    public struct Collapse: Equatable, Sendable {
        /// The early band covers midnight up to this hour.
        public var topHour: Int
        /// The late band covers this hour up to midnight.
        public var bottomHour: Int
        public var topCollapsed: Bool
        public var bottomCollapsed: Bool

        /// The desktop's band height.
        public static let bandHeight: CGFloat = 40
        /// Nothing folded: every hour its full height, as the grid was before bands.
        public static let none = Collapse(topHour: 0, bottomHour: 24, topCollapsed: false, bottomCollapsed: false)
        public static let earliestTopHour = 1
        public static let latestTopHour = 12
        public static let earliestBottomHour = 12
        public static let latestBottomHour = 23

        public init(topHour: Int, bottomHour: Int, topCollapsed: Bool, bottomCollapsed: Bool) {
            self.topHour = min(max(topHour, 0), 23)
            self.bottomHour = min(max(bottomHour, self.topHour + 1), 24)
            self.topCollapsed = topCollapsed
            self.bottomCollapsed = bottomCollapsed
        }

        /// A band with no hours in it can't fold.
        public var isTopFolded: Bool { topCollapsed && topHour > 0 }
        public var isBottomFolded: Bool { bottomCollapsed && bottomHour < 24 }
    }

    /// The folded band a timed block lies wholly inside, if any. Such a block is not drawn; its band
    /// says how many it holds, as the desktop's `+N more` does.
    public enum Band: Sendable {
        case top, bottom
    }

    public static func foldedBand(start: String, end: String?, on day: String, metrics: Metrics) -> Band? {
        guard let span = minuteSpan(start: start, end: end, on: day) else { return nil }
        let collapse = metrics.collapse
        if collapse.isTopFolded, span.end <= collapse.topHour * 60, span.start < collapse.topHour * 60 {
            return .top
        }
        if collapse.isBottomFolded, span.start >= collapse.bottomHour * 60 { return .bottom }
        return nil
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
        guard let span = minuteSpan(start: start, end: end, on: day) else { return nil }

        // A block running out of a folded band starts at the band's edge, and one running into a
        // band ends at it, as the desktop draws them: a start pressed into the band would say
        // nothing about when, and the band already counts what lies inside it.
        let collapse = metrics.collapse
        let startsInTopBand = collapse.isTopFolded && span.start < collapse.topHour * 60
        let endsInBottomBand = collapse.isBottomFolded && span.end > collapse.bottomHour * 60
        let rawTop = metrics.y(atMinute: Double(span.start))
        let rawBottom = metrics.y(atMinute: Double(span.end))
        let top = startsInTopBand ? max(rawTop, metrics.topBandHeight - 4) : rawTop
        let bottom = endsInBottomBand ? min(rawBottom, metrics.middleEnd + 4) : rawBottom
        let height = max(metrics.minBlockHeight, bottom - top)

        // Never let a block overflow the grid it sits in: a late event given a
        // minimum height would otherwise hang past midnight.
        let clampedTop = min(top, metrics.dayHeight - metrics.minBlockHeight)
        let clampedHeight = min(height, metrics.dayHeight - clampedTop)
        return (max(0, clampedTop), max(metrics.minBlockHeight, clampedHeight))
    }

    /// The minutes of `day` a timed event covers, or nil when it doesn't touch the day.
    ///
    /// `end` is the *stored* end. Absent means a point in time, which gets the minimum height —
    /// not a zero-height block, and not an assumed duration the user never typed.
    static func minuteSpan(start: String, end: String?, on day: String) -> (start: Int, end: Int)? {
        guard let startDay = self.day(of: start) else { return nil }
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
        return (startMinute, endMinute)
    }

    /// One timed block as the horizontal layout reads it: its Rust cascade depth and where it is
    /// drawn vertically, in points.
    public struct SlotInput: Equatable, Sendable {
        public var depth: Int
        public var top: CGFloat
        public var height: CGFloat

        public init(depth: Int, top: CGFloat, height: CGFloat) {
            self.depth = depth
            self.top = top
            self.height = height
        }
    }

    /// Where a block sits across its day column, in points from the column's leading edge.
    public struct Slot: Equatable, Sendable {
        public var x: CGFloat
        public var width: CGFloat
    }

    /// The horizontal slot for each block of one day, parallel to `blocks`.
    ///
    /// Overlapping blocks sit side by side in lanes, as Apple's Calendar draws them: each cluster
    /// splits the column into one equal lane per depth it uses, and a block takes its depth's lane.
    /// Nothing is drawn over anything, so every title stays on its own block. A cascade was tried
    /// and dropped: three pages within half an hour stacked into a pile whose titles lay over the
    /// neighbouring blocks, and splitting only the close pairs made one
    /// day mix two layouts. Lanes are narrow on a crowded hour in a multi-day view, where a block
    /// too narrow for its title shows its colour alone.
    public static func slots(for blocks: [SlotInput], columnWidth: CGFloat) -> [Slot] {
        var slots = blocks.map { _ in Slot(x: 0, width: columnWidth) }

        for cluster in overlapClusters(blocks) {
            // Ranked rather than used directly: a cluster cut by drawn height can start below depth 0.
            let depths = Set(cluster.map { blocks[$0].depth }).sorted()
            let width = columnWidth / CGFloat(depths.count)
            for index in cluster {
                let lane = depths.firstIndex(of: blocks[index].depth) ?? 0
                slots[index] = Slot(x: width * CGFloat(lane), width: width)
            }
        }
        return slots
    }

    /// Indices of blocks whose drawn spans connect, each cluster in input order.
    private static func overlapClusters(_ blocks: [SlotInput]) -> [[Int]] {
        let byTop = blocks.indices.sorted { (blocks[$0].top, $0) < (blocks[$1].top, $1) }
        var clusters: [[Int]] = []
        var clusterEnd = -CGFloat.infinity

        for index in byTop {
            let block = blocks[index]
            if block.top >= clusterEnd || clusters.isEmpty { clusters.append([]) }
            clusters[clusters.count - 1].append(index)
            clusterEnd = max(clusterEnd, block.top + block.height)
        }
        return clusters.map { $0.sorted() }
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
        guard metrics.hourHeight > 0 else { return 0 }
        let minute = Int(metrics.minute(atY: y).rounded(.down))
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
        guard metrics.hourHeight > 0 else { return (start, start + 15) }
        let range = stretchNewBlock(pressed: Int32(start), reached: metrics.minute(atY: y))
        return (Int(range.start), Int(range.end))
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

    // MARK: - Dropping a page on a day

    /// The schedule a page dropped at `minute` of `day` takes; `dropSchedule` in Rust holds the rule.
    public static func dropSchedule(
        day: String, minute: Int, previousStart: String?, previousEnd: String?
    ) -> (start: String, end: String?) {
        let dropped = PikosCore.dropSchedule(
            day: day, minute: Int32(minute), previousStart: previousStart, previousEnd: previousEnd)
        return (dropped.start, dropped.end)
    }

    /// A position over a whole day's column into a minute, snapped down to the quarter hour.
    public static func dropMinute(atY y: CGFloat, metrics: Metrics) -> Int {
        let minute = Int(metrics.minute(atY: max(0, y)).rounded(.down))
        return min(max(0, (minute / 15) * 15), 24 * 60 - 15)
    }

    /// A position over a window of hours into a minute, snapped down to the quarter hour the
    /// desktop snaps to.
    public static func dropMinute(atY y: CGFloat, firstHour: Int, hourHeight: CGFloat) -> Int {
        guard hourHeight > 0 else { return firstHour * 60 }
        let minute = firstHour * 60 + Int((y / hourHeight * 60).rounded(.down))
        return min(max(0, (minute / 15) * 15), 24 * 60 - 15)
    }

    // MARK: - The now indicator

    /// Where "now" sits in a day column, or nil if that day is not today.
    ///
    /// Takes both as wall-clock strings so it is testable without waiting for a
    /// particular minute to come round.
    public static func nowOffset(now: String, on day: String, metrics: Metrics) -> CGFloat? {
        guard self.day(of: now) == day, let minute = minutesIntoDay(now) else { return nil }
        return metrics.y(atMinute: Double(minute))
    }
}
