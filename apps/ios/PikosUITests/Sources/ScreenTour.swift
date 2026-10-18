import XCTest

/// Every screen, sheet, dialog, menu and popover, screenshotted for design review.
///
/// Not part of the tier-1 gate: run it on its own with `-only-testing:PikosUITests/ScreenTour`
/// and export the attachments. Each screenshot is named `section|order|title`, which is what the
/// PDF script sorts and captions by. A surface the tour cannot reach is recorded in a `missed`
/// attachment and fails the run at the end, so one moved label does not cost the other sixty shots
/// but does not pass either. Each surface also gets the system accessibility audit, its findings
/// in an `accessibility` attachment: reported rather than failing until the first runs' findings
/// are either fixed or judged.
final class ScreenTour: PikosUITestCase {
    override class var launchEnvironment: [String: String] { ["PIKOS_DEMO": "1"] }

    private static let demoKeys = [
        "PIKOS_DEMO_SCOPE", "PIKOS_DEMO_PANE", "PIKOS_DEMO_SPAN", "PIKOS_DEMO_SWITCHER",
        "PIKOS_DEMO_QUICKADD", "PIKOS_DEMO_SEARCH", "PIKOS_DEMO_SETTINGS", "PIKOS_DEMO_OPEN",
        "PIKOS_DEMO_DRAG", "PIKOS_DEMO_TIPS", "PIKOS_DEMO_ERROR",
    ]

    private var missed: [String] = []
    private var accessibility: [String] = []

    override func setUp() async throws {
        try await super.setUp()
        continueAfterFailure = true
        _ = app.buttons["Switch view"].firstMatch.waitForExistence(timeout: Self.timeout)
        settle(3)
    }

