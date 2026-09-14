import PikosCore
import SwiftUI

/// The page list — the app's home screen.
///
/// Native by construction, which is the whole point of the architecture: the
/// scrolling, swipe actions, selection and search field here are UIKit's, not a
/// webview's approximation of them.
///
/// The view being shown is the title, and the title is the switcher: tapping
/// "Today" drops a menu of every view and folder. That is the platform's own
/// idiom for "this screen can be one of several things" (Files, Mail, Notes),
/// and it replaces a filter-shaped icon in the corner that named nothing and
/// hid Settings behind it.
struct PageListScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route

    @State private var isFolderManagerPresented = false
    @State private var isTrashPresented = false
    @State private var isSettingsPresented = false
    @State private var searchText = ""
    @State private var actions = PageActionState()
    @State private var isCompletedExpanded = false
    @State private var isMovingOverdue = false

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
        .toolbarTitleMenu { viewMenu }
        .toolbar { toolbar }
        // Filters the current view by title. Deliberately narrower than
        // the Search tab, which is full-text across every page — this is
        // "find it in what I'm looking at", which is a different question
        // and the one a list wants answered.
        .searchable(text: $searchText, prompt: "Filter \(store.scope.title)")
        .sheet(isPresented: $isFolderManagerPresented) {
            FolderManagerSheet()
        }
        .sheet(isPresented: $isTrashPresented) {
            TrashSheet()
        }
        .sheet(isPresented: $isSettingsPresented) {
            SettingsScreen()
        }
        .pageActionSheets($actions)
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
                        if section.id == "overdue" {
                            overdueHeader(title)
                        } else {
                            Text(title)
                        }
                    }
                }
            }

            completedSection
        }
        .listStyle(.plain)
        // Rows slide rather than jump when a tick moves one to Completed or a
        // refresh reorders a day. Keyed on the sections so a filter keystroke
        // — which changes only what is *visible* — does not animate too.
        .animation(.default, value: store.sections)
        .refreshable { await store.refresh() }
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
        let done = page.status == "done"
        // The checkbox sits beside the link rather than inside it: a Button
        // inside a NavigationLink's label does not reliably get the tap,
        // because the link swallows it, and the symptom is a checkbox that
        // navigates instead of completing.
        return HStack(spacing: 0) {
            CompletionToggle(isDone: done, priority: PagePriority(stored: page.priority)) { done in
                Task { await store.setStatus(pageId: page.id, done: done) }
            }
            NavigationLink(value: page.id) {
                PageRow(page: page, showsFolder: store.scope.isDateGrouped)
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await store.trash(pageId: page.id, title: page.title) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            if !page.scheduleLocked && !page.isRecurring {
                Button {
                    actions.sheet = .schedule(PageFacts(page))
                } label: {
                    Label(page.scheduledStart == nil ? "Schedule" : "Move", systemImage: "calendar")
                }
                .tint(.indigo)
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                Task { await store.setStatus(pageId: page.id, done: !done) }
            } label: {
                Label(
                    done ? "Reopen" : "Complete",
                    systemImage: done ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(done ? .orange : .green)
        }
        .contextMenu { PageActionsMenu(page: PageFacts(page), state: $actions) }
    }

    // MARK: - Clearing the backlog

    /// The Overdue heading, with the one thing worth doing to the whole section.
    ///
    /// On the heading rather than in the toolbar because it acts on *this*
    /// section and nothing else, and a toolbar button would be as available in
    /// Upcoming, where it means nothing.
    ///
    /// No confirmation. The move is reversible, cheap and visible, and the
    /// three of those together are what a confirmation exists to compensate
    /// for — so the way back is offered afterwards instead, in the notice the
    /// store posts, where it costs nothing when it is not wanted.
    private func overdueHeader(_ title: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            if isMovingOverdue {
                ProgressView()
            } else {
                Button("Move to today") {
                    Task {
                        isMovingOverdue = true
                        defer { isMovingOverdue = false }
                        await store.moveOverdueToToday()
                    }
                }
                .font(.caption.weight(.semibold))
                .textCase(nil)
            }
        }
    }

    // MARK: - Finished work

    /// Finished work, below the open list and folded away.
    ///
    /// Collapsed by default and loaded only when opened: a folder accumulates
    /// completed pages without limit, and a section that fetches them on every
    /// appearance would make the screen slower every week for rows nobody asked
    /// to see. It stays in the same `List` rather than becoming its own screen
    /// so that unticking something puts it straight back where it came from,
    /// visibly.
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
    /// loaded, so it does not read as 20 for a folder holding hundreds — and it
    /// is shown whether or not the section has been opened, because `refresh()`
    /// fetches the count either way. Gating it on having expanded the section
    /// hid a number the app already had, which made a closed section look empty
    /// when it was not.
    private var completedTitle: String {
        store.completedTotal > 0
            ? String(localized: "Completed (\(store.completedTotal))") : String(localized: "Completed")
    }

    // MARK: - Filtering

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

    // MARK: - Empty state

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Nothing here yet", systemImage: emptyIcon)
        } description: {
            Text(emptyDescription)
        } actions: {
            Button("New page") { route.isQuickAddPresented = true }
                .buttonStyle(.borderedProminent)
        }
    }

    private var emptyIcon: String {
        switch store.scope {
        case .today: return "sun.max"
        case .upcoming: return "calendar"
        case .inbox: return "tray"
        case .folder: return "folder"
        }
    }

    private var emptyDescription: String {
        switch store.scope {
        case .today: return String(localized: "Pages scheduled for today will appear here.")
        case .upcoming: return String(localized: "Pages scheduled in the next week will appear here.")
        case .inbox: return String(localized: "Pages you haven't filed will appear here.")
        case .folder(_, let name): return String(localized: "Nothing in \(name) yet.")
        }
    }

    // MARK: - Switching views

    /// Every view the list can be, under the title.
    ///
    /// The three smart views first, then the user's folders in tree order — a
    /// parent followed by its children — then the calendars, which are folders
    /// too but not ones the user made. Below a divider, the two things that
    /// change what exists rather than what is shown: managing folders and the
    /// trash. Kept apart because a destructive action should not sit adjacent
    /// to a navigational one in the same list.
    @ViewBuilder
    private var viewMenu: some View {
        Picker("View", selection: scopeBinding) {
            Label("Today", systemImage: "sun.max").tag(WorkspaceStore.Scope.today)
            Label("Upcoming", systemImage: "calendar").tag(WorkspaceStore.Scope.upcoming)
            Label("Inbox", systemImage: "tray").tag(WorkspaceStore.Scope.inbox)
        }
        .pickerStyle(.inline)

        if !ownFolders.isEmpty {
            Picker("Folders", selection: scopeBinding) {
                ForEach(ownFolders, id: \.id) { folder in
                    Label(folder.name, systemImage: folder.parentId == nil ? "folder" : "arrow.turn.down.right")
                        .tag(WorkspaceStore.Scope.folder(id: folder.id, name: folder.name))
                }
            }
            .pickerStyle(.inline)
        }

        if !calendarFolders.isEmpty {
            Picker("Calendars", selection: scopeBinding) {
                ForEach(calendarFolders, id: \.id) { folder in
                    Label(folder.name, systemImage: "calendar")
                        .tag(WorkspaceStore.Scope.folder(id: folder.id, name: folder.name))
                }
            }
            .pickerStyle(.inline)
        }

        Divider()

        Button {
            isFolderManagerPresented = true
        } label: {
            Label("Manage Folders…", systemImage: "folder.badge.gearshape")
        }
        // The way back from the swipe action further up. It lives here rather
        // than as a scope in the picker because the trash is not a view of the
        // workspace — nothing in it can be opened, filed or completed, only
        // restored.
        Button {
            isTrashPresented = true
        } label: {
            Label("Recently Deleted…", systemImage: "trash")
        }
    }

    /// The user's folders, a parent immediately followed by its children.
    ///
    /// Anything whose parent is missing or unreachable still has to appear, or
    /// a folder becomes invisible without being deleted.
    private var ownFolders: [Folder] {
        let own = store.folders.filter { !$0.isExternalCalendar }
        var ordered: [Folder] = []
        func append(childrenOf parent: String?) {
            for folder in own where folder.parentId == parent {
                ordered.append(folder)
                append(childrenOf: folder.id)
            }
        }
        append(childrenOf: nil)
        for folder in own where !ordered.contains(where: { $0.id == folder.id }) {
            ordered.append(folder)
        }
        return ordered
    }

    private var calendarFolders: [Folder] {
        store.folders.filter(\.isExternalCalendar)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button {
                isSettingsPresented = true
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                route.isQuickAddPresented = true
            } label: {
                Label("New page", systemImage: "square.and.pencil")
            }
        }
    }

    private var scopeBinding: Binding<WorkspaceStore.Scope> {
        Binding(get: { store.scope }, set: { store.scope = $0 })
    }
}
