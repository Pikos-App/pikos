import SQLite3
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
/// `@MainActor` because every `XCUIApplication` member is: the whole class,
/// so a subclass's tests inherit it and neither this file nor theirs has to
/// annotate a query at a time.
@MainActor
class PikosUITestCase: XCTestCase {
    private(set) var app: XCUIApplication!
    private var workspaceDirectory: URL!

    /// Long enough for a first launch that runs migrations on a cold simulator,
    /// short enough that a hang fails the job rather than occupying it.
    static let timeout: TimeInterval = 30

    /// Added to every launch, before the workspace is first opened.
    class var launchEnvironment: [String: String] { [:] }

    // The async pair rather than `setUpWithError`/`tearDownWithError`: an
    // override may add main-actor isolation only to an `async` method, and
    // everything below — the app handle included — is main-actor bound.
    override func setUp() async throws {
        try await super.setUp()
        // A failed assertion should stop the test at the point it failed. A UI
        // test that carries on after the screen is not what it expected reports
        // the fifth symptom of the first problem.
        continueAfterFailure = false

        workspaceDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-uitests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: workspaceDirectory, withIntermediateDirectories: true)

        app = XCUIApplication()
        app.launchEnvironment["PIKOS_WORKSPACE_DIRECTORY"] = workspaceDirectory.path
        for (key, value) in Self.launchEnvironment { app.launchEnvironment[key] = value }
        app.launch()
    }

    override func tearDown() async throws {
        app = nil
        if let workspaceDirectory {
            // Best-effort: a simulator that will not give the directory up must
            // not fail a test that already passed.
            try? FileManager.default.removeItem(at: workspaceDirectory)
        }
        workspaceDirectory = nil
        try await super.tearDown()
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
        // The first typing of a fresh simulator session can drop keystrokes, which titled the
        // first test's page wrongly in about half of full runs.
        if let typed = input.value as? String, typed != line {
            input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count) + line)
        }
        XCTAssertEqual(input.value as? String, line, "quick add holds the line as typed")

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

    /// Accept the system's notification prompt if it is up. It appears the first time a page has
    /// a time to remind at, and covers the screen until answered.
    func allowNotificationsIfAsked() {
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
    }

    /// Switch the page list to one of its views, through the title's switcher.
    func showView(_ name: String) {
        app.buttons["Switch view"].firstMatch.tap()
        // A row's label carries its count after the name: "Inbox, 2".
        let row = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", name, "\(name), ")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: Self.timeout), "the switcher lists \(name)")
        row.tap()
    }

    /// A page's id, read from the test's own workspace file, for tests that open a link to it.
    func pageId(titled title: String) -> String? {
        var db: OpaquePointer?
        let path = workspaceDirectory.appendingPathComponent("pikos.sqlite").path
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT id FROM pages WHERE title = ?1 LIMIT 1", -1, &statement, nil) == SQLITE_OK
        else { return nil }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, title, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { return nil }
        return String(cString: text)
    }

    /// Run one statement against the test's workspace file while the app is not running.
    func alterWorkspace(_ sql: String) {
        var db: OpaquePointer?
        let path = workspaceDirectory.appendingPathComponent("pikos.sqlite").path
        XCTAssertEqual(sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(db)))
    }

    /// The field or text view a vertical-axis `TextField` became, by its label.
    func textInput(_ label: String) -> XCUIElement {
        let view = app.textViews[label].firstMatch
        return view.waitForExistence(timeout: 2) ? view : app.textFields[label].firstMatch
    }
}
