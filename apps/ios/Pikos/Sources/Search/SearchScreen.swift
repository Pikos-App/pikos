import PikosCore
import SwiftUI

/// Full-text search over titles and page bodies.
///
/// The index is SQLite's FTS5, maintained by the same data layer the desktop
/// app uses — including for pages typed on this phone, because the editor sends
/// its extracted plain text alongside every save.
struct SearchScreen: View {
    @Environment(WorkspaceStore.self) private var store

    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var isSearching = false
    /// Incremented on each keystroke so a slow query for an old term cannot
    /// overwrite the results of a newer one.
    @State private var generation = 0

    /// No `NavigationStack` of its own — see the note on `PageListScreen`.
    var body: some View {
        Group {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView(
                    "Search", systemImage: "magnifyingglass",
                    description: Text("Find a page by its title or anything written in it."))
            } else if hits.isEmpty && !isSearching {
                ContentUnavailableView.search(text: query)
            } else {
                List(hits, id: \.pageId) { hit in
                    NavigationLink(value: hit.pageId) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.title.isEmpty ? "Untitled" : hit.title)
                                .font(.body)
                            Text(hit.excerpt)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Search")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        .task(id: query) {
            // Debounced by cancellation: `task(id:)` cancels the previous run on
            // each keystroke, so a sleep that is not interrupted means typing
            // has stopped.
            generation += 1
            let mine = generation
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }

            isSearching = true
            let results = await store.search(query)
            guard mine == generation else { return }
            hits = results
            isSearching = false
        }
    }
}
