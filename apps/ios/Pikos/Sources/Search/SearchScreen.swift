import PikosCore
import SwiftUI

/// Search over titles, page bodies, and the things a page *is*.
///
/// Two kinds of query, and the workspace decides which this is. Plain words go
/// to SQLite's FTS5, maintained by the same data layer the desktop app uses —
/// including for pages typed on this phone, because the editor sends its
/// extracted plain text alongside every save. A query carrying an operator
/// (`tag:`, `folder:`, `is:`, `priority:`, `due:`) becomes a structured query
/// instead, with any remaining words still going to the index.
///
/// Nothing here parses any of that. The grammar is one function in Rust, shared
/// with the desktop and graded against it, precisely so that "is:open" cannot
/// come to mean two things.
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
                ContentUnavailableView {
                    Label("Search", systemImage: "magnifyingglass")
                } description: {
                    Text("Find a page by its title or anything written in it.")
                } actions: {
                    operatorLegend
                }
            } else if hits.isEmpty && !isSearching {
                ContentUnavailableView.search(text: query)
            } else {
                List(hits, id: \.pageId) { hit in
                    NavigationLink(value: hit.pageId) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.title.isEmpty ? "Untitled" : hit.title)
                                .font(.body)
                            // A hit found by its tags or its date has no
                            // passage to quote, and an empty line under the
                            // title reads as a page with a blank body.
                            if !hit.excerpt.isEmpty {
                                Text(hit.excerpt)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
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

    /// What can be typed here beyond words.
    ///
    /// Shown on the empty state rather than in a help screen, because an
    /// operator nobody knows about is an operator nobody uses — and the moment
    /// somebody is looking at an empty search field is the only moment they are
    /// asking what to type.
    private var operatorLegend: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Self.operators, id: \.syntax) { entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(entry.syntax)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Color.accentColor)
                    Text(entry.meaning)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 4)
    }

    private static let operators: [(syntax: String, meaning: String)] = [
        ("tag:work", "tagged work"),
        ("folder:admin", "in that folder"),
        ("is:open", "still open — also is:done, is:scheduled"),
        ("priority:urgent", "at that priority"),
        ("due:week", "due in the next seven days"),
    ]
}
