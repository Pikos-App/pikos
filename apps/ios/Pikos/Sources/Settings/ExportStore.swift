import Foundation
import Observation
import PikosCore
import PikosSupport

/// Produces a file for the share sheet.
///
/// Its own store because its failures differ in kind from the page list's: a full disk or a
/// very large workspace, plus a file to clean up whether or not it was shared. Files live in
/// the temporary directory, which iOS empties itself when space is short.
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

    /// Bytes on disk: the database, its sidecars and the images. Nil until `refreshDataFacts()`
    /// has run, or if the container cannot be reached.
    public private(set) var workspaceSize: Int64?

    /// When the newest backup in the Files app was taken.
    public private(set) var lastBackup: Date?

    public private(set) var isBackingUp = false

    /// Cheap, so the settings screen calls it on every appearance.
    public func refreshDataFacts() {
        if let database = try? WorkspaceLocation.databaseURL() {
            workspaceSize = WorkspaceFiles.size(
                database: database, assets: try? WorkspaceLocation.assetsURL())
        }
        lastBackup = (try? Self.backupsDirectory()).flatMap { WorkspaceFiles.latestBackup(in: $0) }
    }

    /// Copies the workspace into Files: a folder per backup under `Documents/Backups`, holding a
    /// `VACUUM INTO` snapshot and the images beside it. `Documents` is the one directory Files can
    /// show, and the live database stays out of it because a SQLite file a person can copy or
    /// delete while the app has it open risks corruption. Unlike `.backup`, the copy stays.
    public func backUpToFiles() async {
        guard let workspace = workspace(), !isBackingUp else { return }
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
        guard let workspace = workspace(), isExporting == nil else { return }
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
            // `VACUUM INTO`, not bytes across the boundary: a multi-megabyte database shouldn't be a
            // Swift `String`.
            try await workspace.backupDatabase(destination: url.path)
            return url

        case .markdown:
            let directory = root.appendingPathComponent("pikos-markdown-\(stamp)", isDirectory: true)
            try await workspace.exportMarkdown(
                destination: directory.path,
                assetsDir: WorkspaceLocation.assetsURL().path,
                includeSynced: includeSynced)
            return try Self.zip(directory)
        }
    }

    /// A directory as a single `.zip`, which a share sheet can send anywhere. `.forUploading` is
    /// the only zip needing no third-party code, and its archive is a temporary file the
    /// coordinator owns, so it is moved before the block returns.
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

    /// `2026-09-13T22-04-11`, matching the desktop's export filenames. The time uses hyphens
    /// because Files displays a colon as a slash.
    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
        return formatter.string(from: Date())
    }
}
