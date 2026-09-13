import XCTest

/// The flows that must work, mirroring the desktop's `@tier1` Playwright set.
///
/// Chosen so that a failure here means the app is unusable rather than
/// imperfect: it launched, a page can be made, ticked, found and opened. That
/// is the whole bar. Anything narrower than these five is a question the Rust
/// tests or `PikosSupport` answer in milliseconds, and asking it again through
/// a simulator buys nothing but minutes.
final class TierOneTests: PikosUITestCase {
    /// The one that matters most, and the one nothing currently proves.
    ///
    /// Launching runs the migrations and opens the workspace. Until this exists
    /// nobody knows whether the app starts at all — the Swift has never been
    /// compiled, let alone run.
    func testTheAppLaunchesAndShowsTheList() {
        XCTAssertTrue(
            app.navigationBars["Today"].waitForExistence(timeout: Self.timeout),
            "the app should open on Today")
        XCTAssertTrue(app.buttons["New page"].firstMatch.exists, "with a way to add a page")
    }

    func testQuickAddCreatesAPageThatAppearsInTheList() {
        quickAdd("Buy milk today")
        assertRowExists("Buy milk", "the parsed title, not the raw line")
    }

    /// The checkbox has to land on the checkbox.
    ///
    /// It sits beside a `NavigationLink` rather than inside one, because a
    /// Button inside a link's label does not reliably receive the tap — the
    /// symptom being a checkbox that navigates instead of completing. That is
    /// invisible to every other kind of test.
    func testTickingAPageMovesItOutOfTheOpenList() {
        quickAdd("Buy milk today")
        assertRowExists("Buy milk")

        app.buttons["Mark as done"].firstMatch.tap()

        // Today lists open work only, so it leaves rather than gaining a
        // strikethrough. It is still in the workspace — the Completed section
        // is where it went.
        XCTAssertTrue(
            waitForDisappearance(of: app.staticTexts["Buy milk"]),
            "a ticked page leaves the open list")
        XCTAssertTrue(
            app.staticTexts["Completed (1)"].waitForExistence(timeout: Self.timeout),
            "and is counted as finished")
    }

    func testSearchFindsAPageByItsTitle() {
        quickAdd("Quarterly review today")
        assertRowExists("Quarterly review")

        app.buttons["Search"].firstMatch.tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: Self.timeout))
        field.tap()
        field.typeText("quarterly")

        XCTAssertTrue(
            app.staticTexts["Quarterly review"].waitForExistence(timeout: Self.timeout),
            "full-text search should find it")
    }

    /// Opening a page is the one flow that crosses into the webview, so it is
    /// the one that proves the editor bundle shipped and the bridge answered.
    func testOpeningAPageShowsTheEditor() {
        quickAdd("Trip notes today")
        assertRowExists("Trip notes")

        app.staticTexts["Trip notes"].firstMatch.tap()

        XCTAssertTrue(
            app.navigationBars["Trip notes"].waitForExistence(timeout: Self.timeout),
            "the editor opens on the page")
        XCTAssertTrue(
            app.webViews.firstMatch.waitForExistence(timeout: Self.timeout),
            "and the editor webview loads — a missing bundle fails here")
    }

    /// `waitForExistence` has no opposite, and polling `.exists` in a loop
    /// races the query. An expectation on the predicate is what XCTest offers.
    private func waitForDisappearance(of element: XCUIElement) -> Bool {
        let gone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: Self.timeout) == .completed
    }
}
