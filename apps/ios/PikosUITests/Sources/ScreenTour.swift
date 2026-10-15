import XCTest

/// Every screen, sheet, dialog, menu and popover, screenshotted for design review.
///
/// Not part of the tier-1 gate: run it on its own with `-only-testing:PikosUITests/ScreenTour`
/// and export the attachments. Each screenshot is named `section|order|title`, which is what the
/// PDF script sorts and captions by. A surface the tour cannot reach is recorded in a `missed`
/// attachment instead of failing the run, so one moved label does not cost the other sixty shots.
final class ScreenTour: PikosUITestCase {
    override class var launchEnvironment: [String: String] { ["PIKOS_DEMO": "1"] }

    private static let demoKeys = [
        "PIKOS_DEMO_SCOPE", "PIKOS_DEMO_PANE", "PIKOS_DEMO_SPAN", "PIKOS_DEMO_SWITCHER",
        "PIKOS_DEMO_QUICKADD", "PIKOS_DEMO_SEARCH", "PIKOS_DEMO_SETTINGS", "PIKOS_DEMO_OPEN",
        "PIKOS_DEMO_DRAG", "PIKOS_DEMO_TIPS",
    ]

    private var missed: [String] = []

    override func setUp() async throws {
        try await super.setUp()
        continueAfterFailure = true
        _ = app.buttons["Switch view"].firstMatch.waitForExistence(timeout: Self.timeout)
        settle(3)
    }

    override func tearDown() async throws {
        if !missed.isEmpty {
            let note = XCTAttachment(string: missed.joined(separator: "\n"))
            note.name = "missed"
            note.lifetime = .keepAlways
            add(note)
        }
        try await super.tearDown()
    }

    // MARK: - Lists

