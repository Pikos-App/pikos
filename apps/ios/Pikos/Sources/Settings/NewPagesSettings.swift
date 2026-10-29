import SwiftUI

struct NewPagesSettings: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        @Bindable var settings = settings

        SettingsPage(title: "New pages") {
            Section {
                Picker("Default folder", selection: $settings.defaultFolderID) {
                    Text("Inbox").tag(String?.none)
                    ForEach(store.fileableFolders, id: \.id) { folder in
                        Text(folder.name).tag(String?.some(folder.id))
                    }
                }
            } footer: {
                Text(defaultFolderFooter)
            }
        }
    }

    /// Says out loud when the stored folder no longer exists.
    ///
    /// The id outlives the folder — deleting one does not reach into settings
    /// to clear it — so the picker falls back to showing Inbox. Without this
    /// sentence that looks like the preference silently reset itself, which is
    /// the one reading that would send somebody looking for a bug.
    private var defaultFolderFooter: String {
        let base = String(localized: "Where a new page lands when you create one from a widget or a link.")
        guard let id = settings.defaultFolderID,
            !store.fileableFolders.contains(where: { $0.id == id })
        else { return base }
        return base + " " + String(localized: "The folder this was set to no longer exists, so new pages go to the Inbox.")
    }
}
