import PikosSupport
import XCTest

final class TypingTimesTests: XCTestCase {
    func testABigBatchOutweighsASmallOneInTheMedian() {
        var times = TypingTimes()
        times.add(count: 90, medianMs: 8, worstMs: 20)
        times.add(count: 10, medianMs: 40, worstMs: 60)
        XCTAssertEqual(times.count, 100)
        XCTAssertEqual(times.medianMs, 8)
        XCTAssertEqual(times.worstMs, 60)
    }

    func testAnEmptyBatchChangesNothing() {
        var times = TypingTimes()
        times.add(count: 0, medianMs: 99, worstMs: 99)
        XCTAssertEqual(times, TypingTimes())
    }

    func testTheSummaryRoundsToWholeMilliseconds() {
        var times = TypingTimes()
        times.add(count: 3, medianMs: 8.6, worstMs: 30.2)
        XCTAssertEqual(times.summary, "Typing: 9 ms median, 30 ms worst, 3 keys")
    }
}
