import XCTest

/// What survives the window changing shape under the app mid-task, which is what folding or
/// unfolding an iPhone Duo does to it.
///
/// Run on an iPad, whose window is dragged narrow across the split view's size-class line: the
/// same change of shell a fold makes, on hardware the simulator has.
extension TierOneTests {
    func testNarrowingTheWindowKeepsTheOpenPageTheCalendarDayAndAHalfTypedLine() throws {
        try requirePad()
        let switcher = app.buttons["Switch view"].firstMatch
        XCTAssertTrue(switcher.waitForHittable())
        XCTAssertFalse(app.buttons["Calendar"].exists, "it starts in the split view")

        app.buttons["Next"].firstMatch.tap()
        let weekOn = Calendar.current.date(byAdding: .day, value: 7, to: Date())!
        let dayShown = weekOn.formatted(.dateTime.month(.abbreviated).day())

        showView("Inbox")
        quickAdd("Trip notes")
        let row = app.collectionViews.staticTexts["Trip notes"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: Self.timeout))
        row.tap()
        XCTAssertTrue(textInput("Title").waitForExistence(timeout: Self.timeout))

        app.buttons["New page"].firstMatch.tap()
        let line = textInput("What needs doing?")
        XCTAssertTrue(line.waitForExistence(timeout: Self.timeout))
        line.tap()
        line.typeText("Call the plumber")
        // The keyboard covers the window's resize handle.
        app.keyboards.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'keyboard'")).firstMatch.tap()

        resizeWindow(toWidth: 0.4)
        XCTAssertTrue(line.waitForExistence(timeout: Self.timeout))
        XCTAssertEqual(line.value as? String, "Call the plumber", "the half-typed line is still there")

        app.buttons["Cancel"].firstMatch.tap()
        let title = textInput("Title")
        XCTAssertTrue(title.waitForExistence(timeout: Self.timeout), "the page is still open")
        XCTAssertEqual(title.value as? String, "Trip notes")
        XCTAssertFalse(switcher.isHittable, "pushed over the list, in the phone's shell")

        app.navigationBars.buttons.firstMatch.tap()
        let calendarPane = app.buttons["Calendar"].firstMatch
        XCTAssertTrue(calendarPane.waitForExistence(timeout: Self.timeout), "the bar switches panes again")
        calendarPane.tap()
        let visibleDays = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Visible days'")).firstMatch
        XCTAssertTrue(visibleDays.waitForHittable())
        XCTAssertTrue(visibleDays.label.contains(dayShown), "the calendar is still a week on: \(visibleDays.label)")
    }

    /// Drags the corner handle iPadOS draws on a windowed app. Restored to the full screen after,
    /// since the system remembers a window's size across launches.
    private func resizeWindow(toWidth fraction: CGFloat) {
        let screen = XCUIApplication(bundleIdentifier: "com.apple.springboard").windows.firstMatch
        let handle = { self.app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1)).withOffset(CGVector(dx: -8, dy: -8)) }
        handle().press(forDuration: 0.6, thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: fraction, dy: 0.95)))
        addTeardownBlock { @MainActor in
            handle().press(forDuration: 0.6, thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1)))
        }
    }
}
