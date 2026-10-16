import XCTest

/// The flows that must work, mirroring the desktop's `@tier1` Playwright set.
///
/// Chosen so that a failure here means the app is unusable rather than
/// imperfect: it launched, a page can be made, ticked, found, opened and
/// scheduled. Anything narrower is a question the Rust tests or `PikosSupport`
/// answer in milliseconds.
final class TierOneTests: PikosUITestCase {
    func testTheAppLaunchesOnTodayWithTheBar() {
        let switcher = app.buttons["Switch view"].firstMatch
        XCTAssertTrue(switcher.waitForExistence(timeout: Self.timeout), "the app should open on the list")
        XCTAssertEqual(switcher.value as? String, "Today", "and on Today")
        XCTAssertTrue(app.buttons["New page"].firstMatch.exists, "with a way to add a page")
        XCTAssertTrue(app.buttons["Calendar"].firstMatch.exists, "and the way to the calendar")
    }

    func testScrollingTheCalendarDownShrinksTheBarAndTappingBringsItBack() {
        app.buttons["Calendar"].firstMatch.tap()
        let grid = app.scrollViews.firstMatch
        XCTAssertTrue(grid.waitForExistence(timeout: Self.timeout))
        // The grid opens at the current hour, which in the evening is its end, with no room to scroll down.
        grid.swipeDown()
        grid.swipeUp()

        let show = app.buttons["Show the bar"]
        XCTAssertTrue(show.waitForExistence(timeout: 5), "scrolling down shrinks the bar to one button")
        XCTAssertFalse(app.buttons["Search"].isHittable, "and the rest of it is out of the way")
        XCTAssertTrue(app.buttons["New page"].isHittable, "except capture")

        show.tap()
        XCTAssertTrue(app.buttons["Search"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Search"].isHittable, "one tap brings the bar back")
    }

    func testAFocusLinkOpensThePageWithTheTimerRunning() throws {
        quickAdd("Write the report today")
        assertRowExists("Write the report")
        let id = try XCTUnwrap(pageId(titled: "Write the report"))

        app.open(try XCTUnwrap(URL(string: "pikos://page/\(id)?focus=1")))

        XCTAssertTrue(
            app.buttons["Stop timing"].waitForExistence(timeout: Self.timeout),
            "the widget's Focus button opens the page already timing")
    }

    func testQuickAddCreatesAPageThatAppearsInTheList() {
        quickAdd("Buy milk today")
        assertRowExists("Buy milk", "the parsed title, not the raw line")
    }

    /// A page typed while a folder is showing lands in that folder, not in the Inbox out of sight.
    func testAPageAddedFromAFolderLandsInThatFolder() {
        app.buttons["Switch view"].firstMatch.tap()
        let newFolder = app.buttons["New folder"].firstMatch
        XCTAssertTrue(newFolder.waitForExistence(timeout: Self.timeout))
        newFolder.tap()
        app.typeText("Errands\n")
        XCTAssertTrue(
            app.buttons["Switch view"].firstMatch.waitForExistence(timeout: Self.timeout),
            "naming the folder in place opens it")

        quickAdd("Buy stamps")
        assertRowExists("Buy stamps", "the new page is in the folder on screen")
        XCTAssertFalse(app.buttons["View"].exists, "and no notice points somewhere else")
    }

    /// The checkbox sits beside the link rather than inside it, so it has to be proven to land.
    func testTickingAPageMovesItOutOfTheOpenList() {
        quickAdd("Buy milk today")
        assertRowExists("Buy milk")

        app.buttons["Mark as done"].firstMatch.tap()

        XCTAssertTrue(
            waitForDisappearance(of: app.staticTexts["Buy milk"]),
            "a ticked page leaves the open list")
        XCTAssertTrue(
            app.buttons["Completed (1)"].waitForExistence(timeout: Self.timeout),
            "and is counted as finished")
    }

    func testTheCompletedSectionLoadsAgainAfterSwitchingViews() {
        showView("Inbox")
        quickAdd("Buy milk")
        assertRowExists("Buy milk")
        app.buttons["Mark as done"].firstMatch.tap()
        let completed = app.buttons["Completed (1)"]
        XCTAssertTrue(completed.waitForExistence(timeout: Self.timeout))
        completed.tap()
        assertRowExists("Buy milk", "opening the section shows what was finished")

        showView("Start here")
        showView("Inbox")

        XCTAssertTrue(completed.waitForExistence(timeout: Self.timeout))
        XCTAssertEqual(completed.value as? String, "Collapsed", "a view switched to starts with the section closed")
        completed.tap()
        assertRowExists("Buy milk", "and opening it loads that view's finished pages")
        XCTAssertFalse(app.staticTexts["Loading…"].exists)
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
            app.buttons["Quarterly review"].waitForExistence(timeout: Self.timeout),
            "full-text search should find it")
    }

    func testSearchSuggestsThePageLastOpenedBeforeAnythingIsTyped() {
        quickAdd("Trip notes today")
        assertRowExists("Trip notes")
        app.staticTexts["Trip notes"].firstMatch.tap()
        XCTAssertTrue(textInput("Title").waitForExistence(timeout: Self.timeout))
        app.navigationBars.buttons.firstMatch.tap()

        app.buttons["Search"].firstMatch.tap()
        XCTAssertTrue(
            app.buttons["Trip notes"].waitForExistence(timeout: Self.timeout),
            "the page just opened is offered with the field still empty")
    }

    func testAReminderSetInThePageHeaderIsKept() {
        quickAdd("Call the dentist today at 11pm")
        allowNotificationsIfAsked()
        assertRowExists("Call the dentist")
        app.collectionViews.staticTexts["Call the dentist"].firstMatch.tap()
        XCTAssertTrue(textInput("Title").waitForExistence(timeout: Self.timeout))

        let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reminders:'")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: Self.timeout), "a scheduled page shows its reminders")
        chip.tap()
        app.buttons["30 min before"].firstMatch.tap()
        XCTAssertTrue(
            app.buttons["Reminders: 30 min"].waitForExistence(timeout: Self.timeout), "the chip names the new lead")

        app.navigationBars.buttons.firstMatch.tap()
        app.collectionViews.staticTexts["Call the dentist"].firstMatch.tap()
        XCTAssertTrue(
            app.buttons["Reminders: 30 min"].waitForExistence(timeout: Self.timeout), "and it is still there on reopening")
    }

    /// The desktop's week-of-the-month preset and an end, both saved and read back through the rule
    /// layer, which could hold neither before.
    func testAMonthlyWeekdayRepeatWithAnEndIsKept() {
        quickAdd("Book club today")
        assertRowExists("Book club")

        openRepeat("Book club")
        let preset = app.buttons.matching(
            NSPredicate(format: "label MATCHES 'Every month on the .+ [A-Z][a-z]+day'")
        ).firstMatch
        XCTAssertTrue(preset.waitForExistence(timeout: Self.timeout), "the week-of-the-month preset is offered")
        let presetLabel = preset.label
        preset.tap()
        XCTAssertTrue(waitForDisappearance(of: preset), "a preset applies on the tap and closes the sheet")

        openRepeat("Book club")
        app.collectionViews.firstMatch.swipeUp()
        let ends = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ends'")).firstMatch
        XCTAssertTrue(ends.waitForExistence(timeout: Self.timeout), "a repeating page can say when it stops")
        ends.tap()
        app.buttons["After"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["10 times"].waitForExistence(timeout: Self.timeout))
        app.buttons["Done"].firstMatch.tap()

        openRepeat("Book club")
        XCTAssertTrue(app.buttons[presetLabel].waitForExistence(timeout: Self.timeout))
        app.collectionViews.firstMatch.swipeUp()
        XCTAssertTrue(
            app.staticTexts["10 times"].waitForExistence(timeout: Self.timeout), "the end is still there on reopening")
    }

    func testTheMonthViewOpensADayWhenOneIsTapped() {
        app.buttons["Calendar"].firstMatch.tap()
        let title = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Visible days'")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: Self.timeout))
        title.tap()
        app.buttons["Month"].firstMatch.tap()

        let today = app.buttons.matching(NSPredicate(format: "label CONTAINS ', today, '")).firstMatch
        XCTAssertTrue(today.waitForExistence(timeout: Self.timeout), "the month shows today")
        today.tap()
        XCTAssertTrue(
            app.otherElements["Week"].waitForExistence(timeout: Self.timeout), "and tapping it lands on the day view")
    }

    func testRowsInAManuallySortedInboxCanBeRearranged() {
        showView("Inbox")
        for title in ["Alpha errand", "Beta errand", "Gamma errand"] {
            quickAdd(title)
            assertRowExists(title)
        }
        app.buttons["Select"].firstMatch.tap()

        let handle = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder' AND label CONTAINS 'Gamma'")).firstMatch
        XCTAssertTrue(handle.waitForExistence(timeout: Self.timeout), "select mode shows reorder handles")
        let alpha = app.staticTexts["Alpha errand"].firstMatch
        handle.press(forDuration: 0.6, thenDragTo: alpha, withVelocity: .slow, thenHoldForDuration: 0.5)

        app.buttons["Done"].firstMatch.tap()
        let gamma = app.staticTexts["Gamma errand"].firstMatch
        XCTAssertTrue(gamma.waitForExistence(timeout: Self.timeout))
        XCTAssertLessThan(gamma.frame.minY, alpha.frame.minY, "the dragged row stays above the one it was dropped on")
    }

    func testFoldersRearrangedOnThePhoneKeepTheirOrderAfterARelaunch() {
        app.buttons["Switch view"].firstMatch.tap()
        let edit = app.buttons["Edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: Self.timeout))
        edit.tap()
        let field = app.textFields["New folder"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: Self.timeout))
        field.tap()
        field.typeText("Alpha\n")
        field.typeText("Beta\n")

        let handle = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder' AND label CONTAINS 'Beta'")).firstMatch
        XCTAssertTrue(handle.waitForExistence(timeout: Self.timeout), "the folder manager shows reorder handles")
        handle.press(forDuration: 0.6, thenDragTo: app.textFields["Alpha"].firstMatch, withVelocity: .slow, thenHoldForDuration: 0.5)
        app.navigationBars["Folders"].buttons["Done"].tap()

        app.terminate()
        app.launch()
        app.buttons["Switch view"].firstMatch.tap()
        let folder = { (name: String) in
            self.app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", name, "\(name), ")).firstMatch
        }
        XCTAssertTrue(folder("Beta").waitForExistence(timeout: Self.timeout))
        XCTAssertLessThan(folder("Beta").frame.minY, folder("Alpha").frame.minY, "the order was saved, not just drawn")
    }

    /// The one flow that crosses into the webview, so it proves the editor bundle shipped.
    func testOpeningAPageShowsTheEditor() {
        quickAdd("Trip notes today")
        assertRowExists("Trip notes")

        app.staticTexts["Trip notes"].firstMatch.tap()

        let title = textInput("Title")
        XCTAssertTrue(title.waitForExistence(timeout: Self.timeout), "the editor opens on the page")
        XCTAssertEqual(title.value as? String, "Trip notes")
        XCTAssertTrue(
            app.webViews.firstMatch.waitForExistence(timeout: Self.timeout),
            "and the editor webview loads — a missing bundle fails here")
    }

    /// The desktop's signature move on a phone: lift a page, drop it on an hour of today.
    /// One press, two outcomes: still opens the menu, moving carries the page (the drag tests below).
    func testHoldingARowStillOpensItsMenu() {
        quickAdd("Plan the offsite today")
        let title = app.staticTexts["Plan the offsite"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: Self.timeout))

        title.press(forDuration: 1.2)

        XCTAssertTrue(app.buttons["Tomorrow"].waitForExistence(timeout: 5), "the page menu is open")
        XCTAssertFalse(app.buttons["Undo"].exists, "and nothing was moved")
    }

