import XCTest

/// The shell's arrangements, each on the device that gets it.
///
/// Both panes stay in the accessibility tree whether or not they are on screen, so these assert
/// on `isHittable` and on frames rather than on existence.
extension TierOneTests {
    func testTheSidewaysPhoneShowsTheListBesideTheCalendarAndOffersNoWeek() throws {
        try requirePhone()
        rotate(to: .landscapeLeft)

        let switcher = app.buttons["Switch view"].firstMatch
        let calendarTitle = visibleDays
        XCTAssertTrue(calendarTitle.waitForHittable(), "the calendar is on screen without asking for it")
        XCTAssertTrue(switcher.isHittable, "beside the list")
        XCTAssertLessThan(switcher.frame.maxX, calendarTitle.frame.minX, "the list on the left, as on the desktop")
        XCTAssertFalse(app.buttons["List"].exists, "and the bar has no pane to switch")

        calendarTitle.tap()
        XCTAssertTrue(app.buttons["3 Days"].firstMatch.waitForExistence(timeout: Self.timeout))
        XCTAssertTrue(app.buttons["Day"].firstMatch.exists)
        XCTAssertFalse(app.buttons["Week"].exists, "seven columns are not offered in 400 points of height")
        calendarTitle.tap()

        showView("Inbox")
        XCTAssertFalse(app.buttons["Day peek"].exists, "the day under the list gives way to the calendar beside it")

        quickAdd("Trip notes")
        assertRowExists("Trip notes")
        app.staticTexts["Trip notes"].firstMatch.tap()
        XCTAssertTrue(textInput("Title").waitForExistence(timeout: Self.timeout), "a page opens from the list beside the calendar")
    }

    func testTheUprightPhoneShowsOnePaneAtATime() throws {
        try requirePhone()

        let switcher = app.buttons["Switch view"].firstMatch
        XCTAssertTrue(switcher.waitForHittable())
        XCTAssertFalse(visibleDays.isHittable, "the calendar waits behind the bar's toggle")

        app.buttons["Calendar"].firstMatch.tap()
        XCTAssertTrue(visibleDays.waitForHittable())
        XCTAssertFalse(switcher.isHittable, "and takes the whole screen when chosen")
        visibleDays.tap()
        XCTAssertTrue(app.buttons["3 Days"].firstMatch.waitForExistence(timeout: Self.timeout))
        XCTAssertFalse(app.buttons["Week"].exists)
    }

    func testTheIPadShowsTheSidebarTheListAndTheCalendarAsThreePanels() throws {
        try requirePad()
        rotate(to: .landscapeLeft)

        let inbox = app.buttons.matching(NSPredicate(format: "label == 'Inbox' OR label BEGINSWITH 'Inbox, '")).firstMatch
        let switcher = app.buttons["Switch view"].firstMatch
        XCTAssertTrue(inbox.waitForHittable(), "every view and folder is a sidebar")
        XCTAssertTrue(switcher.isHittable, "beside the list")
        XCTAssertTrue(visibleDays.isHittable, "beside the calendar")
        XCTAssertLessThan(inbox.frame.maxX, switcher.frame.minX)
        XCTAssertLessThan(switcher.frame.maxX, visibleDays.frame.minX, "in the Mac's order")
        XCTAssertFalse(app.buttons["Calendar"].exists, "with no pane to switch to")

        inbox.tap()
        XCTAssertEqual(switcher.value as? String, "Inbox", "the sidebar chooses what the list shows")

        visibleDays.tap()
        XCTAssertTrue(app.buttons["Week"].firstMatch.waitForExistence(timeout: Self.timeout), "a week has the room here")
        visibleDays.tap()

        quickAdd("Trip notes")
        assertRowExists("Trip notes")
        app.staticTexts["Trip notes"].firstMatch.tap()
        XCTAssertTrue(textInput("Title").waitForExistence(timeout: Self.timeout), "a page opens in place of the calendar")
        XCTAssertTrue(switcher.isHittable, "and the list stays beside it")
    }

    private var visibleDays: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Visible days'")).firstMatch
    }

    func requirePhone() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "a phone's arrangement")
    }

    func requirePad() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's arrangement")
    }

    /// Turned back upright afterwards: the simulator keeps its orientation into the next test.
    func rotate(to orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        addTeardownBlock { @MainActor in XCUIDevice.shared.orientation = .portrait }
    }
}

extension XCUIElement {
    func waitForHittable(timeout: TimeInterval = PikosUITestCase.timeout) -> Bool {
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: self)
        return XCTWaiter().wait(for: [hittable], timeout: timeout) == .completed
    }
}
