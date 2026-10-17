import PikosCore
import PikosSupport
import SwiftUI

/// Search over titles, page bodies, and the things a page *is*, shaped like the
/// desktop's palette.
///
/// Two kinds of query, and the workspace decides which this is. Plain words go
/// to SQLite's FTS5, maintained by the same data layer the desktop app uses,
/// including for pages typed on this phone. A query carrying an operator
/// (`tag:`, `folder:`, `is:`, `priority:`, `due:`) becomes a structured query
/// instead, with any remaining words still going to the index. Nothing here
/// parses any of that: the grammar is one function in Rust, shared with the
/// desktop, so that "is:open" cannot come to mean two things.
///
/// On a phone the operators are chips rather than syntax. Tapping a folder, a tag
/// or "Due this week" puts a token in the field that stands for the operator, and
/// the query sent is the tokens' operators followed by the typed words. Someone who
/// types `tag:home` still gets it read; nobody has to learn that they can.
struct SearchScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route

    @State private var query = ""
    @State private var tokens: [SearchToken] = []
    @State private var results: SearchResults?
    @State private var showCompleted = false
    @State private var recents: [PageSummary] = []
    @State private var hasLoadedRecents = false
    @State private var knownTags: [String] = []
    @State private var isSearchActive = false
    @State private var hasActivated = false

    private var fullQuery: String {
        (tokens.map(\.query) + [query.trimmingCharacters(in: .whitespaces)])
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// No `NavigationStack` of its own — see the note on `PageListScreen`.
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if fullQuery.isEmpty {
                    // All at once: recents landing under chips already drawn pushed them down while the keyboard rose.
                    if hasLoadedRecents { suggestedPages }
                } else {
                    matches
                }
            }
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.immediately)
        .background(.surfacePrimary)
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.surfacePrimary, for: .navigationBar)
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    route.closeSearch()
                } label: {
                    Image(systemName: "chevron.backward")
                }
                .accessibilityLabel("Back")
            }
        }
        .searchable(
            text: $query, tokens: $tokens, isPresented: $isSearchActive, placement: Self.fieldPlacement,
            prompt: "Search pages"
        ) { token in
            Label(token.label, systemImage: token.systemImage)
        }
        .keepsNavigationBarWhileSearching()
        // The field's own close button leaves search, rather than leaving a screen with nothing to do.
        // A turn later, because a path change made during the field's own dismissal is dropped.
        .onChange(of: isSearchActive) { wasActive, isActive in
            if wasActive && !isActive { Task { route.closeSearch() } }
        }
        .noticeOverlay()
        .onAppear {
            // The keyboard is up the first time search opens, as the desktop palette takes focus;
            // coming back from a page opened here leaves it down over the results.
            if !hasActivated {
                hasActivated = true
                isSearchActive = true
            }
            guard !route.searchPrefill.isEmpty else { return }
            query = route.searchPrefill
            route.searchPrefill = ""
        }
        .task {
            recents = await store.recentPages()
            hasLoadedRecents = true
            knownTags = await store.allTags()
        }
        .task(id: SearchRequest(query: fullQuery, includeCompleted: showCompleted, version: store.dataVersion)) {
            guard !fullQuery.isEmpty else {
                results = nil
                return
            }
            // Debounced by cancellation: each keystroke cancels the previous run.
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            let found = await store.search(fullQuery, includeCompleted: showCompleted)
            guard !Task.isCancelled else { return }
            results = found
        }
    }

    /// At the bottom on iOS 26, in thumb reach, where Mail and Notes put it; in the navigation bar before.
    private static var fieldPlacement: SearchFieldPlacement {
        if #available(iOS 26.0, *) { return .toolbar }
        return .navigationBarDrawer(displayMode: .always)
    }

    /// Keyed on the data version too, so ticking a result re-reads the list it is in.
    private struct SearchRequest: Equatable {
        let query: String
        let includeCompleted: Bool
        let version: Int
    }

    // MARK: - Before typing

    @ViewBuilder
    private var suggestedPages: some View {
        if !recents.isEmpty {
            sectionLabel("Recent")
            ForEach(recents, id: \.id) { page in
                ResultRow(
                    pageId: page.id, title: page.title, status: page.status, priority: page.priority,
                    scheduledStart: page.scheduledStart, scheduledEnd: page.scheduledEnd,
                    titleTerms: [], detail: nil)
            }
        } else {
            sectionLabel("Recent")
            Text("No recent pages")
                .font(.pkBodySm)
                .foregroundStyle(.textTertiary)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
        }

        sectionLabel("Narrow to")
        FlowLayout {
            ForEach(narrowingTokens) { token in
                Button {
                    tokens.append(token)
                } label: {
                    Pill(title: token.label, systemImage: token.dot == nil ? token.systemImage : nil, dot: token.dot)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
    }

    /// Every token worth a tap: the states, the reader's folders in their colours, and their tags.
    private var narrowingTokens: [SearchToken] {
        SearchToken.fixed
            + store.fileableFolders.map { SearchToken.folder($0) }
            + knownTags.prefix(12).map { SearchToken.tag($0) }
    }

    private func sectionLabel(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .sectionLabelStyle()
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Results

    @ViewBuilder
    private var matches: some View {
        suggestions

        if let results {
            ForEach(results.hits, id: \.pageId) { hit in
                ResultRow(
                    pageId: hit.pageId, title: hit.title, status: hit.status, priority: hit.priority,
                    scheduledStart: hit.scheduledStart, scheduledEnd: nil,
                    titleTerms: hit.highlightsTitle ? results.terms : [],
                    detail: hit.detail(terms: results.terms))
            }

            if results.hits.isEmpty && results.completedCount == 0 && fullQuery.count >= 2 {
                Text("No pages found")
                    .font(.pkBodySm)
                    .foregroundStyle(.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 48)
            }

            completedToggle(results)
        }
    }

    /// The desktop's quiet line under the results. A search that asked for finished pages already
    /// has them, so it says so instead of offering to hide them.
    @ViewBuilder
    private func completedToggle(_ results: SearchResults) -> some View {
        if results.askedForCompleted {
            Text("Showing completed pages")
                .font(.pkBodySm)
                .foregroundStyle(.textTertiary)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
        } else if showCompleted || results.completedCount > 0 {
            Button {
                showCompleted.toggle()
            } label: {
                Label(
                    showCompleted ? "Hide completed" : "Show completed (\(results.completedCount))",
                    systemImage: showCompleted ? "chevron.up" : "chevron.down")
                    .font(.pkUI)
                    .foregroundStyle(.textAction)
                    .padding(.horizontal, 20)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableRowStyle())
        }
    }

    // MARK: - Completions

    /// Tokens for the word being typed, from the reader's own folders and tags and the fixed states.
    ///
    /// A word that starts an operator's name ("fol") or its value ("hom") offers the matching
    /// tokens, so somebody who never learns the syntax still narrows by typing a name.
    ///
    /// Drawn as the same pills as "Narrow to" above the results, not through `searchSuggestions`:
    /// the system's suggestion list covers the results on a black ground the theme cannot reach.
    @ViewBuilder
    private var suggestions: some View {
        let words = query.split(separator: " ").map(String.init)
        if let last = words.last, !last.isEmpty {
            let matching = completions(for: last)
            if !matching.isEmpty {
                sectionLabel("Narrow to")
                FlowLayout {
                    ForEach(matching) { token in
                        Button {
                            tokens.append(token)
                            query = words.dropLast().joined(separator: " ")
                        } label: {
                            Pill(
                                title: token.label, systemImage: token.dot == nil ? token.systemImage : nil,
                                dot: token.dot)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 8)
            }
        }
    }

    private func completions(for word: String) -> [SearchToken] {
        let lower = word.lowercased()
        let value = lower.split(separator: ":", maxSplits: 1).last.map(String.init) ?? lower
        let operatorName = lower.contains(":") ? String(lower.split(separator: ":").first ?? "") : nil
        return narrowingTokens.filter { token in
            guard !tokens.contains(token) else { return false }
            if let operatorName {
                return token.operatorName == operatorName
                    && (value.isEmpty || token.label.lowercased().contains(value))
            }
            return token.label.lowercased().contains(lower) || token.operatorName.hasPrefix(lower)
        }
        .prefix(12)
        .map { $0 }
    }
}

// MARK: - Tokens

/// One operator as a chip: what the field shows, and what the workspace is sent.
struct SearchToken: Identifiable, Hashable {
    let operatorName: String
    let value: String
    let label: String
    let systemImage: String
    var dot: Color?

    var id: String { query }

    /// A value with a space is sent by its first word, which is what the grammar reads up to.
    var query: String {
        "\(operatorName):\(value.split(separator: " ").first.map(String.init) ?? value)"
    }

    static let fixed: [SearchToken] = [
        SearchToken(operatorName: "is", value: "open", label: String(localized: "Open"), systemImage: "circle"),
        SearchToken(operatorName: "is", value: "done", label: String(localized: "Done"), systemImage: "checkmark.circle"),
        SearchToken(operatorName: "is", value: "scheduled", label: String(localized: "Scheduled"), systemImage: "calendar"),
        SearchToken(operatorName: "due", value: "today", label: String(localized: "Due today"), systemImage: "sun.max"),
        SearchToken(operatorName: "due", value: "week", label: String(localized: "Due this week"), systemImage: "calendar.badge.clock"),
        SearchToken(operatorName: "priority", value: "urgent", label: String(localized: "Urgent"), systemImage: "flag"),
        SearchToken(operatorName: "priority", value: "high", label: String(localized: "High priority"), systemImage: "flag"),
    ]

    static func folder(_ folder: Folder) -> SearchToken {
        SearchToken(
            operatorName: "folder", value: folder.name, label: folder.name, systemImage: "folder",
            dot: Color(hex: folder.color) ?? .textDisabled)
    }

    static func tag(_ tag: String) -> SearchToken {
        SearchToken(operatorName: "tag", value: tag, label: "#\(tag)", systemImage: "number")
    }
}

// MARK: - Row

/// One page in the results or the recents: the list's row, with its checkbox and date, at search's
/// size, so a page found can be ticked where it was found.
private struct ResultRow: View {
    @Environment(Route.self) private var route
    @Environment(WorkspaceStore.self) private var store

    let pageId: String
    let title: String
    let status: String
    let priority: Int64
    let scheduledStart: String?
    let scheduledEnd: String?
    let titleTerms: [String]
    let detail: SearchHit.Detail?

    private var isDone: Bool { status == "done" }
    private var displayTitle: String { title.isEmpty ? String(localized: "Untitled") : title }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            CompletionToggle(isDone: isDone, priority: PagePriority(stored: priority)) { done in
                Task { await store.setStatus(pageId: pageId, done: done) }
            }
            Button {
                route.open(page: pageId)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(highlighted(displayTitle, terms: titleTerms, font: .pkBodyMedium))
                            .font(.pkBody)
                            .foregroundStyle(isDone ? Color.textTertiary : Color.textPrimary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let scheduledStart {
                            ScheduleLabel(iso: scheduledStart, end: scheduledEnd, isDone: isDone)
                        }
                    }
                    if let detail {
                        Text(highlighted(detail.text, terms: detail.terms, font: .system(.subheadline, weight: .medium)))
                            .font(.pkBodySm)
                            .foregroundStyle(.textTertiary)
                            .lineLimit(1)
                    }
                }
                .padding(.trailing, 20)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableRowStyle())
            .accessibilityLabel(displayTitle)
            .accessibilityValue(
                [detail?.text, isDone ? String(localized: "Completed") : nil]
                    .compactMap { $0 }
                    .joined(separator: ", "))
        }
        .padding(.leading, 8)
    }

    private func highlighted(_ text: String, terms: [String], font: Font) -> AttributedString {
        SearchHighlight.attributed(text, terms: terms) {
            $0.foregroundColor = .textAction
            $0.font = font
        }
    }
}

// MARK: - What a hit shows

extension SearchHit {
    struct Detail {
        let text: String
        /// Empty when the line is the page's facts rather than matched text.
        let terms: [String]
    }

    var highlightsTitle: Bool { matchSource == "title" || matchSource == "both" }

    /// The second line, chosen as the desktop chooses it: the subtitle when that
    /// is what matched, the passage when the body did, and otherwise the page's
    /// own facts so a title match still says which page it is.
    func detail(terms: [String]) -> Detail? {
        if matchSource == "subtitle", let subtitle, !subtitle.isEmpty {
            return Detail(text: SearchHighlight.leadIn(subtitle, terms: terms), terms: terms)
        }
        if matchSource == "content" || matchSource == "both", !excerpt.isEmpty {
            return Detail(text: SearchHighlight.leadIn(excerpt, terms: terms), terms: terms)
        }
        let summary = facts
        return summary.isEmpty ? nil : Detail(text: summary, terms: [])
    }

    private var facts: String {
        // No date: the row already prints it at the trailing edge.
        var parts: [String] = []
        if let priority = PagePriority(rawValue: priority) {
            parts.append(priority.name)
        }
        if !tags.isEmpty {
            parts.append(tags.map { "#\($0)" }.joined(separator: " "))
        }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if let subtitle, !subtitle.isEmpty { return subtitle }
        return contentPreview
    }
}

// MARK: - Presentation

private extension View {
    /// The bar hiding as the field activates slid the results up just after search opened.
    @ViewBuilder
    func keepsNavigationBarWhileSearching() -> some View {
        if #available(iOS 17.1, *) {
            searchPresentationToolbarBehavior(.avoidHidingContent)
        } else {
            self
        }
    }
}
