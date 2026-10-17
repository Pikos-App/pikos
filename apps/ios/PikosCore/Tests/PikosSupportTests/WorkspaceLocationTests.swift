import XCTest

@testable import PikosSupport

/// Where the workspace lives, and the one seam that can move it.
///
/// `databaseURL()` normally reaches the App Group container, which a host test
/// has no entitlement for — so what is testable here is the override path and
/// the properties that hold regardless of which branch answered.
final class WorkspaceLocationTests: XCTestCase {
    /// The key is part of the contract between the app and its UI tests, which
    /// set it through `XCUIApplication.launchEnvironment` and cannot ask the
    /// app what it is called. A rename here is a rename there.
    func testTheOverrideKeyIsTheOneTheTestsSet() {
        XCTAssertEqual(WorkspaceLocation.workspaceOverrideKey, "PIKOS_WORKSPACE_DIRECTORY")
    }

    /// The App Group identifier has to match every target's entitlements, and
    /// changing it after release strands every existing user's notes in a
    /// container nothing opens. Pinned so that is a deliberate edit.
    func testTheAppGroupIdentifierIsPinned() {
        XCTAssertEqual(WorkspaceLocation.appGroupIdentifier, "group.app.pikos")
    }

    /// The filename is what the `-wal` and `-shm` sidecars hang off, and what
    /// `applyProtectionClass` walks. A change here has to be matched there.
    func testTheDatabaseIsNamedConsistently() {
        XCTAssertEqual(WorkspaceLocation.databaseName, "pikos.sqlite")
    }

    #if DEBUG
        /// The override answers, creates the directory it was given, and puts
        /// the database inside it.
        ///
        /// Creating rather than assuming is what makes a UI test's `setUp`
        /// simple: hand over a path under the temporary directory and the app
        /// deals with the rest.
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

        /// An empty value is not an override.
        ///
        /// A launch environment that sets the key to "" is easy to produce by
        /// accident — an unset shell variable interpolated into a script — and
        /// treating it as a path would put the database at the filesystem root.
        func testAnEmptyOverrideIsIgnored() {
            setenv(WorkspaceLocation.workspaceOverrideKey, "", 1)
            defer { unsetenv(WorkspaceLocation.workspaceOverrideKey) }

            // Falls through to the App Group, which a host test has no
            // entitlement for — so the assertion is that it did *not* quietly
            // answer with "/pikos.sqlite".
            let url = try? WorkspaceLocation.databaseURL()
            XCTAssertNotEqual(url?.path, "/\(WorkspaceLocation.databaseName)")
        }
    #endif
}
