import Foundation

/// The workspace as files on disk: how much there is, and where a copy goes.
///
/// Every function takes its locations as arguments rather than reaching for
/// `WorkspaceLocation`, so tests can use a temporary directory.
public enum WorkspaceFiles {
    /// Same name as the live database, so a backup folder is recognisably a workspace.
    public static let backupDatabaseName = "pikos.sqlite"

    public static let backupAssetsName = "assets"

    /// Bytes on disk for a workspace: the database, its SQLite sidecar files,
    /// and every image in the assets directory.
    ///
    /// The write-ahead log holds the newest edits until a checkpoint, and a size
    /// without it would be smaller than the backup.
    public static func size(database: URL, assets: URL?) -> Int64 {
        var total: Int64 = 0
        for suffix in ["", "-wal", "-shm"] {
            total += fileSize(atPath: database.path + suffix)
        }
        if let assets {
            total += directorySize(assets)
        }
        return total
    }

    /// The name of a backup taken at `date`: `Pikos 2026-09-14 22-04`.
    ///
    /// Readable and sortable in the Files app, unlike the share-sheet exports'
    /// stamp, which matches the desktop's filenames. Hyphens in the time because
    /// Files draws a colon as a slash. Local time, since the user browses it on this device.
    public static func backupName(at date: Date = Date(), calendar: Calendar = .current) -> String {
        let gregorian = DayLabel.gregorian(like: calendar)
        let parts = gregorian.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "Pikos %04d-%02d-%02d %02d-%02d",
            parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0)
    }

    /// When the newest backup under `directory` was taken, or nil for none.
    ///
    /// Read from creation dates, not names: a renamed backup is still a backup.
    public static func latestBackup(in directory: URL) -> Date? {
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.creationDateKey, .isDirectoryKey],
                options: [.skipsHiddenFiles])
        else { return nil }
        return
            entries
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .compactMap { try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate }
            .max()
    }

    /// Whether a directory has anything in it worth copying.
    public static func hasContents(_ directory: URL) -> Bool {
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        else { return false }
        return !entries.isEmpty
    }

    private static func fileSize(atPath path: String) -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
            return 0
        }
        return (attributes[.size] as? NSNumber)?.int64Value ?? 0
    }

    private static func directorySize(_ directory: URL) -> Int64 {
        guard
            let walker = FileManager.default.enumerator(
                at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
                options: [.skipsHiddenFiles])
        else { return 0 }
        var total: Int64 = 0
        for case let file as URL in walker {
            guard let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                values.isRegularFile == true
            else { continue }
            total += Int64(values.fileSize ?? 0)
        }
        return total
    }
}
