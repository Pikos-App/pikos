import PikosCore
import PikosSupport
import SwiftUI

/// Create, rename, recolour, nest and delete folders.
///
/// Its own sheet rather than actions buried in the view switcher, because those
/// are two different jobs: the switcher answers "show me that", and this
/// answers "change what exists". Mixing them puts a destructive action one
/// mis-tap from a navigational one.
///
/// Folders a calendar owns appear and are *mostly* inert. Hiding them would be
/// worse — the user can see them in the switcher, and a manager that silently
/// omits some of what they see reads as a bug. The exception is colour: the
/// name, the placement and the existence of such a folder belong to the
/// calendar, but what colour it is in this app does not.
struct FolderManagerSheet: View {
    @Environment(WorkspaceStore.self) private var store
    /// Only for the account headings. Connected calendars are that store's
    /// subject, and a second copy of the question here would be a second answer
    /// to keep in step.
    @Environment(CalendarSyncStore.self) private var sync
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
                    if !ownFolders.isEmpty {
                        Section("Folders") {
                            ForEach(ownFolders, id: \.id) { folder in
                                row(folder)
                            }
                        }
                    }
                    ForEach(calendarGroups) { group in
                        Section(group.title) {
                            ForEach(group.folders, id: \.id) { folder in
                                row(folder)
                            }
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
        .task { await sync.load() }
    }

    // MARK: - Rows

    private func row(_ folder: Folder) -> some View {
        HStack(spacing: 10) {
            swatch(folder)
            Text(folder.name)
                .padding(.leading, indent(of: folder))
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
        .contextMenu { menu(for: folder) }
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibleLabel(folder))
        .accessibilityHint(folder.isExternalCalendar ? "" : "Double tap to rename")
    }

    /// The colour dot, which is also the colour control.
    ///
    /// A menu on the dot rather than a row in a detail screen: recolouring is a
    /// glance-and-tap, and burying it a level down would make the one thing a
    /// person does to a folder list the slowest thing in it.
    private func swatch(_ folder: Folder) -> some View {
        Menu {
            ForEach(store.paletteColors, id: \.value) { option in
                Button {
                    Task { await store.setFolderColor(id: folder.id, to: option.value) }
                } label: {
                    // The name, not just the swatch. A picker that is only
                    // colour is a picker nobody using VoiceOver can operate,
                    // and one nobody colour-blind can operate confidently.
                    Label(option.label, systemImage: folder.color == option.value ? "checkmark" : "circle.fill")
                }
            }
            if folder.color != nil {
                Divider()
                Button("No colour") {
                    Task { await store.setFolderColor(id: folder.id, to: nil) }
                }
            }
        } label: {
            Circle()
                .fill(Color(hex: folder.color) ?? Color.secondary.opacity(0.25))
                .frame(width: 14, height: 14)
                .overlay(
                    Circle().strokeBorder(Color.secondary.opacity(0.35), lineWidth: folder.color == nil ? 1 : 0)
                )
        }
        .accessibilityLabel("Colour of \(folder.name)")
    }

    @ViewBuilder
    private func menu(for folder: Folder) -> some View {
        if !folder.isExternalCalendar {
            Button {
                renameText = folder.name
                renaming = folder
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            Menu {
                if folder.parentId != nil {
                    Button("Top level") {
                        Task { await store.setFolderParent(id: folder.id, to: nil) }
                    }
                }
                ForEach(possibleParents(of: folder), id: \.id) { parent in
                    Button(parent.name) {
                        Task { await store.setFolderParent(id: folder.id, to: parent.id) }
                    }
                }
            } label: {
                Label("Move into…", systemImage: "folder")
            }
        }
    }

    // MARK: - Grouping

    /// Folders the user made, in tree order — a parent immediately followed by
    /// its children.
    ///
    /// Flattened rather than drawn as nested `DisclosureGroup`s. A phone-width
    /// list of folders two deep does not need to be collapsible, and a
    /// disclosure arrow on every row competes with the tap that renames.
    private var ownFolders: [Folder] {
        let own = store.folders.filter { !$0.isExternalCalendar }
        var ordered: [Folder] = []
        func append(children of: String?) {
            for folder in own where folder.parentId == of {
                ordered.append(folder)
                append(children: folder.id)
            }
        }
        append(children: nil)
        // Anything whose parent is missing or unreachable still has to appear,
        // or a folder becomes invisible without being deleted.
        for folder in own where !ordered.contains(where: { $0.id == folder.id }) {
            ordered.append(folder)
        }
        return ordered
    }

    private func indent(of folder: Folder) -> CGFloat {
        folder.parentId == nil ? 0 : 14
    }

    /// One heading per calendar account, and no heading at all when there is
    /// only one.
    ///
    /// With a single account the heading names something the reader already
    /// knows; with two it is the only thing telling apart two calendars that
    /// are both called "Work".
    private struct CalendarGroup: Identifiable {
        let id: String
        let title: String
        let folders: [Folder]
    }

    private var calendarGroups: [CalendarGroup] {
        let external = store.folders.filter(\.isExternalCalendar)
        guard !external.isEmpty else { return [] }

        let accounts = sync.accounts
        guard accounts.count > 1 else {
            return [CalendarGroup(id: "calendars", title: "Calendars", folders: external)]
        }

        var grouped: [CalendarGroup] = []
        var claimed: Set<String> = []
        for account in accounts {
            let folderIds = Set(account.calendars.compactMap(\.folderId))
            let mine = external.filter { folderIds.contains($0.id) }
            claimed.formUnion(mine.map(\.id))
            if !mine.isEmpty {
                grouped.append(
                    CalendarGroup(
                        id: account.account.id, title: account.account.displayName, folders: mine))
            }
        }
        // A folder whose account has gone — a disconnect that left it behind —
        // still belongs on screen.
        let orphans = external.filter { !claimed.contains($0.id) }
        if !orphans.isEmpty {
            grouped.append(CalendarGroup(id: "calendars", title: "Calendars", folders: orphans))
        }
        return grouped
    }

    private func possibleParents(of folder: Folder) -> [Folder] {
        let forbidden = descendants(of: folder.id).union([folder.id])
        return store.folders.filter { !$0.isExternalCalendar && !forbidden.contains($0.id) }
    }

    /// Every folder under `id`, so the picker cannot offer a move that builds a
    /// cycle. The workspace refuses one anyway; this is what stops the choice
    /// being shown.
    private func descendants(of id: String) -> Set<String> {
        var found: Set<String> = []
        var frontier = [id]
        while let current = frontier.popLast() {
            for folder in store.folders where folder.parentId == current {
                if found.insert(folder.id).inserted { frontier.append(folder.id) }
            }
        }
        return found
    }

    private func accessibleLabel(_ folder: Folder) -> String {
        var parts = [folder.name]
        if let colour = store.paletteColors.first(where: { $0.value == folder.color }) {
            parts.append(colour.label)
        }
        if folder.parentId != nil { parts.append("nested") }
        if folder.isExternalCalendar { parts.append("managed by a calendar") }
        return parts.joined(separator: ", ")
    }

    // MARK: - Writes

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
