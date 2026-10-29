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

    // qa: IOS-48
    func testBackingUpToFilesSaysWhenAndLeavesTodaysFolderInTheAppsDocuments() throws {
        let backups = try appDocuments().appendingPathComponent("Backups", isDirectory: true)
        try? FileManager.default.removeItem(at: backups)
        app.buttons["Settings"].firstMatch.tap()
        let form = app.collectionViews.firstMatch
        XCTAssertTrue(form.waitForExistence(timeout: Self.timeout), "Settings is open")
        let backUp = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Back up to Files'")).firstMatch
        for _ in 0..<6 where !backUp.isHittable { form.swipeUp() }
        XCTAssertTrue(backUp.label.contains("Never backed up"), backUp.label)

        backUp.tap()

        let saysWhen = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS 'Last backup Today at'"), object: backUp)
        XCTAssertEqual(XCTWaiter().wait(for: [saysWhen], timeout: Self.timeout), .completed, "the row says when")
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "'Pikos 'yyyy-MM-dd"
        let folders = try FileManager.default.contentsOfDirectory(atPath: backups.path)
        let today = try XCTUnwrap(folders.first { $0.hasPrefix(day.string(from: Date())) }, "a folder named for today")
        let database = backups.appendingPathComponent(today).appendingPathComponent("pikos.sqlite")
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.path), "holding the workspace")
    }

    /// The app's own Documents, where backups go rather than the workspace directory a test hands
    /// the app: the simulator's container for the app's bundle id, a sibling of the runner's own.
    private func appDocuments() throws -> URL {
        let bundleId = try XCTUnwrap(app.value(forKey: "bundleID") as? String, "XCTest no longer names the app")
        let containers = URL(fileURLWithPath: NSHomeDirectory()).deletingLastPathComponent()
        let container = try FileManager.default.contentsOfDirectory(at: containers, includingPropertiesForKeys: nil)
            .first {
                let metadata = $0.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")
                return NSDictionary(contentsOf: metadata)?["MCMMetadataIdentifier"] as? String == bundleId
            }
        return try XCTUnwrap(container, "the app's container").appendingPathComponent("Documents", isDirectory: true)
    }
}
