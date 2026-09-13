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
    @State private var searchText = ""

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
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refresh() }
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
