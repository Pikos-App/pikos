import PikosCore
import PikosSupport
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
///
/// What the screen adds is memory and completion. The field offers the last
/// few searches back, because on a phone retyping is the expensive part; and
/// as an operator is typed it completes from what exists — the folders the
/// reader has, the tags on their pages — rather than from a legend they have
/// to have read. The legend stays on the empty state for the first visit.
struct SearchScreen: View {
    @Environment(WorkspaceStore.self) private var store

    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var isSearching = false
    /// Incremented on each keystroke so a slow query for an old term cannot
    /// overwrite the results of a newer one.
    @State private var generation = 0
    @State private var recents: [String] = Preferences.shared.recentSearches
    @State private var knownTags: [String] = []

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
        .searchField(text: $query, prompt: "Titles, text, tag:, folder:, due:")
        .searchSuggestions { suggestions }
        // A search is remembered when it is *run* — the return key, or a
        // suggestion tapped — never per keystroke, or the recents would fill
        // with the first three letters of everything.
        .onSubmit(of: .search) { remember(query) }
        .noticeOverlay()
        .task { knownTags = await store.allTags() }
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

    // MARK: - Suggestions

    /// What the field offers under itself.
    ///
    /// Empty field: the recent searches, then the operators as a reminder.
    /// A field with something in it: completions for its last word, drawn
    /// from the reader's own folders and tags. Tapping any of them runs the
    /// completed query, which is what `searchCompletion` does.
    @ViewBuilder
    private var suggestions: some View {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            if !recents.isEmpty {
                Section {
                    ForEach(recents, id: \.self) { recent in
                        Label(recent, systemImage: "clock.arrow.circlepath")
                            .searchCompletion(recent)
                    }
                    Button("Clear recent searches", role: .destructive) {
                        var preferences = Preferences.shared
                        preferences.clearRecentSearches()
                        recents = []
                    }
                    .font(.footnote)
                } header: {
                    Text("Recent")
                }
            }
        } else {
            let completions = completions(for: trimmed)
            if !completions.isEmpty {
                Section {
                    ForEach(completions, id: \.query) { completion in
                        Label(completion.label, systemImage: completion.systemImage)
                            .searchCompletion(completion.query)
                    }
                }
            }
        }
    }

    private struct Completion {
        let label: String
        let systemImage: String
        /// The whole query with the last word completed.
        let query: String
    }

    /// Completions for the word being typed.
    ///
    /// Only the last word is completed; everything before it is kept, so
    /// "budget fol" becomes "budget folder:Admin" rather than losing the
    /// word. An operator prefix — "tag:", "folder:", "is:" — matches by the
    /// operator, and a value already started narrows the list. A bare word
    /// that is the start of an operator's name ("fol") offers that operator's
    /// values too, which is how somebody who has forgotten the syntax gets
    /// it back without the legend.
    private func completions(for text: String) -> [Completion] {
        let words = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard let last = words.last, !last.isEmpty else { return [] }
        let head = words.dropLast().joined(separator: " ")
        func full(_ token: String) -> String { head.isEmpty ? token : "\(head) \(token)" }

        let lower = last.lowercased()
        var out: [Completion] = []

        func offer(_ operatorName: String, values: [String], systemImage: String) {
            let prefix = operatorName + ":"
            let typedValue: String?
            if lower.hasPrefix(prefix) {
                typedValue = String(last.dropFirst(prefix.count))
            } else if prefix.hasPrefix(lower) {
                typedValue = ""
            } else {
                return
            }
            guard let typedValue else { return }
            for value in values
            where typedValue.isEmpty
                || value.range(of: typedValue, options: [.caseInsensitive, .diacriticInsensitive])
                    != nil
            {
                // A value with a space needs quoting the grammar does not
                // have; the desktop offers the same folders unquoted and the
                // parser reads up to the next space, so a multi-word folder
                // is offered by its first word, which is what the parser
                // will match on.
                let firstWord = value.split(separator: " ").first.map(String.init) ?? value
                let token = prefix + firstWord
                out.append(Completion(label: prefix + value, systemImage: systemImage, query: full(token)))
            }
        }

        offer("tag", values: knownTags, systemImage: "number")
        offer(
            "folder", values: store.fileableFolders.map(\.name), systemImage: "folder")
        offer("is", values: ["open", "done", "scheduled"], systemImage: "checkmark.circle")
        offer("priority", values: ["urgent", "high", "medium", "low"], systemImage: "flag")
        offer("due", values: ["today", "tomorrow", "week", "month"], systemImage: "calendar")
        return Array(out.prefix(12))
    }

    private func remember(_ text: String) {
        var preferences = Preferences.shared
        preferences.remember(search: text)
        recents = preferences.recentSearches
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