    override func tearDown() async throws {
        if !accessibility.isEmpty {
            let report = XCTAttachment(string: accessibility.joined(separator: "\n"))
            report.name = "accessibility"
            report.lifetime = .keepAlways
            add(report)
        }
        if !missed.isEmpty {
            let note = XCTAttachment(string: missed.joined(separator: "\n"))
            note.name = "missed"
            note.lifetime = .keepAlways
            add(note)
            XCTFail("surfaces the tour couldn't reach: \(missed.joined(separator: "; "))")
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
            row.swipeLeft()
            shot(section, 14, "Swipe left on a row")
            let folder = app.buttons["Folder"].firstMatch
            if folder.waitForExistence(timeout: 3) {
                folder.tap()
                shot(section, 13, "Folder, from a swipe")
            }
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
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["Move to folder"].firstMatch, "move submenu") {
            shot(section, 18, "Page menu: Move to folder")
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
            tap(app.buttons["Pick a date…"].firstMatch, "pick a date")
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

        // From the Inbox: Today has no day under it to hold a page over.
        relaunch(["PIKOS_DEMO_SCOPE": "inbox", "PIKOS_DEMO_DRAG": "Book the car in for a service"])
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

    // MARK: - Wide

    /// The sideways phone on a phone, the three panels on an iPad, each turned both ways.
    func test9Wide() {
        let section = "9 Wide"
        XCUIDevice.shared.orientation = .landscapeLeft
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        shot(section, 1, "Sideways: the Inbox")
        relaunch()
        shot(section, 2, "Sideways: Today")
        if tap(buttonStarting("Visible days"), "calendar title") {
            shot(section, 3, "Sideways: the span choice")
        }
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        shot(section, 4, "Sideways: the view switcher")
        relaunch()
        if tap(app.collectionViews.staticTexts["Order FlexiSpot E7 frame"].firstMatch, "row") {
            settle(1.5)
            shot(section, 5, "Sideways: a page open")
        }
        XCUIDevice.shared.orientation = .portrait
        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        shot(section, 6, "Upright: the Inbox")
    }

    // MARK: - Widgets

    /// The app's debug widget gallery: each widget's real view at its family's size, since no test
    /// can reach a home screen. The lock screen is always dark.
    func test10Widgets() {
        let section = "10 Widgets"
        let boards = ["list", "now", "list-edge", "now-edge"]
        for (index, board) in boards.enumerated() {
            relaunch(arguments: ["-PikosWidgetGallery", board])
            shot(section, index + 1, "Gallery: \(board), light")
            relaunch(arguments: ["-PikosWidgetGallery", board, "-PikosWidgetGalleryDark", "YES"])
            shot(section, index + 11, "Gallery: \(board), dark")
        }
        relaunch(arguments: ["-PikosWidgetGallery", "lock"])
        shot(section, 21, "Gallery: lock screen")
    }

    // MARK: - Empty and error states

    func test11States() throws {
        let section = "11 States"
        relaunch(["PIKOS_DEMO_ERROR": "The page could not be saved. Try again."])
        shot(section, 1, "An error")

        let fresh = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-tour-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
        app.launchEnvironment["PIKOS_DEMO"] = nil
        app.launchEnvironment["PIKOS_WORKSPACE_DIRECTORY"] = fresh.path
        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        shot(section, 2, "An empty Inbox")
        relaunch(["PIKOS_DEMO_SCOPE": "upcoming"])
        shot(section, 3, "An empty Upcoming")
        relaunch(["PIKOS_DEMO_PANE": "week"])
        shot(section, 4, "An empty day")
        relaunch(["PIKOS_DEMO_PANE": "week", "PIKOS_DEMO_SPAN": "month"])
        shot(section, 5, "An empty month")
        relaunch(["PIKOS_DEMO_SEARCH": "zebra"])
        settle(1)
        shot(section, 6, "Search with no results")
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        if tap(button("Trash"), "trash") {
            settle(1)
            shot(section, 7, "An empty trash")
        }
    }

    // MARK: - The main screens, for a second appearance or text size

    /// One shot of each screen a person spends time on. Run on its own after switching the
    /// simulator to dark, or to the largest text size, to see those without the whole tour.
    func test12Essentials() {
        let section = "12 Essentials"
        shot(section, 1, "Today")
        relaunch(["PIKOS_DEMO_SCOPE": "inbox"])
        shot(section, 2, "Inbox")
        relaunch(["PIKOS_DEMO_SCOPE": "Projects"])
        shot(section, 3, "A folder")
        relaunch(["PIKOS_DEMO_SCOPE": "upcoming"])
        shot(section, 4, "Upcoming")
        relaunch(["PIKOS_DEMO_SWITCHER": "1"])
        shot(section, 5, "View switcher")
        relaunch(["PIKOS_DEMO_PANE": "week"])
        shot(section, 6, "Day")
        relaunch(["PIKOS_DEMO_PANE": "week", "PIKOS_DEMO_SPAN": "threeDays"])
        shot(section, 7, "Three days")
        relaunch(["PIKOS_DEMO_PANE": "week", "PIKOS_DEMO_SPAN": "month"])
        shot(section, 8, "Month")
        relaunch(["PIKOS_DEMO_QUICKADD": "Call the dentist tomorrow at 3pm !high #health ~Personal"])
        shot(section, 9, "Quick add")
        relaunch(["PIKOS_DEMO_SEARCH": "desk"])
        settle(1)
        shot(section, 10, "Search results")
        relaunch(["PIKOS_DEMO_OPEN": "Order FlexiSpot E7 frame"])
        shot(section, 11, "Page")
        relaunch(["PIKOS_DEMO_SETTINGS": "1"])
        shot(section, 12, "Settings")
        relaunch()
        if longPressRow("Order FlexiSpot E7 frame") {
            shot(section, 13, "Page menu")
        }
        relaunch()
        if tap(app.buttons["Move to today"].firstMatch, "move to today") {
            settle(1)
            shot(section, 14, "Notice")
        }
    }

    // MARK: - Writing space

    /// Each screen where a person types, with the keyboard up, and how many points the text has
    /// between the top of where it is typed and the first thing that is not the text: the keyboard,
    /// the formatting bar, or a control below the field.
    func test13Writing() {
        let section = "13 Writing"
        var lines: [String] = []
        let page = ["PIKOS_DEMO_OPEN": "Order FlexiSpot E7 frame"]

        relaunch(page)
        let document = app.webViews.firstMatch
        if document.waitForExistence(timeout: 10) {
            document.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            settle(1.5)
            shot(section, 1, "The document")
            let bar = app.buttons["More formatting"].firstMatch
            let bottom = bar.exists ? bar.frame.minY : keyboardTop()
            lines.append(measure("document", top: document.frame.minY, bottom: bottom))
        }

        relaunch(page)
        let title = textInput("Title")
        if tap(title, "title") {
            settle(1)
            shot(section, 2, "The title")
            lines.append(measure("title", top: title.frame.minY, bottom: keyboardTop()))
        }

        relaunch(page)
        let subtitle = textInput("Subtitle")
        if tap(subtitle, "subtitle") {
            settle(1)
            shot(section, 3, "The subtitle")
            lines.append(measure("subtitle", top: subtitle.frame.minY, bottom: keyboardTop()))
        }

        // The empty sheet's hint sits where it would sit under a sentence, so its top is where the
        // sentence stopped while the hint stayed up.
        relaunch(["PIKOS_DEMO_QUICKADD": ""])
        let emptyHint = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Type a date")).firstMatch
        let hintTop = emptyHint.waitForExistence(timeout: 8) ? emptyHint.frame.minY : nil

        // A sentence typed: the chips under it move down as it grows, and whatever sits fixed above the
        // keyboard is where it stops.
        relaunch(["PIKOS_DEMO_QUICKADD": "Call the dentist tomorrow at 3pm !high #health"])
        let line = textInput("What needs doing?")
        if line.waitForExistence(timeout: 8) {
            settle(1)
            shot(section, 4, "Quick add")
            let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "When")).firstMatch
            let chips = chip.exists ? chip.frame.maxY + 12 - line.frame.maxY : 0
            let hint = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Type a date")).firstMatch
            let limit = hint.exists ? hint.frame.minY : keyboardTop()
            lines.append(measure("quick add", top: line.frame.minY, bottom: limit - chips))
            if let hintTop {
                lines.append(measure("quick add, were the hint kept", top: line.frame.minY, bottom: hintTop - chips))
            }
        }

        relaunch()
        if longPressRow("Order FlexiSpot E7 frame"), tap(app.buttons["Rename"].firstMatch, "rename") {
            settle(1)
            shot(section, 5, "Rename")
            let field = app.alerts.textFields.firstMatch
            lines.append(measure("rename", top: field.frame.minY, bottom: field.frame.maxY))
        }

        let note = XCTAttachment(string: lines.joined(separator: "\n"))
        note.name = "\(section)|00|measurements"
        note.lifetime = .keepAlways
        add(note)
    }