    func testDraggingAPageOntoTheDayGivesItATime() {
        quickAdd("Plan the offsite today")
        let title = app.staticTexts["Plan the offsite"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: Self.timeout))

        XCTAssertFalse(app.buttons["Day peek"].exists, "Today is already the schedule, so the day rests out of sight")

        // Where the day has risen to by the time the finger arrives: it opens to six hours on lift.
        let target = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.8))
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 1.2, thenDragTo: target, withVelocity: .default, thenHoldForDuration: 0.8)

        XCTAssertTrue(
            app.buttons["Undo"].waitForExistence(timeout: 5), "the drop schedules the page and offers it back")
        XCTAssertFalse(app.staticTexts["Drop on an hour"].exists, "and the day settles back")
    }

    func testTheDaySitsUnderEveryListButTheTwoThatAreTheSchedule() {
        showView("Inbox")
        XCTAssertTrue(app.buttons["Day peek"].waitForExistence(timeout: Self.timeout), "under the Inbox")
        showView("Upcoming")
        XCTAssertTrue(waitForDisappearance(of: app.buttons["Day peek"]), "and not under Upcoming")
    }

    /// A drag that ends anywhere but the day must not leave the day waiting for a drop.
    func testALiftedPageLetGoOverTheListLeavesTheDayAsItWas() {
        quickAdd("Plan the offsite today")
        let title = app.staticTexts["Plan the offsite"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: Self.timeout))

        let nowhere = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 1.2, thenDragTo: nowhere, withVelocity: .default, thenHoldForDuration: 0.3)

        XCTAssertTrue(
            waitForDisappearance(of: app.staticTexts["Drop on an hour"]), "the day stops waiting for a drop")
        XCTAssertFalse(app.buttons["Undo"].exists, "and nothing was scheduled")
    }

    /// `waitForExistence` has no opposite, and polling `.exists` in a loop races the query.
    private func openRepeat(_ title: String) {
        app.collectionViews.staticTexts[title].firstMatch.press(forDuration: 1.0)
        let repeatItem = app.buttons["Repeat…"].firstMatch
        XCTAssertTrue(repeatItem.waitForExistence(timeout: Self.timeout))
        repeatItem.tap()
    }

    private func waitForDisappearance(of element: XCUIElement) -> Bool {
        let gone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: Self.timeout) == .completed
    }
}
