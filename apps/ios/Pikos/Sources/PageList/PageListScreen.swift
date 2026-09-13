import PikosCore
import SwiftUI

/// The page list — the app's home screen.
///
/// Native by construction, which is the whole point of the architecture: the
/// scrolling, swipe actions, selection and search field here are UIKit's, not a
/// webview's approximation of them.
struct PageListScreen: View {
    @Environment(WorkspaceStore.self) private var store

    @State private var isQuickAddPresented = false
    @State private var isFolderManagerPresented = false
    @State private var isTrashPresented = false
    @State private var searchText = ""
    @State private var renaming: PageSummary?
    @State private var renameText = ""

    /// The list only — no `NavigationStack` of its own.
    ///
    /// The container owns navigation, which is what lets the same screen sit in
    /// a tab's stack on a phone and in a split view's content column on iPad
    /// without being rewritten. It is also what makes a `pikos://page/<id>`
    /// link work at all: a screen that declares its own stack gives nothing
    /// outside it a way to push.
    var body: some View {
        Group {
            if store.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.pages.isEmpty {
                emptyState
            } else if visiblePages.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else {
                list
            }
        }
        .navigationTitle(store.scope.title)
        .toolbar { toolbar }
        // Filters the current view by title. Deliberately narrower than
        // the Search tab, which is full-text across every page — this is
        // "find it in what I'm looking at", which is a different question
        // and the one a list wants answered.
        .searchable(text: $searchText, prompt: "Filter \(store.scope.title)")
        .sheet(isPresented: $isQuickAddPresented) {
            QuickAddSheet()
        }
        .sheet(isPresented: $isFolderManagerPresented) {
            FolderManagerSheet()
        }
        .sheet(isPresented: $isTrashPresented) {
            TrashSheet()
        }
        .alert(
            "Something went wrong",
            isPresented: .init(
                get: { store.errorMessage != nil },
                set: { if !$0 { store.errorMessage = nil } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(store.errorMessage ?? "") }
        )
    }

    // MARK: - Pieces

    private var list: some View {
        List {
            ForEach(visiblePages, id: \.id) { page in
                // The checkbox sits beside the link rather than inside it: a
                // Button inside a NavigationLink's label does not reliably get
                // the tap, because the link swallows it, and the symptom is a
                // checkbox that navigates instead of completing.
                HStack(spacing: 0) {
                    CompletionToggle(isDone: page.status == "done") { done in
                        Task { await store.setStatus(pageId: page.id, done: done) }
                    }
                    NavigationLink(value: page.id) {
                        PageRow(page: page)
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await store.trash(pageId: page.id) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .swipeActions(edge: .leading) {
                    let done = page.status == "done"
                    Button {
                        Task { await store.setStatus(pageId: page.id, done: !done) }
                    } label: {
                        Label(
                            done ? "Reopen" : "Complete",
                            systemImage: done ? "arrow.uturn.backward" : "checkmark")
                    }
                    .tint(done ? .orange : .green)
                }
                .contextMenu { menu(for: page) }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refresh() }
        // An alert rather than an inline edit, for the same reason as the
        // folder manager's: a row that becomes editable on tap competes with
        // the tap that opens the page, and a phone has no hover to disambiguate.
        //
        // On the list rather than on `body`, which already carries the error
        // alert. Two `.alert` modifiers on one view are not reliably two
        // alerts — the last one applied can win — and this is the view the
        // context menu that raises it belongs to anyway.
        .alert("Rename page", isPresented: isRenaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") { commitRename() }
        }
    }

    /// The long press menu — desktop's right-click menu, minus what a phone
    /// cannot do.
    ///
    /// Everything above Delete is withheld from a page a calendar owns. The
    /// title, dates and placement of a mirror belong upstream and the workspace
    /// refuses all three, so an entry here would only ever produce an error
    /// alert. Delete stays: a mirror can be removed locally, and that path
    /// already knows to keep the tombstone.
    @ViewBuilder
    private func menu(for page: PageSummary) -> some View {
        if !page.scheduleLocked {
            Button {
                renameText = page.title
                renaming = page
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            // Nested rather than a sheet: a move is one decision from a short
            // list, and a sheet for it would be two taps and a dismissal for
            // something the menu is already showing.
            Menu {
                Button { move(page, to: nil) } label: {
                    filedLabel("Inbox", current: page.folderId == nil)
                }
                ForEach(store.fileableFolders, id: \.id) { folder in
                    Button { move(page, to: folder.id) } label: {
                        filedLabel(folder.name, current: page.folderId == folder.id)
                    }
                }
            } label: {
                Label("Move to Folder", systemImage: "folder")
            }

            // Not offered on a repeating page, where it would do nothing
            // visible: a page with a rule owns its `scheduled_start` directly,
            // so clearing the one-off rows underneath leaves the date on
            // screen exactly where it was. Ending a series is a different
            // action and wants its own affordance, not this one silently
            // failing to be it. `pikos-ffi`'s
            // `clearing_a_repeating_page_s_date_leaves_the_head_where_it_is`
            // pins the behaviour this is avoiding.
            if page.scheduledStart != nil && !page.isRecurring {
                Button {
                    Task { await store.clearDate(pageId: page.id) }
                } label: {
                    Label("Clear Date", systemImage: "calendar.badge.minus")
                }
            }
        }

        Button(role: .destructive) {
            Task { await store.trash(pageId: page.id) }
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    /// A tick beside where the page already is.
    ///
    /// Desktop bolds that row; a menu on iOS shows state with a checkmark, and
    /// `Label` is what puts one in the leading position the system uses.
    private func filedLabel(_ name: String, current: Bool) -> some View {
        Label(name, systemImage: current ? "checkmark" : "folder")
    }

    private func move(_ page: PageSummary, to folderId: String?) {
        guard page.folderId != folderId else { return }
        Task { await store.movePage(id: page.id, toFolder: folderId) }
    }

    /// Bound to the presence of a page rather than a separate flag, so the two
    /// cannot disagree about whether the alert is up.
    private var isRenaming: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private func commitRename() {
        guard let page = renaming else { return }
        renaming = nil
        Task { await store.renamePage(id: page.id, to: renameText) }
    }

    /// The current view, narrowed by the filter field.
    ///
    /// Case- and diacritic-insensitive so "cafe" finds "Café" — `localizedStandardContains`
    /// is the same comparison Finder and Mail use, which is what someone typing
    /// into a filter field expects.
    private var visiblePages: [PageSummary] {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return store.pages }
        return store.pages.filter { page in
            page.title.localizedStandardContains(needle)
                || (page.subtitle?.localizedStandardContains(needle) ?? false)
                || page.tags.contains { $0.localizedStandardContains(needle) }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Nothing here yet", systemImage: "doc.text")
        } description: {
            Text(emptyDescription)
        } actions: {
            Button("New page") { isQuickAddPresented = true }
        }
    }

    private var emptyDescription: String {
        switch store.scope {
        case .today: return "Pages scheduled for today will appear here."
        case .inbox: return "Pages you haven't filed will appear here."
        case .folder(_, let name): return "Nothing in \(name) yet."
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Picker("View", selection: scopeBinding) {
                    Label("Today", systemImage: "sun.max").tag(WorkspaceStore.Scope.today)
                    Label("Inbox", systemImage: "tray").tag(WorkspaceStore.Scope.inbox)
                    ForEach(store.folders, id: \.id) { folder in
                        Text(folder.name)
                            .tag(WorkspaceStore.Scope.folder(id: folder.id, name: folder.name))
                    }
                }
                // Below the picker and behind a divider: showing a folder and
                // changing which folders exist are different intentions, and a
                // destructive action should not sit adjacent to a navigational
                // one in the same list.
                Divider()
                Button {
                    isFolderManagerPresented = true
                } label: {
                    Label("Manage folders…", systemImage: "folder.badge.gearshape")
                }
                // The way back from the swipe action two dozen lines up. It
                // lives here rather than behind a scope in the picker because
                // the trash is not a view of the workspace — nothing in it can
                // be opened, filed or completed, only restored.
                Button {
                    isTrashPresented = true
                } label: {
                    Label("Recently Deleted…", systemImage: "trash")
                }
            } label: {
                Label("Switch view", systemImage: "line.3.horizontal.decrease.circle")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                isQuickAddPresented = true
            } label: {
                Label("New page", systemImage: "square.and.pencil")
            }
        }
    }

    private var scopeBinding: Binding<WorkspaceStore.Scope> {
        Binding(get: { store.scope }, set: { store.scope = $0 })
    }
}
