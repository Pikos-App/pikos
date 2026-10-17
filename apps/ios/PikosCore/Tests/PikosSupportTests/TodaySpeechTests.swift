import PikosSupport
import XCTest

final class TodaySpeechTests: XCTestCase {
    private func item(_ title: String, _ time: String? = nil) -> TodaySpeech.Item {
        TodaySpeech.Item(title: title, time: time)
    }

    func testAnEmptyDaySaysSo() {
        XCTAssertEqual(TodaySpeech.sentence(for: []), "Nothing is on your list today.")
    }

    func testOnePageIsReadWithItsTime() {
        XCTAssertEqual(TodaySpeech.sentence(for: [item("Standup", "9:30 AM")]), "One page today: Standup at 9:30 AM.")
    }

    func testSeveralPagesAreListedInOrder() {
        XCTAssertEqual(
            TodaySpeech.sentence(for: [item("Standup", "9:30 AM"), item("Pay rent"), item("Gym", "6:00 PM")]),
            "3 pages today: Standup at 9:30 AM, Pay rent, and Gym at 6:00 PM.")
    }

    func testPastTheLimitTheRestAreCounted() {
        let pages = (1...7).map { item("Page \($0)") }
        XCTAssertEqual(
            TodaySpeech.sentence(for: pages, limit: 3),
            "7 pages today: Page 1, Page 2, Page 3, and 4 more.")
    }
}
