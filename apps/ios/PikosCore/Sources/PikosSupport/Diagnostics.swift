import Foundation

/// Shows in debug Settings the state nobody can observe from the UI: which
/// data-protection class the database and its sidecars got, and which App Group
/// container the widget will read.
///
/// Debug-only: `attributesOfItem(atPath:)` is an App Store required-reason API,
/// and a release binary that never calls it needs no declaration.
#if DEBUG
    public enum Diagnostics {
        public struct Row: Identifiable {
            public let label: String
            public let value: String
            public var id: String { label }
        }

        /// Where the workspace is, and how each of its files is protected.
        public static func report() -> [Row] {
            var rows: [Row] = []
            let manager = FileManager.default

            let database: URL
            do {
                database = try WorkspaceLocation.databaseURL()
            } catch {
                return [Row(label: "Workspace", value: "unreachable: \(error.localizedDescription)")]
            }
            rows.append(Row(label: "Container", value: database.deletingLastPathComponent().path))
            rows.append(
                Row(
                    label: "Override in effect",
                    value: ProcessInfo.processInfo.environment[WorkspaceLocation.workspaceOverrideKey]
                        .map { _ in "yes (UI test seam)" } ?? "no"))

            for suffix in ["", "-wal", "-shm"] {
                let path = database.path + suffix
                let name = database.lastPathComponent + suffix
                guard let attributes = try? manager.attributesOfItem(atPath: path) else {
                    rows.append(Row(label: name, value: "absent"))
                    continue
                }
                let size = (attributes[.size] as? NSNumber).map { Self.bytes($0.int64Value) } ?? "?"
                let protection =
                    (attributes[.protectionKey] as? FileProtectionType).map(Self.describe)
                    ?? "no class reported"
                rows.append(Row(label: name, value: "\(size), \(protection)"))
            }
            return rows
        }

        private static func describe(_ protection: FileProtectionType) -> String {
            switch protection {
            case .completeUntilFirstUserAuthentication: return "until first unlock ✓"
            case .complete: return "complete — unreadable while locked ✗"
            case .completeUnlessOpen: return "complete unless open ✗"
            case .none: return "none ✗"
            default: return protection.rawValue
            }
        }

        private static func bytes(_ count: Int64) -> String {
            ByteCountFormatter.string(fromByteCount: count, countStyle: .file)
        }
    }
#endif
