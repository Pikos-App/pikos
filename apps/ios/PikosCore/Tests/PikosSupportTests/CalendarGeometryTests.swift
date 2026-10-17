import XCTest

@testable import PikosSupport

/// The arithmetic between a stored wall clock and a position on screen.
///
/// Worth its own tests because the failure mode is quiet: a block an hour out,
/// or a multi-day event that renders as a sliver at midnight, both look like
/// plausible calendars. Nothing here needs a webview, a database or a device,
/// which is why the geometry lives in `PikosSupport` rather than in the app.
final class CalendarGeometryTests: XCTestCase {
    private let metrics = CalendarGeometry.Metrics()

    // MARK: - Reading wall-clock strings

    func testReadsTheDateAndTimeHalves() {
        XCTAssertEqual(CalendarGeometry.day(of: "2026-03-23T09:30:00"), "2026-03-23")
        XCTAssertEqual(CalendarGeometry.day(of: "2026-03-23"), "2026-03-23")
        XCTAssertEqual(CalendarGeometry.minutesIntoDay("2026-03-23T09:30:00"), 570)
        XCTAssertEqual(CalendarGeometry.minutesIntoDay("2026-03-23T00:00:00"), 0)
        XCTAssertEqual(CalendarGeometry.minutesIntoDay("2026-03-23T23:59:00"), 1439)
    }

    /// An all-day value has no time to read. Returning 0 instead of nil would
    /// place every all-day event at midnight in the timed grid, where it does
    /// not belong at all.
    func testAnAllDayValueHasNoTime() {
        XCTAssertTrue(CalendarGeometry.isAllDay("2026-03-23"))
        XCTAssertFalse(CalendarGeometry.isAllDay("2026-03-23T09:00:00"))
        XCTAssertNil(CalendarGeometry.minutesIntoDay("2026-03-23"))
    }

    /// These strings come out of a database that two apps write to. A short or
    /// mangled one must not crash a calendar — `Array(iso)[11...12]` on a
    /// ten-character string would trap.
    func testMalformedValuesAreRefusedRatherThanTrapped() {
        for bad in ["", "2026", "2026-03-23T", "2026-03-23X09:30:00", "2026-03-23T09-30:00"] {
            XCTAssertNil(CalendarGeometry.minutesIntoDay(bad), "should refuse \(bad)")
        }
        XCTAssertNil(CalendarGeometry.day(of: "2026-03"))
        XCTAssertNil(CalendarGeometry.minutesIntoDay("2026-03-23T25:00:00"))
        XCTAssertNil(CalendarGeometry.minutesIntoDay("2026-03-23T09:75:00"))
    }

    // MARK: - Placing a block

    func testPlacesAnEventAtItsHour() {
        let placed = CalendarGeometry.placement(
            start: "2026-03-23T09:00:00", end: "2026-03-23T10:00:00",
            on: "2026-03-23", metrics: metrics)
        XCTAssertEqual(placed?.top, 9 * metrics.hourHeight)
        XCTAssertEqual(placed?.height, metrics.hourHeight)
    }

    /// A point in time, which is what a page scheduled with no end is. It must
    /// be visible and hittable rather than a zero-height line, and it must not
    /// invent a duration the user never gave it.
    func testAnEventWithNoEndGetsTheMinimumHeight() {
        let placed = CalendarGeometry.placement(
            start: "2026-03-23T09:00:00", end: nil, on: "2026-03-23", metrics: metrics)
        XCTAssertEqual(placed?.height, metrics.minBlockHeight)
        XCTAssertEqual(placed?.top, 9 * metrics.hourHeight)
    }

    func testAVeryShortEventIsStillTappable() {
        let placed = CalendarGeometry.placement(
            start: "2026-03-23T09:00:00", end: "2026-03-23T09:05:00",
            on: "2026-03-23", metrics: metrics)
        XCTAssertEqual(placed?.height, metrics.minBlockHeight)
    }

    /// An overnight event, seen from its second day: it starts at the top of
    /// the column, not at the hour it began yesterday.
    func testAnEventContinuingFromYesterdayStartsAtTheTop() {
        let placed = CalendarGeometry.placement(
            start: "2026-03-22T22:00:00", end: "2026-03-23T02:00:00",
            on: "2026-03-23", metrics: metrics)
        XCTAssertEqual(placed?.top, 0)
        XCTAssertEqual(placed?.height, 2 * metrics.hourHeight)
    }

