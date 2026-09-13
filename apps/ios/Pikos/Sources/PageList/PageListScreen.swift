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
    @State private var isSettingsPresented = false
    @State private var searchText = ""
    @State private var renaming: PageSummary?
    @State private var scheduling: Scheduling?
    @State private var tagging: Tagging?

    /// A wrapper rather than a conformance on the generated `PageSummary`.
    ///
    /// `sheet(item:)` wants `Identifiable` and the summary is a UniFFI record
    /// this repo does not own — the same reason `CalendarSyncScreen` wraps an
    /// account. A retroactive conformance is a name the next regeneration could
    /// collide with, and `@retroactive` is Swift 6 syntax on a package still on
    /// tools 5.9.
    private struct Scheduling: Identifiable {
        let page: PageSummary
        var id: String { page.id }
    }

    /// The same wrapper, for the same reason.
    private struct Tagging: Identifiable {
        let page: PageSummary
        var id: String { page.id }
    }
    @State private var renameText = ""
    @State private var isCompletedExpanded = false

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
            } else if store.pages.isEmpty && store.completedTotal == 0 {
                // Genuinely nothing — not merely nothing *open*. A view whose
                // pages have all been finished still has a Completed section to
                // reach, and replacing the whole list with "nothing here yet"
                // would put that work out of reach of the screen it belongs to.
                // The count comes back with every refresh for exactly this.
                emptyState
            } else if visibleSections.isEmpty && !searchText.isEmpty {
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
        .sheet(isPresented: $isSettingsPresented) {
            SettingsScreen()
        }
        .sheet(item: $scheduling) { target in
            SchedulePageSheet(page: target.page)
        }
        .sheet(item: $tagging) { target in
            TagsSheet(page: target.page)
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
            // Reached when everything in the view has been finished. Said
            // plainly rather than left as a bare gap above the Completed
            // section, which reads as a loading failure.
            if visibleSections.isEmpty {
                Text("Nothing open here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(visibleSections) { section in
                // One shape for every view. A folder is a single untitled
                // section; Today is up to two; Upcoming is one per day that
                // holds something. `Section` with a nil header draws no
                // header, so the untitled case costs nothing.
                Section {
                    ForEach(section.pages, id: \.id) { page in
                        row(page)
                    }
                } header: {
                    if let title = section.title {
                        Text(title)
                    }
                }
            }

            completedSection
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

    /// One open page: the checkbox, the link, and everything reachable from a
    /// swipe or a long press.
    ///
    /// Extracted when the list became sectioned. Two call sites — the open
    /// sections here and the Completed section below — and a second copy of
    /// wiring this particular is a second place to quietly lose a swipe
    /// action. A finished page gets the same row: its checkbox reads ticked
    /// from its own status, and its leading swipe says "Reopen" for the same
    /// reason.
    private func row(_ page: PageSummary) -> some View {
        // The checkbox sits beside the link rather than inside it: a Button
        // inside a NavigationLink's label does not reliably get the tap,
        // because the link swallows it, and the symptom is a checkbox that
        // navigates instead of completing.
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

    /// Finished work, below the open list and folded away.
    ///
    /// Collapsed by default and loaded only when opened: a folder accumulates
    /// completed pages without limit, and a section that fetches them on every
    /// appearance would make the screen slower every week for rows nobody asked
    /// to see. It stays in the same `List` rather than becoming its own screen
    /// so that unticking something puts it straight back where it came from,
    /// visibly.
    @ViewBuilder
    private var completedSection: some View {
        Section {
            DisclosureGroup(isExpanded: $isCompletedExpanded) {
                if store.completedPages.isEmpty {
                    Text(
                        store.hasLoadedCompleted
                            ? "Nothing finished here yet." : "Loading…"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                } else {
                    ForEach(store.completedPages, id: \.id) { page in
                        row(page)
                    }
                    if store.hasMoreCompleted {
                        Button("Show more") {
                            Task { await store.loadMoreCompleted() }
                        }
                        .font(.callout)
                    }
                }
            } label: {
                Text(completedTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            // The load is driven by the expansion rather than by the tap, so it
            // also runs when something else expands the section.
            .onChange(of: isCompletedExpanded) { _, expanded in
                guard expanded else { return }
                Task { await store.expandCompleted() }
            }
        }
    }

    /// "Completed" until the count is known, then "Completed (12)".
    ///
    /// The number comes from the query's total rather than from the rows
    /// loaded, so it does not read as 20 for a folder holding hundreds.
    private var completedTitle: String {
        store.hasLoadedCompleted && store.completedTotal > 0
            ? "Completed (\(store.completedTotal))"
            : "Completed"
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

            // Same shape as Move to Folder, and for the same reason: one
            // decision from a short fixed list. "None" is a real choice here
            // rather than the absence of one — a page with a priority needs a
            // way back to having none.
            Menu {
                Button { setPriority(page, to: nil) } label: {
                    priorityLabel("None", current: page.priority == 0)
                }
                ForEach(Self.priorities, id: \.stored) { option in
                    Button { setPriority(page, to: option.value) } label: {
                        priorityLabel(option.name, current: page.priority == option.stored)
                    }
                }
            } label: {
                Label("Priority", systemImage: "exclamationmark.circle")
            }

            Button {
                tagging = Tagging(page: page)
            } label: {
                Label("Tags…", systemImage: "tag")
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

            // Not offered on a repeating page. Its date belongs to its rule:
            // moving it has to realign the anchor and snap onto a day the rule
            // yields, or the next recompute reverts the edit, and clearing it
            // does nothing visible at all because the head owns its own
            // `scheduled_start`. The workspace refuses both — `pikos-ffi`'s
            // `a_repeating_page_refuses_a_plain_date_change` and
            // `clearing_a_repeating_page_s_date_leaves_the_head_where_it_is`
            // pin them — so the menu declines to offer what would fail.
            if !page.isRecurring {
                Button {
                    scheduling = Scheduling(page: page)
                } label: {
                    Label(
                        page.scheduledStart == nil ? "Schedule…" : "Change Date…",
                        systemImage: "calendar")
                }

                // Kept beside the sheet rather than folded into it. Taking a
                // date off is the one schedule change that is a single tap, and
                // making it three would be a worse trade than the extra row.
                if page.scheduledStart != nil {
                    Button {
                        Task { await store.clearDate(pageId: page.id) }
                    } label: {
                        Label("Clear Date", systemImage: "calendar.badge.minus")
                    }
                }
            }
        }

        Button(role: .destructive) {
            Task { await store.trash(pageId: page.id) }
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    /// The four priorities, paired with the numbers they are stored as.
    ///
    /// Low number first — 1 urgent through 4 low — which runs the opposite way
    /// to the names. The pairing is written out here rather than derived so the
    /// menu's order and the column's meaning cannot drift apart.
    private static let priorities: [(name: String, value: Priority, stored: Int64)] = [
        ("Urgent", .urgent, 1),
        ("High", .high, 2),
        ("Medium", .medium, 3),
        ("Low", .low, 4),
    ]

    private func priorityLabel(_ name: String, current: Bool) -> some View {
        Label(name, systemImage: current ? "checkmark" : "circle")
    }

    private func setPriority(_ page: PageSummary, to priority: Priority?) {
        Task { await store.setPriority(pageId: page.id, priority: priority) }
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

    /// The current view's sections, narrowed by the filter field.
    ///
    /// Filtering inside each section rather than flattening first: a filter is
    /// a narrower view of the same list, not a different list, and collapsing
    /// Upcoming's days into one run the moment somebody types would lose the
    /// only structure it has.
    ///
    /// Case- and diacritic-insensitive so "cafe" finds "Café" —
    /// `localizedStandardContains` is the same comparison Finder and Mail use,
    /// which is what someone typing into a filter field expects.
    private var visibleSections: [WorkspaceStore.Section] {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else {
            return store.sections.filter { !$0.pages.isEmpty }
        }
        return store.sections.compactMap { section in
            let matches = section.pages.filter { page in
                page.title.localizedStandardContains(needle)
                    || (page.subtitle?.localizedStandardContains(needle) ?? false)
                    || page.tags.contains { $0.localizedStandardContains(needle) }
            }
            // A day with nothing left in it becomes a header over a gap.
            return matches.isEmpty
                ? nil
                : WorkspaceStore.Section(id: section.id, title: section.title, pages: matches)
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
        case .upcoming: return "Pages scheduled in the next week will appear here."
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
                    Label("Upcoming", systemImage: "calendar")
                        .tag(WorkspaceStore.Scope.upcoming)
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
                Divider()
                Button {
                    isSettingsPresented = true
                } label: {
                    Label("Settings…", systemImage: "gearshape")
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
