import PikosCore
import SwiftUI

/// Create, rename and delete folders.
///
/// Its own sheet rather than actions buried in the view switcher, because those
/// are two different jobs: the switcher answers "show me that", and this
/// answers "change what exists". Mixing them puts a destructive action one
/// mis-tap from a navigational one.
///
/// Folders a calendar owns appear but cannot be changed. Hiding them would be
/// worse — the user can see them in the switcher, and a manager that silently
/// omits some of what they see reads as a bug. Shown, marked, and inert.
struct FolderManagerSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var newName = ""
    @State private var renaming: Folder?
    @State private var renameText = ""
    @FocusState private var newFieldFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New folder", text: $newName)
                            .focused($newFieldFocused)
                            .submitLabel(.done)
                            .onSubmit { Task { await create() } }
                        Button("Add") { Task { await create() } }
                            .disabled(trimmedNewName.isEmpty)
                    }
                }

                if store.folders.isEmpty {
                    Section {
                        Text("No folders yet. Pages without one live in the Inbox.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("Folders") {
                        ForEach(store.folders, id: \.id) { folder in
                            row(folder)
                        }
                    }
                }
            }
            .navigationTitle("Folders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // The rename field is an alert rather than an inline edit: a list
            // row that becomes editable on tap competes with the tap that
            // selects it, and on a phone there is no hover to disambiguate.
            .alert("Rename folder", isPresented: isRenaming) {
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Rename") { Task { await commitRename() } }
            }
        }
    }

    private func row(_ folder: Folder) -> some View {
        HStack {
            Text(folder.name)
            if folder.isExternalCalendar {
                Spacer()
                Image(systemName: "calendar")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Managed by a calendar")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !folder.isExternalCalendar else { return }
            renameText = folder.name
            renaming = folder
        }
        .swipeActions(edge: .trailing) {
            // No swipe action at all on a calendar's folder, rather than one
            // that fails: the workspace refuses the delete, and an action whose
            // only outcome is an error message should not be offered.
            if !folder.isExternalCalendar {
                Button(role: .destructive) {
                    Task { await store.trashFolder(id: folder.id) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .accessibilityHint(folder.isExternalCalendar ? "" : "Double tap to rename")
    }

    private var trimmedNewName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Bound to the presence of a folder rather than a separate flag, so the two
    /// cannot disagree about whether the alert is up.
    private var isRenaming: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private func create() async {
        guard !trimmedNewName.isEmpty else { return }
        await store.createFolder(named: trimmedNewName)
        newName = ""
        newFieldFocused = true
    }

    private func commitRename() async {
        guard let folder = renaming else { return }
        renaming = nil
        await store.renameFolder(id: folder.id, to: renameText)
    }
}