    /// The same event seen from its first day: it runs to the bottom, not past
    /// it.
    func testAnEventRunningIntoTomorrowStopsAtMidnight() {
        let placed = CalendarGeometry.placement(
            start: "2026-03-22T22:00:00", end: "2026-03-23T02:00:00",
            on: "2026-03-22", metrics: metrics)
        XCTAssertEqual(placed?.top, 22 * metrics.hourHeight)
        XCTAssertEqual(placed?.height, 2 * metrics.hourHeight)
        XCTAssertEqual(
            (placed?.top ?? 0) + (placed?.height ?? 0), metrics.dayHeight,
            "the block must end exactly at the foot of the grid")
    }

    /// A late event given the minimum height would otherwise hang below
    /// midnight and be clipped by whatever sits under the grid.
    func testABlockNeverOverflowsTheFootOfTheGrid() {
        let placed = CalendarGeometry.placement(
            start: "2026-03-23T23:58:00", end: nil, on: "2026-03-23", metrics: metrics)
        let bottom = (placed?.top ?? 0) + (placed?.height ?? 0)
        XCTAssertLessThanOrEqual(bottom, metrics.dayHeight)
        XCTAssertEqual(placed?.height, metrics.minBlockHeight, "and keeps its minimum height")
    }

    /// Asking for a day the event does not touch is a caller error, and a
    /// zero-height block at midnight would hide it.
    func testAnEventOnAnotherDayIsNotPlaced() {
        XCTAssertNil(
            CalendarGeometry.placement(
                start: "2026-03-25T09:00:00", end: nil, on: "2026-03-23", metrics: metrics))
        XCTAssertNil(
            CalendarGeometry.placement(
                start: "2026-03-21T09:00:00", end: "2026-03-21T10:00:00",
                on: "2026-03-23", metrics: metrics))
    }

    // MARK: - Cascade

    func testCascadeInsetGrowsWithDepthAndThenStops() {
        let width: CGFloat = 300
        XCTAssertEqual(CalendarGeometry.cascadeInset(depth: 0, columnWidth: width), 0)
        XCTAssertLessThan(
            CalendarGeometry.cascadeInset(depth: 1, columnWidth: width),
            CalendarGeometry.cascadeInset(depth: 2, columnWidth: width))
        // Capped, so a deep cascade cannot push a block off its own column.
        XCTAssertEqual(
            CalendarGeometry.cascadeInset(depth: 4, columnWidth: width),
            CalendarGeometry.cascadeInset(depth: 3, columnWidth: width))
        XCTAssertLessThan(CalendarGeometry.cascadeInset(depth: 9, columnWidth: width), width / 2)
    }

    // MARK: - Now indicator

    func testTheNowIndicatorOnlyAppearsOnToday() {
        XCTAssertEqual(
            CalendarGeometry.nowOffset(
                now: "2026-03-23T06:00:00", on: "2026-03-23", metrics: metrics),
            6 * metrics.hourHeight)
        XCTAssertNil(
            CalendarGeometry.nowOffset(
                now: "2026-03-23T06:00:00", on: "2026-03-24", metrics: metrics))
    }

    // MARK: - Touching an empty slot

