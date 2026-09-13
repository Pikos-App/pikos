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
}
