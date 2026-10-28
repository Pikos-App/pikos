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

    /// How far apart two overlapping blocks' tops must be, at the default text size, for a cascade
    /// to leave the earlier title readable: about a title line and a time line.
    public static let titleClearance: CGFloat = 40

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
    /// A cascade keeps the host's title readable only when the guest starts below it. Blocks
    /// whose tops are closer than `titleClearance` would put both titles in the same band, and
    /// at a three-day column's width the guest covered the host's title entirely. So where such
    /// a group includes its cluster's host, it splits the column into equal side-by-side slots,
    /// as the desktop splits a close pair; everything else cascades by depth. A close group
    /// deeper in a cluster still cascades, because the host already holds the leading edge.
    public static func slots(
        for blocks: [SlotInput], columnWidth: CGFloat, titleClearance: CGFloat
    ) -> [Slot] {
        var slots = blocks.map { block in
            let inset = cascadeInset(depth: block.depth, columnWidth: columnWidth)
            return Slot(x: inset, width: columnWidth - inset)
        }

        for cluster in overlapClusters(blocks) {
            for group in closeTopGroups(cluster, in: blocks, titleClearance: titleClearance) {
                let holdsHost = group.contains { blocks[$0].depth == 0 }
                guard group.count > 1, holdsHost else { continue }

                let width = columnWidth / CGFloat(group.count)
                for (column, index) in group.enumerated() {
                    slots[index] = Slot(x: width * CGFloat(column), width: width)
                }
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

    /// The cluster's blocks joined wherever two tops are closer than `titleClearance`, each
    /// group in input order, which is the Rust's top-then-start order.
    private static func closeTopGroups(
        _ cluster: [Int], in blocks: [SlotInput], titleClearance: CGFloat
    ) -> [[Int]] {
        var groupOf: [Int: Int] = [:]
        var groups: [[Int]] = []

        for index in cluster where groupOf[index] == nil {
            var members: [Int] = []
            var pending = [index]
            groupOf[index] = groups.count
            while let next = pending.popLast() {
                members.append(next)
                for other in cluster where groupOf[other] == nil
                    && abs(blocks[other].top - blocks[next].top) < titleClearance
                {
                    groupOf[other] = groups.count
                    pending.append(other)
                }
            }
            groups.append(members.sorted())
        }
        return groups
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

    /// A position over a day into a minute, snapped down to the quarter hour the desktop snaps to.
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
        return CGFloat(minute) * metrics.hourHeight / 60
    }
}
