import XCTest

@testable import PikosCore

/// Covers whether UniFFI's type mapping preserves meaning (nil optionals,
/// non-wrapping unsigned counts, enum payloads, UTF-8), not the logic, which the
/// Rust golden corpus grades.
final class BridgeMappingTests: XCTestCase {
    /// A bridge that flattened `None` to an empty string would turn "no end"
    /// into an epoch end that reads as a real value downstream.
    func testAbsentValuesArriveAsNil() {
        XCTAssertNil(computeNextEnd(baseEnd: "2026-03-16", nextStart: "2026-03-17"),
                     "an all-day series has no end time to carry")
        XCTAssertNil(normalizeEndInput(currentStart: "2026-03-16", endIso: nil))
        XCTAssertNil(parseDeepLink(url: "pikos://nonsense"))
        XCTAssertNil(nextOccurrenceAfter(rrule: "", scheduledStart: "", afterDate: "", exdates: []))
    }

    func testPresentOptionalsSurvive() {
        let end = computeNextEnd(baseEnd: "2026-03-16T10:30:00", nextStart: "2026-03-20T09:00:00")
        XCTAssertEqual(end, "2026-03-20T10:30:00")
    }

    func testDeepLinkCasesCarryTheirPayloads() {
        guard case .page(let pageId, let focus)? =
                parseDeepLink(url: "pikos://page/3f2504e0-4f89-41d3-9a0c-0305e82c3301?focus=1") else {
            return XCTFail("expected a page link")
        }
        XCTAssertEqual(pageId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        XCTAssertTrue(focus)

        guard case .view(let view)? = parseDeepLink(url: "pikos://today") else {
            return XCTFail("expected a view link")
        }
        XCTAssertEqual(view, .today)

        guard case .calendar? = parseDeepLink(url: "pikos://calendar") else {
            return XCTFail("expected the calendar link")
        }
    }

    /// Widget taps and notifications deliver percent-encoded text.
    func testQuickAddPrefillIsPercentDecoded() {
        guard case .quickAdd(let prefill)? =
                parseDeepLink(url: "pikos://quick-add?text=tomorrow%20at%203pm%20%23work") else {
            return XCTFail("expected a quick-add link")
        }
        XCTAssertEqual(prefill, "tomorrow at 3pm #work")
    }

    /// Counts cross as UInt32, so a negative value would wrap to something huge.
    func testReversedIntervalCountsZeroRatherThanWrapping() {
        let count = countCrossingMidnights(start: "2026-03-16T10:00:00",
                                           end: "2026-03-16T09:00:00")
        XCTAssertEqual(count, 0)
    }

    func testMidnightCrossingCounts() {
        XCTAssertEqual(countCrossingMidnights(start: "2026-03-16T23:00:00",
                                              end: "2026-03-17T00:00:00"), 0,
                       "ending exactly at midnight touches the boundary without crossing it")
        XCTAssertEqual(countCrossingMidnights(start: "2026-03-16T23:00:00",
                                              end: "2026-03-18T01:00:00"), 2)
    }

    func testTimedLayoutRoundTripsRecords() {
        let pages = [
            LayoutPage(id: "a", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-16T09:00:00",
                       scheduledEnd: "2026-03-16T10:30:00"),
            LayoutPage(id: "b", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-16T10:00:00",
                       scheduledEnd: "2026-03-16T11:00:00"),
        ]
        let blocks = layoutTimedDay(pages: pages, day: "2026-03-16", shortestBlockMinutes: 15)
        XCTAssertEqual(blocks.count, 2)

        let byId = Dictionary(uniqueKeysWithValues: blocks.map { ($0.pageId, $0) })
        XCTAssertEqual(byId["a"]?.cascadeDepth, 0, "the earlier event hosts the cluster")
        XCTAssertEqual(byId["b"]?.cascadeDepth, 1, "the overlapping event cascades over it")
    }

    func testAShortEventOverlapsWhatItsDrawnHeightCovers() {
        let pages = [
            LayoutPage(id: "a", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-16T09:00:00",
                       scheduledEnd: "2026-03-16T09:15:00"),
            LayoutPage(id: "b", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-16T09:15:00",
                       scheduledEnd: "2026-03-16T10:00:00"),
        ]
        let depth = { (minutes: Double) in
            Dictionary(uniqueKeysWithValues: layoutTimedDay(
                pages: pages, day: "2026-03-16", shortestBlockMinutes: minutes
            ).map { ($0.pageId, $0.cascadeDepth) })["b"]
        }
        XCTAssertEqual(depth(15), 0, "back to back at their true length")
        XCTAssertEqual(depth(22.0 / 64 * 60), 1, "drawn 22pt tall, the first reaches into the second")
    }

    func testAllDayBarsSpanAndFlagContinuation() {
        let week = (16...22).map { String(format: "2026-03-%02d", $0) }
        let pages = [
            LayoutPage(id: "trip", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-13", scheduledEnd: "2026-03-18")
        ]
        let bars = layoutAllDay(pages: pages, days: week)
        XCTAssertEqual(bars.count, 1)
        XCTAssertEqual(bars[0].startCol, 0)
        XCTAssertEqual(bars[0].span, 3)
        XCTAssertTrue(bars[0].continuesLeft, "the trip began before the visible week")
        XCTAssertFalse(bars[0].continuesRight)
    }

    func testEmptyCollectionsCrossCleanly() {
        XCTAssertTrue(layoutTimedDay(pages: [], day: "2026-03-16", shortestBlockMinutes: 15).isEmpty)
        XCTAssertTrue(layoutAllDay(pages: [], days: []).isEmpty)
        XCTAssertTrue(expandRecurrence(rrule: "FREQ=DAILY", scheduledStart: "2026-03-15",
                                       scheduledEnd: nil, exdates: [],
                                       rangeStart: "2026-04-01",
                                       rangeEnd: "2026-04-01").isEmpty)
    }

    /// Includes characters outside the basic multilingual plane.
    func testUnicodeSurvivesExtraction() {
        let doc = """
        {"type":"doc","content":[{"type":"paragraph","content":[\
        {"type":"text","text":"emoji 🎉 and ünïcode"}]}]}
        """
        XCTAssertEqual(extractText(docJson: doc), "emoji 🎉 and ünïcode")
    }

    /// A Rust panic aborts the process with no Swift-side recovery, so a corrupt
    /// page would take the app down on open.
    func testMalformedContentDoesNotTrap() {
        for junk in ["", "{}", "{", "not json", "\u{0}"] {
            XCTAssertEqual(extractText(docJson: junk), "")
        }
    }

    /// Only reachability: the cross-language agreement is guarded on the Rust side.
    func testContentSchemaVersionIsExposed() {
        XCTAssertGreaterThanOrEqual(contentSchemaVersion(), 1)
    }

    /// Dates cross as strings, not `Date`, which would force a timezone choice
    /// per call and shift events by an hour twice a year.
    func testWallClockHoldsAcrossDaylightSavingTransition() {
        let occurrences = expandRecurrence(
            rrule: "FREQ=DAILY",
            scheduledStart: "2026-03-27T09:00:00",
            scheduledEnd: "2026-03-27T10:00:00",
            exdates: [],
            rangeStart: "2026-03-25",
            rangeEnd: "2026-04-02"
        )
        XCTAssertFalse(occurrences.isEmpty)
        for occurrence in occurrences {
            XCTAssertTrue(occurrence.scheduledStart.hasSuffix("T09:00:00"),
                          "wall-clock drifted: \(occurrence.scheduledStart)")
        }
    }
}
