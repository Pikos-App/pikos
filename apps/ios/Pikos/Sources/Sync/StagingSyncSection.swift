#if STAGING
    import SwiftUI

    /// What the staging build's sync is doing, and a way to make it check now.
    struct StagingSyncSection: View {
        @Environment(DeviceSync.self) private var deviceSync

        var body: some View {
            Section {
                Text(deviceSync.status)
                Text(deviceSync.zone)
                    .font(.footnote)
                    .textSelection(.enabled)
                Text(deviceSync.counts)
                    .font(.footnote)
                Text(deviceSync.lastError)
                    .font(.footnote)
                    .textSelection(.enabled)
                NavigationLink("Sync log") { StagingSyncLog() }
                Button("Refetch everything on next launch") {
                    UserDefaults.standard.set(true, forKey: DeviceSync.refetchKey)
                }
                Button("Sync now") {
                    Task {
                        await deviceSync.localChangesHappened()
                        await deviceSync.fetchNow()
                    }
                }
            } header: {
                Text("iCloud sync (staging)").sectionLabelStyle()
            }
        }
    }
#endif