    func test1Lists() {
        let section = "1 Lists"
        shot(section, 1, "Today")
        relaunch(["PIKOS_DEMO_SCOPE": "upcoming"])
        shot(section, 2, "Upcoming")
        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        shot(section, 3, "Inbox")
        relaunch(["PIKOS_DEMO_SCOPE": "Projects"])
        shot(section, 4, "A folder")
        if tap(button("Completed (1)"), "completed toggle") {
            app.collectionViews.firstMatch.swipeUp()
            shot(section, 5, "A folder with its completed pages open")
        }

        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        shot(section, 6, "View switcher")
        if tap(button("New folder"), "new folder") {
            app.typeText("Errands")
            shot(section, 7, "New folder, named in place")
        }

        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        if tap(button("Sort"), "sort menu") {
            shot(section, 8, "Sort menu")
        }

        if selectTwo() { shot(section, 9, "Select mode") }
        if selectTwo(), tap(app.buttons["When"].firstMatch, "selection when") {
            shot(section, 10, "Select mode: When")
        }
        if selectTwo(), tap(app.buttons["Move"].firstMatch, "selection move") {
            shot(section, 11, "Select mode: Move")
        }
        if selectTwo(), tap(app.buttons["Delete"].firstMatch, "selection delete") {
            shot(section, 12, "Select mode: Delete, with Undo and no confirmation")
        }

        relaunch()
        if let row = cell("Order FlexiSpot E7 frame") {
            row.swipeRight()
            shot(section, 13, "Swipe right on a row")
        }
        relaunch()
        if let row = cell("Order FlexiSpot E7 frame") {
            row.swipeLeft()
            shot(section, 14, "Swipe left on a row")
        }
        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        if let row = cell("Book the car in for a service") {
            row.swipeLeft()
            shot(section, 15, "Swipe left on an undated Inbox row")
        }

        relaunch()
        if longPressRow("Order FlexiSpot E7 frame") {
            shot(section, 16, "Page menu (hold a row)")
            if tap(app.buttons["When"].firstMatch, "when submenu") {
                shot(section, 17, "Page menu: When")
            }
        }
        relaunch()
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["Move to Folder"].firstMatch, "move submenu") {
            shot(section, 18, "Page menu: Move to Folder")
        }
        relaunch()
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["Rename"].firstMatch, "rename") {
            shot(section, 19, "Rename page")
        }
        relaunch()
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["Tags…"].firstMatch, "tags") {
            shot(section, 20, "Tags")
        }
        relaunch()
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["When"].firstMatch, "when submenu"),
            tap(app.buttons["Pick a Date…"].firstMatch, "pick a date")
        {
            shot(section, 21, "When sheet")
        }
        relaunch()
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["Repeat…"].firstMatch, "repeat") {
            shot(section, 22, "Repeat")
        }
        relaunch()
        if longPressRow("Water the plants"), tap(app.buttons["Repeat…"].firstMatch, "repeat on a repeating page") {
            app.swipeUp()
            shot(section, 23, "Repeat, on a page that repeats, with Ends")
        }

        relaunch(["PIKOS_DEMO_DRAG": "Call mom"])
        settle(3)
        shot(section, 24, "Holding a page over the day")

        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        if tap(button("Select"), "select") {
            shot(section, 25, "Select mode in a hand-sorted list, with reorder handles")
        }

        relaunch()
        if tap(app.buttons["Move to today"].firstMatch, "move to today") {
            settle(1)
            shot(section, 26, "Notice with Undo")
        }
    }

    // MARK: - Capture

    func test2QuickAdd() {
        let section = "2 Quick add"
        relaunch(["PIKOS_DEMO_QUICKADD": ""])
        shot(section, 1, "Quick add")
        relaunch(["PIKOS_DEMO_QUICKADD": "Call the dentist tomorrow at 3pm !high #health ~Personal"])
        shot(section, 2, "Quick add, a sentence read")
        let sentence = ["PIKOS_DEMO_QUICKADD": "Call the dentist tomorrow at 3pm !high #health ~Personal"]
        if tap(buttonStarting("When:"), "when chip") {
            shot(section, 3, "When menu")
        }
        relaunch(sentence)
        if tap(buttonStarting("Priority:"), "priority chip") {
            shot(section, 4, "Priority menu")
        }
        relaunch(sentence)
        if tap(buttonStarting("Folder:"), "folder chip") {
            shot(section, 5, "Folder menu")
        }
        relaunch()
        if tap(button("New page"), "new page from Today") {
            shot(section, 6, "Quick add opened from Today")
        }
        relaunch(["PIKOS_DEMO_SCOPE": "Projects"])
        if tap(button("New page"), "new page from a folder") {
            shot(section, 7, "Quick add opened from a folder")
        }
    }

    // MARK: - Calendar

    func test3Calendar() {
        let section = "3 Calendar"
        relaunch(["PIKOS_DEMO_PANE": "week"])
        shot(section, 1, "Day")
        relaunch(["PIKOS_DEMO_PANE": "week", "PIKOS_DEMO_SPAN": "threeDays"])
        shot(section, 2, "Three days")
        relaunch(["PIKOS_DEMO_PANE": "week", "PIKOS_DEMO_SPAN": "month"])
        shot(section, 4, "Month")

        relaunch(["PIKOS_DEMO_PANE": "week"])
        if tap(buttonStarting("Visible days"), "title") {
            shot(section, 5, "Title, opened into the span and a month")
        }

        relaunch(["PIKOS_DEMO_PANE": "week"])
        if longPressBlock("Call mom") {
            shot(section, 7, "Block menu (hold a block)")
        }
        relaunch(["PIKOS_DEMO_PANE": "week"])
        if longPressBlock("Water the plants") {
            shot(section, 8, "Repeating block menu")
            if tap(app.buttons["Skip this one"].firstMatch, "skip") {
                settle(1)
                shot(section, 9, "Skip, with days behind it")
            }
        }
        relaunch(["PIKOS_DEMO_PANE": "week"])
        if longPressBlock("Water the plants"), tap(app.buttons["Move this one…"].firstMatch, "move one") {
            shot(section, 10, "Move one occurrence")
        }
    }

    // MARK: - Search

    func test4Search() {
        let section = "4 Search"
        relaunch(["PIKOS_DEMO_SEARCH": ""])
        shot(section, 1, "Search, nothing typed")
        relaunch(["PIKOS_DEMO_SEARCH": "desk"])
        settle(1)
        shot(section, 2, "Results")
        if tap(buttonStarting("Show completed"), "show completed") {
            settle(1)
            shot(section, 3, "Results with completed pages")
        }
        relaunch(["PIKOS_DEMO_SEARCH": "hom"])
        settle(1)
        shot(section, 4, "Completions as tokens")
        relaunch(["PIKOS_DEMO_SEARCH": ""])
        if tap(button("Projects"), "folder chip") {
            settle(1)
            shot(section, 5, "Narrowed to a folder")
        }
    }

    // MARK: - Editor

    func test5Editor() {
        let section = "5 Editor"
        let page = ["PIKOS_DEMO_OPEN": "Order FlexiSpot E7 frame"]
        relaunch(page)
        shot(section, 1, "Page")
        if tap(buttonStarting("Folder:"), "folder chip") {
            shot(section, 2, "Folder menu")
        }
        relaunch(page)
        if tap(buttonStarting("Priority:"), "priority chip") {
            shot(section, 3, "Priority menu")
        }
        relaunch(page)
        if tap(buttonStarting("Reminders:"), "reminder chip") {
            shot(section, 4, "Reminder menu")
        }
        relaunch(page)
        if tap(button("Page options"), "page options") {
            shot(section, 5, "Page options")
        }
        relaunch(page)
        if tap(button("Start timing this page"), "focus timer") {
            settle(2)
            shot(section, 6, "Focus timer running")
            _ = tap(button("Stop timing"), "stop timing")
        }

        relaunch(page)
        let document = app.webViews.firstMatch
        if document.waitForExistence(timeout: 10) {
            document.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            settle(1.5)
            shot(section, 7, "Writing, with the formatting bar")
            if tap(button("More formatting"), "more formatting") {
                shot(section, 8, "More formatting")
                app.buttons["More formatting"].firstMatch.tap()
                settle(0.8)
            }
            if tap(button("Insert photo"), "insert photo") {
                settle(2)
                shot(section, 9, "Photo picker")
            }
        } else {
            missed.append("5 Editor: document webview")
        }
    }

    // MARK: - Settings, trash, folders

    func test6Settings() {
        let section = "6 Settings"
        relaunch(["PIKOS_DEMO_SETTINGS": "1"])
        shot(section, 1, "Settings")
        app.collectionViews.firstMatch.swipeUp()
        settle(0.5)
        shot(section, 2, "Settings, further down")
        app.collectionViews.firstMatch.swipeUp()
        settle(0.5)
        shot(section, 3, "Settings, the end")
        if tap(scrolledTo(button("Reset preferences")), "reset") {
            shot(section, 4, "Reset preferences")
        }
        relaunch(["PIKOS_DEMO_SETTINGS": "1"])
        if tap(scrolledTo(button("Delete all data")), "delete all") {
            shot(section, 5, "Delete all data")
        }

        relaunch(["PIKOS_DEMO_SETTINGS": "1"])
        if tap(buttonStarting("Theme"), "theme picker") {
            shot(section, 6, "A settings picker")
        }
        relaunch(["PIKOS_DEMO_SETTINGS": "1"])
        if tap(scrolledTo(buttonStarting("Calendars")), "calendars") {
            settle(1)
            shot(section, 7, "Calendars")
            if tap(button("Add CalDAV account"), "add account") {
                shot(section, 8, "Add a CalDAV account")
            }
        }

        relaunch(["PIKOS_DEMO_SETTINGS": "1"])
        if tap(scrolledTo(buttonStarting("Markdown")), "export markdown") {
            settle(3)
            shot(section, 9, "Export share sheet")
        }
    }

    func test7FoldersAndTrash() {
        let section = "7 Folders and trash"
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        if tap(button("Edit"), "edit folders") {
            settle(1)
            shot(section, 1, "Folders")
            if tap(button("Colour of Work"), "colour menu") {
                shot(section, 2, "Folder colour")
            }
        }
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        if tap(button("Edit"), "edit folders"), tap(button("More for Work"), "folder menu") {
            shot(section, 3, "Folder menu")
        }
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        if tap(button("Edit"), "edit folders"), tap(button("More for Work"), "folder menu") {
            if tap(app.buttons["Rename"].firstMatch, "rename folder") {
                shot(section, 5, "Rename folder, in place")
            }
        }

        relaunch()
        if longPressRow("Get 3 contractor quotes — kitchen") {
            if tap(app.buttons["Delete"].firstMatch, "menu delete") {
                settle(1)
                relaunch(["PIKOS_DEMO_SWITCHER": "1"])
                if tap(button("Trash"), "trash") {
                    settle(1)
                    shot(section, 6, "Trash")
                    if let trashed = cell("Get 3 contractor quotes — kitchen") {
                        trashed.swipeRight()
                        shot(section, 7, "Trash: swipe to restore")
                    }
                }
            }
        }
    }

    // MARK: - First run

    func test8FirstRun() throws {
        let section = "8 First run"
        let fresh = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-tour-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
        app.launchEnvironment["PIKOS_DEMO"] = nil
        app.launchEnvironment["PIKOS_WORKSPACE_DIRECTORY"] = fresh.path
        relaunch()
        shot(section, 1, "Today in a new workspace")
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        shot(section, 2, "View switcher, with Start here")
        relaunch(["PIKOS_DEMO_SCOPE": "Start here"])
        shot(section, 3, "Start here, the pages a new workspace comes with")
        if tap(app.staticTexts["Welcome to Pikos"].firstMatch, "welcome page") {
            settle(1)
            shot(section, 4, "The welcome page")
        }
        relaunch(["PIKOS_DEMO_SCOPE": "Start here", "PIKOS_DEMO_TIPS": "1"])
        settle(2)
        shot(section, 5, "Tips")
    }

    // MARK: - Helpers

    private func shot(_ section: String, _ order: Int, _ title: String) {
        settle(0.8)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(section)|\(String(format: "%02d", order))|\(title)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func relaunch(_ environment: [String: String] = [:]) {
        app.terminate()
        for key in Self.demoKeys { app.launchEnvironment[key] = nil }
        for (key, value) in environment { app.launchEnvironment[key] = value }
        app.launch()
        _ = app.wait(for: .runningForeground, timeout: Self.timeout)
        settle(3.5)
    }

    @discardableResult
    private func tap(_ element: XCUIElement, _ what: String) -> Bool {
        guard element.waitForExistence(timeout: 8) else {
            missed.append("\(name): \(what)")
            return false
        }
        element.tap()
        settle(0.8)
        return true
    }

    private func button(_ label: String) -> XCUIElement {
        app.buttons[label].firstMatch
    }

    private func buttonStarting(_ prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func cell(_ title: String) -> XCUIElement? {
        let row = app.collectionViews.cells.containing(.staticText, identifier: title).firstMatch
        guard row.waitForExistence(timeout: 8) else {
            missed.append("\(name): row \(title)")
            return nil
        }
        return row
    }

    private func tapRow(_ title: String) {
        cell(title)?.tap()
    }

    private func longPressRow(_ title: String) -> Bool {
        let text = app.collectionViews.staticTexts[title].firstMatch
        guard text.waitForExistence(timeout: 8) else {
            missed.append("\(name): hold row \(title)")
            return false
        }
        text.press(forDuration: 1.0)
        settle(0.8)
        return true
    }

    /// The day opens on the current hour, and the demo's blocks sit around it.
    private func longPressBlock(_ title: String) -> Bool {
        // Inside the grid's scroll view: the list pane's tray draws the same block, hidden underneath.
        let block = app.scrollViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        guard block.waitForExistence(timeout: 8) else {
            missed.append("\(name): block \(title)")
            return false
        }
        block.press(forDuration: 1.0)
        settle(0.8)
        return true
    }

    /// A fresh Today with two rows selected. Each selection verb starts from here, since closing a
    /// menu by tapping elsewhere is not reliable and once chose one of its items.
    private func selectTwo() -> Bool {
        relaunch()
        guard tap(button("Select"), "select") else {
            return false
        }
        tapRow("Call mom")
        tapRow("Transfer $1,200 to HYSA")
        return true
    }

    /// Scrolls a form until the element is on screen, since a lazy list has no row for it until then.
    private func scrolledTo(_ element: XCUIElement) -> XCUIElement {
        let list = app.collectionViews.firstMatch
        for _ in 0..<6 where !(element.exists && element.isHittable) {
            list.swipeUp()
            settle(0.4)
        }
        return element
    }
}
