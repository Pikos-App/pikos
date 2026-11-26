import XCTest

@testable import PikosSupport

/// A host test has no App Group entitlement, so only the override path and the
/// properties that hold on either branch are testable here.
final class WorkspaceLocationTests: XCTestCase {
    /// UI tests set the key through `XCUIApplication.launchEnvironment` and can't
    /// ask the app what it is called.
    func testTheOverrideKeyIsTheOneTheTestsSet() {
        XCTAssertEqual(WorkspaceLocation.workspaceOverrideKey, "PIKOS_WORKSPACE_DIRECTORY")
    }

    /// Pinned so that changing it, which strands existing users' notes, is deliberate.
    func testTheAppGroupIdentifierIsPinned() {
        XCTAssertEqual(WorkspaceLocation.appGroupIdentifier, "group.app.pikos")
    }

    func testTheDatabaseIsNamedConsistently() {
        XCTAssertEqual(WorkspaceLocation.databaseName, "pikos.sqlite")
    }

    #if DEBUG
        func testTheOverrideRedirectsAndCreatesTheDirectory() throws {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("pikos-location-tests", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            defer { try? FileManager.default.removeItem(at: directory) }

            XCTAssertFalse(
                FileManager.default.fileExists(atPath: directory.path),
                "precondition: nothing there yet")

            setenv(WorkspaceLocation.workspaceOverrideKey, directory.path, 1)
            defer { unsetenv(WorkspaceLocation.workspaceOverrideKey) }

            let url = try WorkspaceLocation.databaseURL()
            XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL,
                           directory.standardizedFileURL)
            XCTAssertEqual(url.lastPathComponent, WorkspaceLocation.databaseName)
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: directory.path),
                "the directory is created, so a caller need not")
        }

        /// An unset shell variable interpolated into a script yields "", and
        /// treating it as a path would put the database at the filesystem root.
        func testAnEmptyOverrideIsIgnored() {
            setenv(WorkspaceLocation.workspaceOverrideKey, "", 1)
            defer { unsetenv(WorkspaceLocation.workspaceOverrideKey) }

            // Falls through to the App Group, which throws here; the point is that it
            // did not answer with "/pikos.sqlite".
            let url = try? WorkspaceLocation.databaseURL()
            XCTAssertNotEqual(url?.path, "/\(WorkspaceLocation.databaseName)")
        }
    #endif
}
