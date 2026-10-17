import PikosCore
import PikosSupport
import SwiftUI

/// Create, rename, recolour and delete folders.
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
    /// Names being typed, by folder id, until the field lets go.
    @State private var names: [String: String] = [:]
    @FocusState private var focusedFolder: String?
    @FocusState private var newFieldFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                Group {
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
                                .foregroundStyle(.textSecondary)
                        }
                    } else {
                        if !ownFolders.isEmpty {
                            Section {
                                ForEach(ownFolders, id: \.id) { folder in
                                    row(folder)
                                }
                                .onMove { from, to in
                                    var ids = ownFolders.map(\.id)
                                    ids.move(fromOffsets: from, toOffset: to)
                                    Task { await store.reorderFolders(ids) }
                                }
                            } header: {
                                Text("Folders").sectionLabelStyle()
                            }
                        }
                        ForEach(calendarGroups) { group in
                            Section {
                                ForEach(group.folders, id: \.id) { folder in
                                    row(folder)
                                }
                            } header: {
                                Text(group.title).sectionLabelStyle()
                            }
                        }
                    }
                }
                .pikosFormRows()
            }
            // Always arranging: this sheet is where folders are changed, and a handle per row costs
            // less than an Edit button in front of every move.
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Folders")
            .pikosFormStyle()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await sync.load() }
    }

    // MARK: - Rows

    private func row(_ folder: Folder) -> some View {
        HStack(spacing: 10) {
            swatch(folder)
            if folder.isExternalCalendar {
                Text(folder.name)
                Spacer()
                Image(systemName: "calendar")
                    .font(.caption)
                    .foregroundStyle(.textSecondary)
                    .accessibilityLabel("Managed by a calendar")
            } else {
                // The name is its own field, as Reminders edits a list's name: renaming is typing
                // where the name already is, with no alert in between.
                TextField(
                    "Name",
                    text: Binding(
                        get: { names[folder.id] ?? folder.name },
                        set: { names[folder.id] = $0 })
                )
                .focused($focusedFolder, equals: folder.id)
                .submitLabel(.done)
                .onSubmit { Task { await commitRename(folder) } }
                .accessibilityLabel(accessibleLabel(folder))
                // A hold on the name selects its text, so the folder's menu also has a button.
                Menu {
                    menu(for: folder)
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(.textTertiary)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More for \(folder.name)")
            }
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
                .tint(.statusOverdue)
            }
        }
        .onChange(of: focusedFolder) { old, _ in
            guard old == folder.id else { return }
            Task { await commitRename(folder) }
        }
    }

    /// The colour dot, which is also the colour control.
    ///
    /// A menu on the dot rather than a row in a detail screen: recolouring is a
    /// glance-and-tap, and burying it a level down would make the one thing a
    /// person does to a folder list the slowest thing in it.
    private func swatch(_ folder: Folder) -> some View {
        Menu {
            // A palette of real swatches, each still named for VoiceOver and for anyone who
            // cannot tell two of them apart.
            Picker(
                "Colour",
                selection: Binding(
                    get: { folder.color ?? "" },
                    set: { value in Task { await store.setFolderColor(id: folder.id, to: value) } })
            ) {
                ForEach(store.paletteColors, id: \.value) { option in
                    Label(option.label, systemImage: "circle.fill")
                        .tint(Color(hex: option.value) ?? .textDisabled)
                        .tag(option.value)
                }
            }
            .pickerStyle(.palette)
            if folder.color != nil {
                Divider()
                Button("No colour") {
                    Task { await store.setFolderColor(id: folder.id, to: nil) }
                }
            }
        } label: {
            Circle()
                .fill(Color(hex: folder.color) ?? Color.textTertiary.opacity(0.25))
                .frame(width: 14, height: 14)
                .overlay(
                    Circle().strokeBorder(Color.textTertiary.opacity(0.35), lineWidth: folder.color == nil ? 1 : 0)
                )
        }
        .accessibilityLabel("Colour of \(folder.name)")
    }

    @ViewBuilder
    private func menu(for folder: Folder) -> some View {
        if !folder.isExternalCalendar {
            Button {
                focusedFolder = folder.id
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            Divider()

            Button(role: .destructive) {
                Task { await store.trashFolder(id: folder.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    // MARK: - Grouping

    private var ownFolders: [Folder] {
        store.folders.filter { !$0.isExternalCalendar }
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

    private func accessibleLabel(_ folder: Folder) -> String {
        var parts = [folder.name]
        if let colour = store.paletteColors.first(where: { $0.value == folder.color }) {
            parts.append(colour.label)
        }
        if folder.isExternalCalendar { parts.append("managed by a calendar") }
        return parts.joined(separator: ", ")
    }

    // MARK: - Writes

    private var trimmedNewName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func create() async {
        guard !trimmedNewName.isEmpty else { return }
        await store.createFolder(named: trimmedNewName)
        newName = ""
        newFieldFocused = true
    }

    /// An emptied name goes back to what it was rather than saving a folder called nothing.
    private func commitRename(_ folder: Folder) async {
        guard let typed = names[folder.id] else { return }
        names[folder.id] = nil
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != folder.name else { return }
        await store.renameFolder(id: folder.id, to: trimmed)
    }
}
