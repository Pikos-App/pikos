import XCTest

/// How fast the app is on the device it runs on: launch, scrolling a long list, and typing into a
/// long page, against a workspace of two thousand pages.
///
/// Not part of any gate. Run on a phone, where the numbers mean something, with
/// `TEST_RUNNER_PIKOS_RUN_SPEED=1` set for `xcodebuild test`; otherwise every test skips. The
/// workspace lives in the app's own container and is seeded by the first launch that finds it
/// missing. `scripts/ios-speed.sh` runs them instead on the CLI's 200,000-page workspace, copied
/// into the container, since seeding that many through the app takes hours.
final class SpeedTests: PikosUITestCase {
    private static var atScale: Bool { ProcessInfo.processInfo.environment["PIKOS_SPEED_AT_SCALE"] == "1" }

    override class var launchEnvironment: [String: String] {
        atScale
            ? ["PIKOS_WORKSPACE_DIRECTORY": "~/Library/Caches"]
            : ["PIKOS_WORKSPACE_DIRECTORY": "~/tmp/pikos-speed", "PIKOS_PERF_PAGES": "2000"]
    }

    /// The 10,000-word page each workspace holds: the app's seed writes it last, the CLI's names it.
    private var longPage: String { Self.atScale ? "large document 0" : "Long page" }

    override func setUp() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["PIKOS_RUN_SPEED"] == "1", "speed tests run on request, on a phone")
        try await super.setUp()
    }

    func testLaunchingOnAFullWorkspace() {
        openLongPageWhenSeeded()
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)]) {
            app.launch()
        }
    }

    func testScrollingTheInbox() {
        openLongPageWhenSeeded()
        app.terminate()
        app.launch()
        // A tap returns once the app is idle after it, so this takes in reading and drawing the rows.
        let started = Date()
        showView("Inbox")
        print(String(format: "SPEED Inbox opened in %.0f ms", Date().timeIntervalSince(started) * 1000))
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: Self.timeout))
        let options = XCTMeasureOptions()
        options.invocationOptions = [.manuallyStop]
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric], options: options) {
            list.swipeUp(velocity: .fast)
            stopMeasuring()
            list.swipeDown(velocity: .fast)
        }

        // The app's own timing of each read, without the test's taps and queries around it.
        print("SPEED Inbox switch: \(lastRead())")
        app.buttons["Mark as done"].firstMatch.tap()
        Thread.sleep(forTimeInterval: 2)
        print("SPEED Inbox tick: \(lastRead())")
    }

    /// The store's timing of its last refresh, from the debug line in the Sort menu.
    private func lastRead() -> String {
        app.buttons["Sort"].firstMatch.tap()
        let line = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Last read in'")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 10), "the store timed its read")
        let label = line.label
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        return label
    }

    /// Reads the editor's own timing for each keystroke, from the debug line in the page menu.
    func testTypingIntoALongPage() {
        openLongPageWhenSeeded()
        let paragraph = app.webViews.firstMatch.staticTexts.firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: Self.timeout), "the long page has drawn")
        paragraph.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "the editor took the caret")
        app.typeText(String(repeating: "typing speed ", count: 10))
        // The editor reports after a pause in typing.
        Thread.sleep(forTimeInterval: 1)

        app.buttons["Page options"].firstMatch.tap()
        // Menu rows arrive as buttons or text depending on the iOS version, so any element will do.
        let loaded = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Editor loaded'")).firstMatch
        let typing = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Typing:'")).firstMatch
        if !typing.waitForExistence(timeout: 10) {
            print("SPEED menu: \(app.debugDescription)")
        }
        XCTAssertTrue(typing.exists, "the editor reported its keystrokes")
        let report = "\(loaded.exists ? loaded.label : "load not reported") · \(typing.label)"
        print("SPEED \(report)")
        let attachment = XCTAttachment(string: report)
        attachment.name = "Typing into a 10,000-word page"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Searches for the long page until it's there, which is when seeding has finished, since it
    /// is written last, and opens it.
    private func openLongPageWhenSeeded() {
        app.buttons["Search"].firstMatch.tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: Self.timeout))
        let result = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", longPage)).firstMatch
        let deadline = Date().addingTimeInterval(600)
        repeat {
            field.tap()
            if let typed = field.value as? String, !typed.isEmpty, typed != field.placeholderValue {
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
            }
            field.typeText(longPage)
        } while !result.waitForExistence(timeout: 10) && Date() < deadline
        XCTAssertTrue(result.exists, "the speed workspace finished seeding")
        result.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: Self.timeout))
    }
}