    /// A finger resting just under the 3pm rule meant 3pm, not 3:30.
    func testATouchSnapsDownToTheHalfHour() {
        let metrics = CalendarGeometry.Metrics(hourHeight: 60)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: 15 * 60 + 4, metrics: metrics), 15 * 60)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: 15 * 60 + 29, metrics: metrics), 15 * 60)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: 15 * 60 + 31, metrics: metrics), 15 * 60 + 30)
    }

    func testSlotsFollowTheHourHeight() {
        // At 88 points an hour, 3pm is 1320 points down.
        let metrics = CalendarGeometry.Metrics(hourHeight: 88)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: 1320, metrics: metrics), 15 * 60)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: 1320 + 44, metrics: metrics), 15 * 60 + 30)
    }

    /// The bottom of the grid is the last slot of today, never midnight
    /// tomorrow; above the top is midnight, not a negative minute.
    func testSlotsAreClampedIntoTheDay() {
        let metrics = CalendarGeometry.Metrics(hourHeight: 64)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: -20, metrics: metrics), 0)
        XCTAssertEqual(CalendarGeometry.slotMinute(atY: metrics.dayHeight, metrics: metrics), 23 * 60 + 30)
        XCTAssertEqual(
            CalendarGeometry.slotMinute(atY: metrics.dayHeight * 2, metrics: metrics), 23 * 60 + 30)
    }

    func testAQuarterHourSlotIsAvailable() {
        let metrics = CalendarGeometry.Metrics(hourHeight: 60)
        XCTAssertEqual(
            CalendarGeometry.slotMinute(atY: 9 * 60 + 50, metrics: metrics, slotMinutes: 15), 9 * 60 + 45)
    }

    /// The wall clock written for a slot reads back as the same minute.
    func testASlotRoundTripsThroughTheStorageFormat() {
        let clock = CalendarGeometry.wallClock(day: "2026-09-14", minute: 15 * 60 + 30)
        XCTAssertEqual(clock, "2026-09-14T15:30:00")
        XCTAssertEqual(CalendarGeometry.minutesIntoDay(clock), 15 * 60 + 30)
        XCTAssertEqual(CalendarGeometry.day(of: clock), "2026-09-14")
        XCTAssertEqual(CalendarGeometry.wallClock(day: "2026-09-14", minute: 0), "2026-09-14T00:00:00")
    }

    func testADroppedTimedPageKeepsItsLength() {
        let dropped = CalendarGeometry.dropSchedule(
            day: "2026-09-14", minute: 16 * 60,
            previousStart: "2026-09-10T10:00:00", previousEnd: "2026-09-10T11:45:00")
        XCTAssertEqual(dropped.start, "2026-09-14T16:00:00")
        XCTAssertEqual(dropped.end, "2026-09-14T17:45:00")
    }

    func testADroppedUndatedOrAllDayPageGetsAStartAndNoEnd() {
        let undated = CalendarGeometry.dropSchedule(
            day: "2026-09-14", minute: 9 * 60 + 15, previousStart: nil, previousEnd: nil)
        XCTAssertEqual(undated.start, "2026-09-14T09:15:00")
        XCTAssertNil(undated.end)

        let allDay = CalendarGeometry.dropSchedule(
            day: "2026-09-14", minute: 9 * 60, previousStart: "2026-09-10", previousEnd: "2026-09-12")
        XCTAssertNil(allDay.end)
    }

    func testALateDropEndsAtMidnightRatherThanTomorrow() {
        let dropped = CalendarGeometry.dropSchedule(
            day: "2026-09-14", minute: 23 * 60 + 30,
            previousStart: "2026-09-10T10:00:00", previousEnd: "2026-09-10T12:00:00")
        XCTAssertEqual(dropped.end, "2026-09-14T23:59:00")
    }

    func testADropSnapsDownToTheQuarterHourUnderTheFinger() {
        XCTAssertEqual(CalendarGeometry.dropMinute(atY: 0, firstHour: 15, hourHeight: 40), 15 * 60)
        XCTAssertEqual(CalendarGeometry.dropMinute(atY: 39, firstHour: 15, hourHeight: 40), 15 * 60 + 45)
        XCTAssertEqual(CalendarGeometry.dropMinute(atY: 50, firstHour: 15, hourHeight: 40), 16 * 60 + 15)
        XCTAssertEqual(CalendarGeometry.dropMinute(atY: -30, firstHour: 0, hourHeight: 40), 0)
        XCTAssertEqual(CalendarGeometry.dropMinute(atY: 400, firstHour: 22, hourHeight: 40), 23 * 60 + 45)
    }

    // MARK: - Resizing by an edge

    private func resize(_ start: String, _ end: String?, _ edge: CalendarGeometry.BlockEdge, _ minute: Int)
        -> [String]?
    {
        CalendarGeometry.resized(start: start, end: end, edge: edge, toMinute: minute).map { [$0.start, $0.end] }
    }

    func testTheBottomEdgeMovesTheEndToTheNearestQuarterHour() {
        XCTAssertEqual(
            resize("2026-09-14T09:00:00", "2026-09-14T10:00:00", .bottom, 11 * 60 + 8),
            ["2026-09-14T09:00:00", "2026-09-14T11:15:00"])
    }

    func testTheTopEdgeMovesTheStartAndKeepsTheEnd() {
        XCTAssertEqual(
            resize("2026-09-14T09:00:00", "2026-09-14T10:00:00", .top, 8 * 60 + 20),
            ["2026-09-14T08:15:00", "2026-09-14T10:00:00"])
    }

    func testNeitherEdgeCanMakeAPageShorterThanAQuarterHour() {
        XCTAssertEqual(
            resize("2026-09-14T09:00:00", "2026-09-14T10:00:00", .bottom, 8 * 60),
            ["2026-09-14T09:00:00", "2026-09-14T09:15:00"])
        XCTAssertEqual(
            resize("2026-09-14T09:00:00", "2026-09-14T10:00:00", .top, 11 * 60),
            ["2026-09-14T09:45:00", "2026-09-14T10:00:00"])
    }

    func testAPageWithNoEndGainsOneFromEitherEdge() {
        XCTAssertEqual(
            resize("2026-09-14T09:00:00", nil, .bottom, 10 * 60),
            ["2026-09-14T09:00:00", "2026-09-14T10:00:00"])
        XCTAssertEqual(
            resize("2026-09-14T09:00:00", nil, .top, 8 * 60),
            ["2026-09-14T08:00:00", "2026-09-14T09:00:00"])
    }

    func testAnEdgeStaysInsideItsDay() {
        XCTAssertEqual(
            resize("2026-09-14T22:00:00", "2026-09-14T23:00:00", .bottom, 25 * 60),
            ["2026-09-14T22:00:00", "2026-09-14T23:59:00"])
        XCTAssertEqual(
            resize("2026-09-14T01:00:00", "2026-09-14T02:00:00", .top, -90),
            ["2026-09-14T00:00:00", "2026-09-14T02:00:00"])
    }

    func testAnAllDayOrOvernightPageIsNotResizedByAnEdge() {
        XCTAssertNil(resize("2026-09-14", "2026-09-15", .bottom, 600))
        XCTAssertNil(resize("2026-09-14T22:00:00", "2026-09-15T01:00:00", .bottom, 23 * 60))
    }

    // MARK: - Quick adjusts

    private func shift(_ start: String, _ end: String?, _ minutes: Int) -> [String?]? {
        CalendarGeometry.shifted(start: start, end: end, by: minutes).map { [$0.start, $0.end] }
    }

    func testAShiftKeepsTheLength() {
        XCTAssertEqual(
            shift("2026-09-14T09:00:00", "2026-09-14T09:45:00", 30),
            ["2026-09-14T09:30:00", "2026-09-14T10:15:00"])
        XCTAssertEqual(
            shift("2026-09-14T09:00:00", "2026-09-14T09:45:00", -60),
            ["2026-09-14T08:00:00", "2026-09-14T08:45:00"])
    }

    func testAPageWithNoEndShiftsWithoutGainingOne() {
        XCTAssertEqual(shift("2026-09-14T09:00:00", nil, 15), ["2026-09-14T09:15:00", nil])
    }

    func testAShiftStopsAtTheEdgesOfTheDay() {
        XCTAssertEqual(
            shift("2026-09-14T23:00:00", "2026-09-14T23:30:00", 60),
            ["2026-09-14T23:29:00", "2026-09-14T23:59:00"])
        XCTAssertEqual(
            shift("2026-09-14T00:15:00", "2026-09-14T01:00:00", -60),
            ["2026-09-14T00:00:00", "2026-09-14T00:45:00"])
    }

    func testAnAllDayOrOvernightPageIsNotShifted() {
        XCTAssertNil(shift("2026-09-14", nil, 15))
        XCTAssertNil(shift("2026-09-14T22:00:00", "2026-09-15T01:00:00", 15))
    }

    func testLengtheningMovesOnlyTheEnd() {
        let longer = CalendarGeometry.lengthened(start: "2026-09-14T09:00:00", end: "2026-09-14T09:30:00", by: 60)
        XCTAssertEqual(longer.map { [$0.start, $0.end] }, ["2026-09-14T09:00:00", "2026-09-14T10:30:00"])
        let fromAPoint = CalendarGeometry.lengthened(start: "2026-09-14T09:00:00", end: nil, by: 30)
        XCTAssertEqual(fromAPoint.map { [$0.start, $0.end] }, ["2026-09-14T09:00:00", "2026-09-14T09:30:00"])
    }

    // MARK: - Stretching a new block

    private func stretch(_ start: Int, toMinute minute: Double) -> [Int] {
        let metrics = CalendarGeometry.Metrics(hourHeight: 60)
        let range = CalendarGeometry.stretched(from: start, toY: CGFloat(minute), metrics: metrics)
        return [range.start, range.end]
    }

    func testAPressThatHasNotMovedIsAQuarterHour() {
        XCTAssertEqual(stretch(15 * 60, toMinute: 15 * 60 + 4), [15 * 60, 15 * 60 + 15])
    }

    func testDraggingDownMovesTheEndToTheNearestQuarterHour() {
        XCTAssertEqual(stretch(15 * 60, toMinute: 16 * 60 + 37), [15 * 60, 16 * 60 + 30])
        XCTAssertEqual(stretch(15 * 60, toMinute: 16 * 60 + 38), [15 * 60, 16 * 60 + 45])
    }

    func testDraggingUpMovesTheStartAndKeepsThePressedQuarter() {
        XCTAssertEqual(stretch(15 * 60, toMinute: 14 * 60), [14 * 60, 15 * 60 + 15])
    }

    func testAStretchStaysInsideTheDay() {
        XCTAssertEqual(stretch(23 * 60, toMinute: 25 * 60), [23 * 60, 24 * 60])
        XCTAssertEqual(stretch(30, toMinute: -60), [0, 45])
    }
}
