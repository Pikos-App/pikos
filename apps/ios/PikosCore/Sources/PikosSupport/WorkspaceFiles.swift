import Foundation

/// The workspace as files on disk: how much there is, and where a copy goes.
///
/// "Your data is a file" is the product's promise, and on a phone it is the
/// one part of the promise a person cannot check for themselves — the
/// container is hidden from them. This is what lets the settings screen say
/// how big the file is and put a copy where the Files app can show it.
///
/// Every function takes its locations as arguments rather than reaching for
/// `WorkspaceLocation`, so the arithmetic can be tested against a temporary
/// directory. The app passes the real ones.
public enum WorkspaceFiles {
    /// The filename a backup's database is written under. The same name as
    /// the live one, so a backup folder is recognisably a workspace and not a
    /// loose file somebody has to guess the purpose of.
    public static let backupDatabaseName = "pikos.sqlite"

    /// The folder inside a backup that holds the page images.
    public static let backupAssetsName = "assets"

    /// Bytes on disk for a workspace: the database, the sidecar files SQLite
    /// keeps beside it, and every image in the assets directory.
    ///
    /// The sidecars are counted because they *are* the workspace — the
    /// write-ahead log holds the most recent edits until the next checkpoint,
    /// and a size that left it out would be smaller than the file a backup
    /// produces, which reads as the backup having grown something.
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
    /// A name a person can read in the Files app and sort by, rather than the
    /// `T`-and-hyphens stamp the share-sheet exports use to match the
    /// desktop's filenames: those are handed to another app, and this one is
    /// browsed. Hyphens in the time because Files draws a colon as a slash.
    /// Local time, because it is a folder the user looks at on this device.
    public static func backupName(at date: Date = Date(), calendar: Calendar = .current) -> String {
        let gregorian = DayLabel.gregorian(like: calendar)
        let parts = gregorian.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "Pikos %04d-%02d-%02d %02d-%02d",
            parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0)
    }

    /// When the newest backup under `directory` was taken, or nil for none.
    ///
    /// Read from the folders' creation dates rather than parsed from their
    /// names: a person can rename a backup in Files, and a renamed one is
    /// still a backup.
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

    // MARK: - Sizes

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
