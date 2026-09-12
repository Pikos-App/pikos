import XCTest

@testable import PikosCore

/// Tests for the FFI boundary itself, not for the logic behind it.
///
/// The logic is already graded against a golden corpus generated from the
/// TypeScript reference (`crates/pikos-core/tests/`), and re-asserting it here
/// would only re-test Rust through a second door. What these cover is the
/// layer those tests cannot see: whether UniFFI's type mapping preserves
/// meaning on the way across. Optionals that should stay nil, unsigned counts
/// that must not wrap, enum cases that must carry their payloads, and strings
/// that must survive as UTF-8.
final class BridgeMappingTests: XCTestCase {

    // MARK: - Optionals

    /// `None` must arrive as `nil`, not as an empty string. A bridge that
    /// flattened them would turn "this event has no end" into "this event ends
    /// at the epoch", which reads as a real value everywhere downstream.
    func testAbsentValuesArriveAsNil() {
        XCTAssertNil(computeNextEnd(baseEnd: "2026-03-16", nextStart: "2026-03-17"),
                     "an all-day series has no end time to carry")
        XCTAssertNil(normalizeEndInput(currentStart: "2026-03-16", endIso: nil))
        XCTAssertNil(parseDeepLink(url: "pikos://nonsense"))
        XCTAssertNil(nextOccurrenceAfter(rrule: "", scheduledStart: "", afterDate: "", exdates: []))
    }

    func testPresentOptionalsSurvive() {
        let end = computeNextEnd(baseEnd: "2026-03-16T10:30:00", nextStart: "2026-03-20T14:00:00")
        XCTAssertEqual(end, "2026-03-20T15:30:00")
    }

    // MARK: - Enums with payloads

    func testDeepLinkCasesCarryTheirPayloads() {
        guard case .page(let pageId)? =
                parseDeepLink(url: "pikos://page/3f2504e0-4f89-41d3-9a0c-0305e82c3301") else {
            return XCTFail("expected a page link")
        }
        XCTAssertEqual(pageId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")

        guard case .view(let view)? = parseDeepLink(url: "pikos://today") else {
            return XCTFail("expected a view link")
        }
        XCTAssertEqual(view, .today)

        guard case .calendar? = parseDeepLink(url: "pikos://calendar") else {
            return XCTFail("expected the calendar link")
        }
    }

    /// Percent-encoded text is what actually arrives from a widget tap or a
    /// notification, and quick-add prefills routinely contain spaces and #tags.
    func testQuickAddPrefillIsPercentDecoded() {
        guard case .quickAdd(let prefill)? =
                parseDeepLink(url: "pikos://quick-add?text=tomorrow%20at%203pm%20%23work") else {
            return XCTFail("expected a quick-add link")
        }
        XCTAssertEqual(prefill, "tomorrow at 3pm #work")
    }

    // MARK: - Unsigned counts

    /// Counts cross as UInt32. A negative value would wrap to something huge
    /// rather than erroring, so the reversed-interval case is worth pinning at
    /// the boundary rather than trusting.
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

    // MARK: - Records and collections

    func testTimedLayoutRoundTripsRecords() {
        let pages = [
            LayoutPage(id: "a", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-16T09:00:00",
                       scheduledEnd: "2026-03-16T10:30:00"),
            LayoutPage(id: "b", createdAt: "2026-03-01T00:00:00",
                       scheduledStart: "2026-03-16T10:00:00",
                       scheduledEnd: "2026-03-16T11:00:00"),
        ]
        let blocks = layoutTimedDay(pages: pages, day: "2026-03-16")
        XCTAssertEqual(blocks.count, 2)

        let byId = Dictionary(uniqueKeysWithValues: blocks.map { ($0.pageId, $0) })
        XCTAssertEqual(byId["a"]?.cascadeDepth, 0, "the earlier event hosts the cluster")
        XCTAssertEqual(byId["b"]?.cascadeDepth, 1, "the overlapping event cascades over it")
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
        XCTAssertTrue(layoutTimedDay(pages: [], day: "2026-03-16").isEmpty)
        XCTAssertTrue(layoutAllDay(pages: [], days: []).isEmpty)
        XCTAssertTrue(expandRecurrence(rrule: "FREQ=DAILY", scheduledStart: "2026-03-15",
                                       scheduledEnd: nil, exdates: [],
                                       rangeStart: "2026-04-01",
                                       rangeEnd: "2026-04-01").isEmpty)
    }

    // MARK: - Strings

    /// Page content is arbitrary user text. UTF-8 has to survive the crossing
    /// intact, including characters outside the basic multilingual plane.
    func testUnicodeSurvivesExtraction() {
        let doc = """
        {"type":"doc","content":[{"type":"paragraph","content":[\
        {"type":"text","text":"emoji 🎉 and ünïcode"}]}]}
        """
        XCTAssertEqual(extractText(docJson: doc), "emoji 🎉 and ünïcode")
    }

    /// Malformed content must return empty rather than trapping. A Rust panic
    /// crosses the FFI as a process abort with no Swift-side recovery, so a
    /// corrupt page would take the whole app down on open.
    func testMalformedContentDoesNotTrap() {
        for junk in ["", "{}", "{", "not json", "\u{0}"] {
            XCTAssertEqual(extractText(docJson: junk), "")
        }
    }

    // MARK: - Schema version

    /// iOS must refuse to save over a page written by a newer editor schema.
    /// This asserts the constant is reachable and sane; the cross-language
    /// agreement itself is guarded on the Rust side.
    func testContentSchemaVersionIsExposed() {
        XCTAssertGreaterThanOrEqual(contentSchemaVersion(), 1)
    }

    // MARK: - Wall-clock semantics

    /// The whole reason dates cross as strings rather than as `Date`: a daily
    /// 09:00 series must stay at 09:00 through a DST transition. Converting at
    /// the boundary would force a timezone choice per call and shift events by
    /// an hour twice a year.
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
