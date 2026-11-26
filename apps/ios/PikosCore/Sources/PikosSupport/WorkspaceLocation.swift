import Foundation

/// Where the workspace database lives on disk.
///
/// Widgets and the share extension are separate processes with their own
/// containers, so the shared App Group container is the only place all three
/// can reach. Each target's Info.plist names the identifier from the same build
/// setting its entitlements use, so the staging build never reaches the real group.
public enum WorkspaceLocation {
    /// Must match the App Group in every target's entitlements.
    ///
    /// Changing the release value after release strands every existing user's
    /// notes in a container nothing opens any more, so treat it as permanent.
    public static let appGroupIdentifier =
        Bundle.main.object(forInfoDictionaryKey: "PikosAppGroup") as? String ?? "group.app.pikos"

    static let databaseName = "pikos.sqlite"

    public enum Failure: LocalizedError {
        case appGroupUnavailable(identifier: String)

        public var errorDescription: String? {
            switch self {
            case .appGroupUnavailable(let identifier):
                return """
                    The app group \(identifier) is not available. Check that every \
                    target has the App Groups capability enabled with this identifier.
                    """
            }
        }
    }

    /// Environment variable a debug build reads instead of the App Group.
    ///
    /// Lets a UI test hand the app a throwaway workspace: `XCUIApplication` can
    /// set the launched process's environment but cannot reach inside it. It
    /// also keeps CI from depending on a simulator honouring the App Group entitlement.
    public static let workspaceOverrideKey = "PIKOS_WORKSPACE_DIRECTORY"

    /// The database's URL.
    ///
    /// Throws when the App Group is unreachable instead of using the private container.
    public static func databaseURL() throws -> URL {
        #if DEBUG
            if let override = ProcessInfo.processInfo.environment[workspaceOverrideKey],
                !override.isEmpty
            {
                // `~/` is the app's own home: on a phone the app can't reach the test runner's
                // folders, so a test run on a device names a place inside the app's container.
                let path =
                    override.hasPrefix("~/")
                    ? NSHomeDirectory() + "/" + override.dropFirst(2) : override
                let directory = URL(fileURLWithPath: path, isDirectory: true)
                try FileManager.default.createDirectory(
                    at: directory, withIntermediateDirectories: true)
                return directory.appendingPathComponent(databaseName)
            }
        #endif

        guard
            let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroupIdentifier)
        else {
            throw Failure.appGroupUnavailable(identifier: appGroupIdentifier)
        }
        return container.appendingPathComponent(databaseName)
    }

    /// Make the workspace readable while the device is locked, after the first
    /// unlock since boot.
    ///
    /// The default protection class makes a file unreadable whenever the device
    /// is locked, surfacing as open and write failures that don't name the cause,
    /// and a Today widget refreshes on the lock screen. This class keeps the file
    /// encrypted until first unlock without vanishing on every screen lock. The
    /// `-wal` and `-shm` files get the same class, or it would look like corruption.
    ///
    /// Called on every open, since those sidecar files come and go.
    public static func applyProtectionClass() throws {
        let database = try databaseURL()
        for suffix in ["", "-wal", "-shm"] {
            let path = database.path + suffix
            guard FileManager.default.fileExists(atPath: path) else { continue }
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: path)
        }
    }

    /// Move the database and its sidecars out of the way, into the app's Documents where the Files
    /// app shows them, and return the folder they went to.
    ///
    /// Moved rather than deleted: a workspace no build can open still holds what was written
    /// in it, and the write-ahead log can hold the newest of that.
    public static func setAside(now: Date = Date()) throws -> URL {
        let database = try databaseURL()
        let documents = try FileManager.default.url(
            for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = documents.appendingPathComponent("Set aside", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = now.formatted(.iso8601.year().month().day().dateSeparator(.dash).time(includingFractionalSeconds: false).timeSeparator(.omitted))
        for suffix in ["", "-wal", "-shm"] {
            let source = URL(fileURLWithPath: database.path + suffix)
            guard FileManager.default.fileExists(atPath: source.path) else { continue }
            try FileManager.default.moveItem(
                at: source, to: folder.appendingPathComponent("pikos-\(stamp).sqlite\(suffix)"))
        }
        return folder
    }

    /// Directory holding page images, beside the database in the same container.
    ///
    /// Created on demand: the editor's scheme handler refuses to serve anything
    /// outside it, so a missing directory would make every image fail to load.
    public static func assetsURL() throws -> URL {
        let container = try databaseURL().deletingLastPathComponent()
        let assets = container.appendingPathComponent("assets", isDirectory: true)
        if !FileManager.default.fileExists(atPath: assets.path) {
            try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        }
        return assets
    }
}
