import Foundation

/// Where the workspace database lives on disk.
///
/// The whole App Group question reduces to this file. Widgets and the share
/// extension are separate processes with their own containers, so a database in
/// the app's own sandbox is invisible to them — the shared container is the only
/// place all three can reach.
///
/// The identifier has to match an App Group capability on every target's
/// provisioning profile, which is why it is a constant here rather than
/// something derived: the string in the entitlements file and the string in
/// this file must be the same, and one obvious place to look beats two clever
/// ones.
public enum WorkspaceLocation {
    /// Must match the App Group in every target's entitlements.
    ///
    /// Changing it after release strands every existing user's notes in a
    /// container nothing opens any more, so treat it as permanent.
    public static let appGroupIdentifier = "group.app.pikos"

    /// The database filename inside whichever container is in use.
    static let databaseName = "pikos.sqlite"

    /// Why a workspace path could not be determined.
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

    /// The shared container's database URL.
    ///
    /// Throws rather than falling back to the app's private container. A silent
    /// fallback would work perfectly in the app and leave widgets reading an
    /// empty database — the kind of failure that looks like a widget bug for
    /// weeks before anyone suspects provisioning.
    public static func databaseURL() throws -> URL {
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
    /// iOS assigns a data-protection class to every file, and the strictest one
    /// makes a file unreadable whenever the device is locked — surfacing as
    /// open and write failures rather than as anything that names the cause.
    /// That is not hypothetical here: a Today widget refreshes on the lock
    /// screen, which is exactly the moment the app is backgrounded and the
    /// device is locked.
    ///
    /// `.completeUntilFirstUserAuthentication` is the deliberate choice rather
    /// than the default one. The file stays encrypted at rest and is unreadable
    /// on a device that has not been unlocked since boot, which is the property
    /// worth having; it does not vanish every time the screen locks, which is
    /// the property that would make the widget lie. SQLite's sidecar files get
    /// the same class — protecting the database and not its write-ahead log
    /// would fail in a way that looks like corruption.
    ///
    /// Called on every open rather than at creation: the class is a property of
    /// the file, and the `-wal` and `-shm` files come and go underneath us.
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

    /// Directory holding page images, beside the database in the same container.
    ///
    /// Created on demand: the editor's scheme handler refuses to serve anything
    /// outside it, and a missing directory would make every image fail to load
    /// rather than simply be absent.
    public static func assetsURL() throws -> URL {
        let container = try databaseURL().deletingLastPathComponent()
        let assets = container.appendingPathComponent("assets", isDirectory: true)
        if !FileManager.default.fileExists(atPath: assets.path) {
            try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        }
        return assets
    }
}
