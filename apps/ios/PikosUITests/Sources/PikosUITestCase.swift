import XCTest

/// Shared setup for every UI test: a freshly launched app over an empty
/// workspace.
///
/// The isolation is the point. A UI test that inherits whatever the last one
/// left behind fails in an order-dependent way, which is the failure people
/// learn to re-run rather than read. Each test here gets its own directory,
/// handed to the app through `WorkspaceLocation.workspaceOverrideKey` — the one
/// seam `XCUIApplication` has, since it can set the environment of the process
/// it launches but cannot reach inside it.
///
/// That also keeps CI out of the provisioning question. Without the override
/// the app would open the App Group container, and whether a simulator honours
/// that entitlement on an unsigned build is a question about certificates
/// rather than about the app.
class PikosUITestCase: XCTestCase {
    private(set) var app: XCUIApplication!
    private var workspace: URL!

    /// Long enough for a first launch that runs migrations on a cold simulator,
    /// short enough that a hang fails the job rather than occupying it.
    static let timeout: TimeInterval = 30

    override func setUpWithError() throws {
        try super.setUpWithError()
        // A failed assertion should stop the test at the point it failed. A UI
        // test that carries on after the screen is not what it expected reports
        // the fifth symptom of the first problem.
        continueAfterFailure = false

        workspace = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-uitests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: workspace, withIntermediateDirectories: true)

        app = XCUIApplication()
        app.launchEnvironment["PIKOS_WORKSPACE_DIRECTORY"] = workspace.path
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
        if let workspace {
            // Best-effort: a simulator that will not give the directory up must
            // not fail a test that already passed.
            try? FileManager.default.removeItem(at: workspace)
        }
        workspace = nil
        try super.tearDownWithError()
    }

    // MARK: - Shared steps

    /// Create a page through quick add, the way a person would.
    ///
    /// Goes through the real sheet rather than seeding the database, because
    /// the sheet is half of what these tests are for: a page that appears in
    /// the list proves the parse, the write and the refresh all happened.
    func quickAdd(_ line: String) {
        app.buttons["New page"].firstMatch.tap()

        let field = app.textViews["What needs doing?"].firstMatch
        let plain = app.textFields["What needs doing?"].firstMatch
        // The field is `TextField(axis: .vertical)`, which UIKit backs with a
        // text view on some versions and a text field on others. Asking for
        // both costs one query and survives the difference.
        let input = field.waitForExistence(timeout: 2) ? field : plain
        XCTAssertTrue(
            input.waitForExistence(timeout: Self.timeout), "quick add's field should be there")
        input.tap()
        input.typeText(line)

        app.buttons["Add"].firstMatch.tap()
    }

    /// The row for a page, by its title.
    ///
    /// `containing` rather than an exact label: the row is one accessibility
    /// element combining the title with its date and tags, so an exact match
    /// would break the moment a page gains either.
    func row(titled title: String) -> XCUIElement {
        app.cells.containing(.staticText, identifier: title).firstMatch
    }

    func assertRowExists(_ title: String, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(
            app.staticTexts[title].waitForExistence(timeout: Self.timeout),
            message.isEmpty ? "expected a row for \(title)" : message,
            file: file, line: line)
    }

    /// Switch the page list to one of its views.
    func showView(_ name: String) {
        app.buttons["Switch view"].firstMatch.tap()
        app.buttons[name].firstMatch.tap()
    }
}