    private func keyboardTop() -> CGFloat {
        let keyboard = app.keyboards.firstMatch
        return keyboard.exists ? keyboard.frame.minY : app.frame.maxY
    }

    private func measure(_ name: String, top: CGFloat, bottom: CGFloat) -> String {
        "\(name): \(Int((bottom - top).rounded()))pt (from y \(Int(top)) to y \(Int(bottom)))"
    }

    // MARK: - Helpers

    private func shot(_ section: String, _ order: Int, _ title: String) {
        settle(0.8)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(section)|\(String(format: "%02d", order))|\(title)"
        attachment.lifetime = .keepAlways
        add(attachment)
        audit(title)
    }

    /// Notes what the system audit finds on the surface on screen, without failing on it.
    private func audit(_ surface: String) {
        try? app.performAccessibilityAudit { issue in
            let element = issue.element?.label ?? issue.element?.identifier ?? "?"
            self.accessibility.append("\(surface): \(issue.compactDescription) [\(element)]")
            return true
        }
    }

    private func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func relaunch(_ environment: [String: String] = [:], arguments: [String] = []) {
        app.terminate()
        for key in Self.demoKeys { app.launchEnvironment[key] = nil }
        for (key, value) in environment { app.launchEnvironment[key] = value }
        app.launchArguments = arguments
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
