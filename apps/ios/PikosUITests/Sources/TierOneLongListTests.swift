import XCTest

/// A list longer than one window: 120 seeded pages put 20 and the long page in the Inbox, read 8
/// at a time.
final class TierOneLongListTests: PikosUITestCase {
    override class var launchEnvironment: [String: String] {
        ["PIKOS_PERF_PAGES": "120", "PIKOS_WINDOW_SIZE": "8"]
    }

    // qa: IOS-25:2
    func testScrollingALongInboxReadsTheRestOfIt() {
        showView("Inbox")
        let first = app.staticTexts["Page 1"].firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: Self.timeout), "the first window is read")

        // The seed writes the long page last, so it ends the Inbox's manual order.
        let last = app.staticTexts["Long page"].firstMatch
        let list = app.collectionViews.firstMatch
        for _ in 0..<12 where !last.exists {
            list.swipeUp(velocity: .fast)
        }
        XCTAssertTrue(last.waitForExistence(timeout: 5), "scrolling reads the windows after it, to the end")
    }

    // qa: IOS-25:2
    func testSelectAllInALongInboxTakesThePagesNotYetRead() {
        // Chosen once the switcher counts all 21, so the seed has finished.
        app.buttons["Switch view"].firstMatch.tap()
        let inbox = app.buttons["Inbox, 21"].firstMatch
        XCTAssertTrue(inbox.waitForExistence(timeout: Self.timeout), "the seed filled the Inbox")
        inbox.tap()
        XCTAssertTrue(app.staticTexts["Page 1"].firstMatch.waitForExistence(timeout: Self.timeout))
        app.buttons["Select"].firstMatch.tap()
        app.buttons["Select all"].firstMatch.tap()
        XCTAssertTrue(
            app.staticTexts["21 selected"].waitForExistence(timeout: 10), "every page in the Inbox, read or not")
    }
}
