import PikosSync
import SwiftUI

/// The sync switch, its status line, and what the status line offers to do.
struct SyncSection: View {
    @Environment(DeviceSync.self) private var deviceSync

    var body: some View {
        Section {
            Toggle("Sync with iCloud", isOn: isOn)
            Text(deviceSync.line.text)
                .font(.footnote)
                .foregroundStyle(.textSecondary)
            if let label = actionLabel {
                Button(label) {
                    Task { await deviceSync.perform(deviceSync.line.action) }
                }
            }
            #if STAGING
                StagingSyncDiagnostics()
            #endif
        } header: {
            Text("iCloud").sectionLabelStyle()
        } footer: {
            Text("Keeps your pages the same on every device signed in to your iCloud account.")
        }
    }

    private var isOn: Binding<Bool> {
        Binding(
            get: { deviceSync.isOn },
            set: { on in
                Task { on ? await deviceSync.turnOn() : await deviceSync.turnOff() }
            })
    }

    private var actionLabel: String? {
        switch deviceSync.line.action {
        case .none: nil
        case .useThisAccount: "Sync with this account"
        case .uploadAgain: "Upload this device's pages again"
        }
    }
}

#if STAGING
    /// What the staging build's sync is doing underneath, for dogfooding.
    private struct StagingSyncDiagnostics: View {
        @Environment(DeviceSync.self) private var deviceSync

        var body: some View {
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
        }
    }
#endif
