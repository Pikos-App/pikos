import XCTest

/// What a large workspace may cost the phone, in reads and rows rather than time, so a shared
/// runner's noise can't fail it: the desktop's check (`e2e/boot.spec.ts`) on the phone's store.
/// Measured 2026-10-17 on the 20,000-page template: launching onto the Inbox made 8 calls reading
/// 532 rows; opening Folder 01 (750 pages) from there 6 calls and 280 rows; a tick in it 4 calls and
/// 80 rows, the folder list, where re-reading the loaded window alone would add 200. Each limit is
/// about twice what was measured. CI builds the template and names it in `PIKOS_LARGE_TEMPLATE`;
/// without it these skip.
final class CountTests: PikosUITestCase {
    private static let limits = (
        launchCalls: 16, launchRows: 1_000, openCalls: 12, openRows: 560, tickRows: 160
    )

    override class var startingWorkspace: URL? {
        ProcessInfo.processInfo.environment["PIKOS_LARGE_TEMPLATE"].map(URL.init(fileURLWithPath:))
    }

    override func setUp() async throws {
        try XCTSkipIf(Self.startingWorkspace == nil, "no PIKOS_LARGE_TEMPLATE")
        try await super.setUp()
    }

    // qa: IOS-56
    func testLaunchingOpeningABigFolderAndTickingInItReadWindowsNotTheWorkspace() {
        showView("Inbox")
        let launched = reads()
        XCTAssertLessThanOrEqual(launched.calls, Self.limits.launchCalls, "calls launching onto the Inbox")
        XCTAssertLessThanOrEqual(launched.rows, Self.limits.launchRows, "rows launching onto the Inbox")

        showView("Folder 01")
        let opened = reads()
        XCTAssertLessThanOrEqual(opened.calls - launched.calls, Self.limits.openCalls, "calls opening the folder")
        XCTAssertLessThanOrEqual(opened.rows - launched.rows, Self.limits.openRows, "rows opening the folder")

        app.buttons["Mark as done"].firstMatch.tap()
        Thread.sleep(forTimeInterval: 2)
        let ticked = reads()
        XCTAssertLessThanOrEqual(ticked.rows - opened.rows, Self.limits.tickRows, "rows a tick reads again")
    }

    /// Reads so far, from the debug line in the Sort menu.
    private func reads() -> (calls: Int, rows: Int) {
        app.buttons["Sort"].firstMatch.tap()
        let line = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Reads so far'")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: Self.timeout), "the store counted its reads")
        let label = line.label
        let numbers = label.filter { $0.isNumber || $0 == " " }.split(separator: " ").compactMap { Int($0) }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        print("COUNT \(label)")
        return (numbers.first ?? 0, numbers.dropFirst().first ?? 0)
    }
}
