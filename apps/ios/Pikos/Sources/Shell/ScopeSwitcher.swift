import PikosCore
import PikosSupport
import SwiftUI

/// Every place the list can be, dropped from its title: the desktop's sidebar, folded into the
/// switcher the desktop already shows when its window is too narrow for one.
///
/// It also carries what the corner buttons used to hide — the trash and Settings — so the top of
/// the screen is a name and two tools, and nothing else.
struct ScopeSwitcher: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route

    @State private var counts = WorkspaceStore.ViewCounts()
    @State private var isNamingFolder = false
    @State private var newFolderName = ""
    @FocusState private var isNameFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                row(.today, title: "Today", systemImage: "sun.max", count: counts.today)
                row(.upcoming, title: "Upcoming", systemImage: "calendar", count: counts.upcoming)
                row(.inbox, title: "Inbox", systemImage: "tray", count: counts.inbox)

                sectionLabel("Folders") {
                    Button {
                        route.isSwitcherPresented = false
                        route.isFolderManagerPresented = true
                    } label: {
                        Text("Edit").touchTarget(horizontal: 12)
                    }
                    .font(.pkUISm)
                    .foregroundStyle(.textAction)
                }
                // Named at the top of the folders, where the keyboard never covers it.
                if isNamingFolder {
                    rowLabel {
                        Image(systemName: "folder.badge.plus")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.textAction)
                    } title: {
                        TextField("Folder name", text: $newFolderName)
                            .focused($isNameFocused)
                            .submitLabel(.done)
                            .onSubmit(createFolder)
                    } trailing: {
                        Button("Add", action: createFolder)
                            .font(.pkUI)
                            .foregroundStyle(.textAction)
                            .disabled(newFolderName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                ForEach(ownFolders, id: \.id) { folder in
                    folderRow(folder)
                }
                if !isNamingFolder {
                    Button {
                        newFolderName = ""
                        isNamingFolder = true
                        isNameFocused = true
                    } label: {
                        rowLabel {
                            Image(systemName: "plus")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(.textTertiary)
                        } title: {
                            Text("New folder").foregroundStyle(.textSecondary)
                        } trailing: {
                            EmptyView()
                        }
                    }
                    .buttonStyle(SwitcherRowStyle(isActive: false))
                }

                if !calendarFolders.isEmpty {
                    sectionLabel("Calendars") { EmptyView() }
                    ForEach(calendarFolders, id: \.id) { folder in
                        folderRow(folder)
                    }
                }
            }
            .padding(6)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .background(.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(.borderSecondary, lineWidth: 1))
        .shadow(color: .black.opacity(0.14), radius: 24, y: 10)
        .task { counts = await store.viewCounts() }
        .accessibilityAddTraits(.isModal)
    }

    /// Named in the row it was asked for, then opened: a new folder is almost always wanted next.
    private func createFolder() {
        let name = newFolderName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        Task {
            guard let folder = await store.createFolder(named: name) else { return }
            isNamingFolder = false
            store.scope = .folder(id: folder.id, name: folder.name)
            route.isSwitcherPresented = false
        }
    }

    private var footer: some View {
        HStack(spacing: 0) {
            footerButton("Trash", systemImage: "trash") {
                route.isSwitcherPresented = false
                route.isTrashPresented = true
            }
            Rectangle().fill(.borderSecondary).frame(width: 1, height: 20)
            footerButton("Settings", systemImage: "gearshape") {
                route.isSwitcherPresented = false
                route.isSettingsPresented = true
            }
        }
        .frame(height: 48)
        .background(.surfaceElevated)
        .overlay(alignment: .top) { Rectangle().fill(.borderSecondary).frame(height: 1) }
    }

    private func footerButton(_ title: LocalizedStringKey, systemImage: String, action: @escaping () -> Void)
        -> some View
    {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.pkUI)
                .foregroundStyle(.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableRowStyle())
    }

    // MARK: - Rows

    private func row(
        _ scope: WorkspaceStore.Scope, title: LocalizedStringKey, systemImage: String, count: Int
    ) -> some View {
        let isActive = store.scope == scope
        return Button {
            choose(scope)
        } label: {
            rowLabel {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(isActive ? Color.textAction : Color.textTertiary)
            } title: {
                Text(title)
            } trailing: {
                countLabel(count)
            }
        }
        .buttonStyle(SwitcherRowStyle(isActive: isActive))
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private func folderRow(_ folder: Folder) -> some View {
        let scope = WorkspaceStore.Scope.folder(id: folder.id, name: folder.name)
        let isActive = store.scope == scope
        return Button {
            choose(scope)
        } label: {
            rowLabel {
                Circle()
                    .fill(Color(hex: folder.color) ?? Color.textDisabled)
                    .frame(width: 8, height: 8)
            } title: {
                Text(folder.name.isEmpty ? String(localized: "Untitled") : folder.name)
            } trailing: {
                countLabel(counts.folders[folder.id] ?? 0)
            }
        }
        .buttonStyle(SwitcherRowStyle(isActive: isActive))
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private func rowLabel<Icon: View, Title: View, Trailing: View>(
        @ViewBuilder icon: () -> Icon, @ViewBuilder title: () -> Title,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 12) {
            icon().frame(width: 20)
            title()
                .font(.pkBody)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func countLabel(_ count: Int) -> some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(.pkUISm)
                .monospacedDigit()
                .foregroundStyle(.textTertiary)
        }
    }

    private func sectionLabel<Trailing: View>(_ title: LocalizedStringKey, @ViewBuilder trailing: () -> Trailing)
        -> some View
    {
        HStack {
            Text(title).sectionLabelStyle()
            Spacer()
            trailing()
        }
        .padding(.horizontal, 12)
        .padding(.top, 14)
        .padding(.bottom, 4)
    }

    private func choose(_ scope: WorkspaceStore.Scope) {
        store.scope = scope
        route.isSwitcherPresented = false
    }

    // MARK: - Folders

    private var ownFolders: [Folder] {
        store.folders.filter { !$0.isExternalCalendar }
    }

    private var calendarFolders: [Folder] {
        store.folders.filter(\.isExternalCalendar)
    }
}

private struct SwitcherRowStyle: ButtonStyle {
    let isActive: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.textPrimary)
            .fontWeight(isActive ? .medium : .regular)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(
                        isActive
                            ? Color.surfaceNavSelected
                            : (configuration.isPressed ? Color.surfaceHover : Color.clear))
            )
    }
}
