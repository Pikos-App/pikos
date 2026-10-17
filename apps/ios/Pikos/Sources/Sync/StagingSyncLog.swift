#if STAGING
    import OSLog
    import SwiftUI

    /// This launch's sync log lines, newest first, read from the app's own log since a dogfood phone
    /// has no debugger attached.
    struct StagingSyncLog: View {
        @State private var lines: [String] = []

        var body: some View {
            List(lines, id: \.self) { line in
                Text(line)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            .navigationTitle("Sync log")
            .refreshable { load() }
            .onAppear { load() }
        }

        private func load() {
            guard let store = try? OSLogStore(scope: .currentProcessIdentifier),
                let entries = try? store.getEntries()
            else { return }

            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss"
            var kept: [String] = []
            for case let entry as OSLogEntryLog in entries {
                let isSync = entry.subsystem == "app.pikos" || entry.subsystem == "com.apple.cloudkit"
                if isSync {
                    kept.append("\(formatter.string(from: entry.date)) \(entry.composedMessage)")
                }
            }

            lines = Array(kept.suffix(200).reversed())
        }
    }
#endif
