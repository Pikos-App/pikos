import XCTest

final class SettingsTests: PikosUITestCase {
    // qa: CLOUD-124:2
    func testABuildWithoutAContainerShowsNoICloudSection() {
        app.buttons["Settings"].firstMatch.tap()
        let form = app.collectionViews.firstMatch
        XCTAssertTrue(form.waitForExistence(timeout: Self.timeout), "Settings is open")
        let calendars = app.staticTexts["Calendars"]
        let yourData = app.staticTexts["On this device"]
        for _ in 0..<6 where !(calendars.exists && yourData.exists) { form.swipeUp() }

        XCTAssertTrue(calendars.exists && yourData.exists, "the sections either side of iCloud's are on screen")
        XCTAssertFalse(app.switches["Sync with iCloud"].exists)
    }
}
