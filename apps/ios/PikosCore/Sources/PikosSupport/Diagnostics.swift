import Foundation

/// What the first device run needs to see without an instrument attached.
///
/// Two of the checks the status doc lists as "needs a Mac" are about state
/// nobody can observe from the UI: which data-protection class the database
/// and its sidecars actually got, and whether the App Group container the
/// widget will read is the one the app wrote. Both are one attribute read
/// away, and reading them on a debug build costs nothing — so the Settings
/// screen shows them there, and the check becomes "look at a row" rather
/// than "attach a debugger with the phone locked".
///
/// Debug-only, deliberately. `attributesOfItem(atPath:)` is on the App
/// Store's list of APIs that need a declared reason, and a release binary
/// that never calls it needs no declaration.
#if DEBUG
    public enum Diagnostics {
        /// One line of the report: a label and its value.
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

        /// The class in the words the status doc uses, so the row can be
        /// compared against it by eye.
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
