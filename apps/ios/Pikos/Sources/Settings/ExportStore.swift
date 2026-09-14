import Foundation
import Observation
import PikosCore
import PikosSupport

/// Producing a file to hand to the share sheet.
///
/// Its own store rather than more surface on `WorkspaceStore` for the same
/// reason `CalendarSyncStore` is: the failure modes differ in kind. A page list
/// fails when the database does. This fails when a disk is full or a workspace
/// is very large, and it produces something — a file on disk — that has to be
/// cleaned up afterwards whether or not anybody shared it.
///
/// Everything is written into the app's temporary directory. iOS empties that
/// itself when space is short, which is the right lifetime for a file whose only
/// job is to survive until the share sheet is done with it.
@MainActor
@Observable
public final class ExportStore {
    /// What can be produced, and what each one is for.
    public enum Format: String, CaseIterable, Identifiable {
        case markdown
        case csv
        case ics
        case backup

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .markdown: return String(localized: "Markdown")
            case .csv: return String(localized: "CSV")
            case .ics: return String(localized: "Calendar (.ics)")
            case .backup: return String(localized: "Database backup")
            }
        }

        /// Said before the tap, because the four are not interchangeable and the
        /// difference only shows up once the file is somewhere else.
        public var detail: String {
            switch self {
            case .markdown:
                return String(localized: "One file per page, in folders. Readable anywhere.")
            case .csv:
                return String(localized: "A spreadsheet of every page. Imports back into Pikos.")
            case .ics:
                return String(localized: "Your scheduled pages as calendar events.")
            case .backup:
                return String(localized: "The whole workspace as one file, trash included.")
            }
        }
    }

    public private(set) var isExporting: Format?
    public var errorMessage: String?

    /// The file waiting to be shared, if any.
    public var ready: Ready?

    public struct Ready: Identifiable {
        public let id = UUID()
        public let url: URL
        public let format: Format
    }

    private let workspace: @MainActor () -> Workspace?

    public init(workspace: @escaping @MainActor () -> Workspace?) {
        self.workspace = workspace
    }

    // MARK: - The workspace as a file

    /// Bytes on disk: the database, its sidecars and the images beside it.
    /// Nil until `refreshDataFacts()` has run, or if the container cannot be
    /// reached.
    public private(set) var workspaceSize: Int64?

    /// When the newest backup in the Files app was taken.
    public private(set) var lastBackup: Date?

    public private(set) var isBackingUp = false

    /// Re-read the size and the last backup date. Cheap — a handful of file
    /// attributes — so the settings screen calls it on every appearance and
    /// the number is never a launch old.
    public func refreshDataFacts() {
        if let database = try? WorkspaceLocation.databaseURL() {
            workspaceSize = WorkspaceFiles.size(
                database: database, assets: try? WorkspaceLocation.assetsURL())
        }
        lastBackup = (try? Self.backupsDirectory()).flatMap { WorkspaceFiles.latestBackup(in: $0) }
    }

    /// Copy the workspace into the Files app.
    ///
    /// A folder per backup under `Documents/Backups`, holding the database
    /// and the images. `Documents` is the one directory the Files app can
    /// show (`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`
    /// in the Info.plist), and the live database is deliberately *not* there:
    /// a SQLite file in a folder a person can open, copy and delete from
    /// while the app has it open is a corrupted workspace waiting to happen.
    /// So what lands in Files is always a copy, taken through `VACUUM INTO`
    /// for a consistent snapshot, and the images are copied beside it so the
    /// folder is the whole workspace and not most of it.
    ///
    /// Distinct from the `.backup` export above, which produces a file for
    /// the share sheet and cleans it up afterwards. This one stays, which is
    /// the point: it is the copy a person can see, and the answer to "where
    /// is my data" that a phone otherwise cannot give.
    public func backUpToFiles() async {
        guard let workspace, !isBackingUp else { return }
        isBackingUp = true
        defer { isBackingUp = false }

        do {
            let folder = try Self.backupsDirectory()
                .appendingPathComponent(WorkspaceFiles.backupName(), isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try await workspace.backupDatabase(
                destination: folder.appendingPathComponent(WorkspaceFiles.backupDatabaseName).path)
            let assets = try WorkspaceLocation.assetsURL()
            if WorkspaceFiles.hasContents(assets) {
                try FileManager.default.copyItem(
                    at: assets, to: folder.appendingPathComponent(WorkspaceFiles.backupAssetsName))
            }
            refreshDataFacts()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// `Documents/Backups`, created on first use.
    private static func backupsDirectory() throws -> URL {
        let documents = try FileManager.default.url(
            for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let backups = documents.appendingPathComponent("Backups", isDirectory: true)
        if !FileManager.default.fileExists(atPath: backups.path) {
            try FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
        }
        return backups
    }

    public func export(_ format: Format, includeSynced: Bool) async {
        guard let workspace, isExporting == nil else { return }
        isExporting = format
        defer { isExporting = nil }

        do {
            let url = try await write(format, from: workspace, includeSynced: includeSynced)
            ready = Ready(url: url, format: format)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func write(
        _ format: Format, from workspace: Workspace, includeSynced: Bool
    ) async throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-export", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let stamp = Self.stamp()

        switch format {
        case .csv:
            let url = root.appendingPathComponent("pikos-\(stamp).csv")
            try await workspace.exportCsv(includeSynced: includeSynced)
                .write(to: url, atomically: true, encoding: .utf8)
            return url

        case .ics:
            let url = root.appendingPathComponent("pikos-\(stamp).ics")
            try await workspace.exportIcs(includeSynced: includeSynced)
                .write(to: url, atomically: true, encoding: .utf8)
            return url

        case .backup:
            let url = root.appendingPathComponent("pikos-backup-\(stamp).sqlite")
            // The workspace writes this one itself: it is a `VACUUM INTO`, not
            // bytes handed across the boundary, because a multi-megabyte
            // database has no business being a Swift `String`.
            try await workspace.backupDatabase(destination: url.path)
            return url

        case .markdown:
            let directory = root.appendingPathComponent("pikos-markdown-\(stamp)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for file in try await workspace.exportMarkdown(includeSynced: includeSynced) {
                let destination = directory.appendingPathComponent(file.path)
                try FileManager.default.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                try file.contents.write(to: destination, atomically: true, encoding: .utf8)
            }
            return try Self.zip(directory)
        }
    }

    /// A directory as a single `.zip`.
    ///
    /// A share sheet handed a folder offers to save it and little else; zipped,
    /// it can go into Files, a message, or another app. `NSFileCoordinator`'s
    /// `.forUploading` option is what produces the archive — it is the only
    /// zip on the platform that needs no third-party code, and it writes to a
    /// temporary file the coordinator owns, which is why the result is moved
    /// somewhere this store controls before the block returns.
    private static func zip(_ directory: URL) throws -> URL {
        var coordinatorError: NSError?
        var copyError: Error?
        var result: URL?

        let destination = directory.deletingLastPathComponent()
            .appendingPathComponent(directory.lastPathComponent + ".zip")

        NSFileCoordinator().coordinate(
            readingItemAt: directory, options: [.forUploading], error: &coordinatorError
        ) { archive in
            do {
                try FileManager.default.moveItem(at: archive, to: destination)
                result = destination
            } catch {
                copyError = error
            }
        }

        if let coordinatorError { throw coordinatorError }
        if let copyError { throw copyError }
        guard let result else {
            throw CocoaError(.fileWriteUnknown)
        }
        return result
    }

    /// `2026-09-13T22-04-11`, matching the desktop's export filenames.
    ///
    /// Colons are legal in a filename on iOS and displayed as slashes by Files,
    /// which is its own kind of wrong, so the time uses hyphens — the same
    /// substitution the desktop makes.
    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
        return formatter.string(from: Date())
    }
}
