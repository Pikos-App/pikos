import Foundation
import Observation
import PikosCore
import PikosSupport

/// The app's single connection to the workspace, and the state the UI observes.
///
/// One store, one `Workspace`, one writer — the rule the data layer is built
/// around. Views read `pages` and call the methods here rather than holding a
/// `Workspace` of their own, so there is one place where a write happens and
/// one place where the list is refreshed after it.
///
/// `@MainActor` because everything it publishes drives SwiftUI. The FFI calls
/// are `async` and do their work off the main thread; only the results land
/// here.
@MainActor
@Observable
public final class WorkspaceStore {
    /// What the app is currently showing.
    /// Hashable, not merely Equatable: SwiftUI's `tag(_:)` requires it, and the
    /// view switcher is a Picker over these.
    public enum Scope: Hashable {
        case today
        case upcoming
        case inbox
        case folder(id: String, name: String)

        /// Every view lists open work only. What is finished appears below it
        /// in its own section, ordered by when it was completed rather than by
        /// where it was filed — see `completedScope`.
        var query: PageQuery {
            switch self {
            case .today, .upcoming:
                // The date views have their own listings, which arrive already
                // sectioned; this query is unused for them.
                return PageQuery()
            case .inbox:
                return PageQuery(folder: .inbox, openOnly: true)
            case .folder(let id, _):
                return PageQuery(folder: .folder(id: id), openOnly: true)
            }
        }

        /// What this view's Completed section means, which is not the same
        /// question in each. Today and Upcoming ask "what did I finish today",
        /// across every folder — they have no folder of their own, and what
        /// left their sections since this morning is the only finished work
        /// they can sensibly claim. A folder asks "what have I ever finished in
        /// here".
        var completedScope: CompletedScope {
            switch self {
            case .today, .upcoming: return .today
            case .inbox: return .inbox
            case .folder(let id, _): return .folder(id: id)
            }
        }

        /// Whether this view's order comes from the schedule rather than from
        /// how the user arranged it. A sort control has nothing to act on in
        /// one of these, which is also why they are the two that arrive in
        /// sections.
        var isDateGrouped: Bool {
            switch self {
            case .today, .upcoming: return true
            case .inbox, .folder: return false
            }
        }

        var title: String {
            switch self {
            case .today: return "Today"
            case .upcoming: return "Upcoming"
            case .inbox: return "Inbox"
            case .folder(_, let name): return name
            }
        }
    }

    /// One run of rows under one heading.
    ///
    /// Every view produces these, including the ones with no headings at all —
    /// a folder is a single untitled section. Uniform on purpose: the
    /// alternative is a screen that branches on the view to decide whether it
    /// is drawing a list or a set of lists, and the two date views would be the
    /// only ones exercising the second branch.
    public struct Section: Identifiable, Hashable {
        /// Stable across refreshes, so SwiftUI keeps scroll position and row
        /// identity when the contents change under it.
        public let id: String
        /// `nil` for a view that is one undifferentiated list.
        public let title: String?
        public let pages: [PageSummary]
    }

    public private(set) var sections: [Section] = []

    /// Every listed page, regardless of which section it is in.
    ///
    /// Derived rather than stored so it cannot fall out of step with
    /// `sections`. The filter field and the empty-state check both want the
    /// whole set and neither cares how it is grouped.
    public var pages: [PageSummary] { sections.flatMap(\.pages) }
    public private(set) var folders: [Folder] = []

    /// Set when something failed in a way the user should see. Cleared when
    /// they dismiss it.
    public var errorMessage: String?

    /// True until the first load completes, so the list can distinguish "still
    /// loading" from "genuinely empty" — an empty list shown during startup
    /// reads as data loss.
    public private(set) var isLoading = true

    /// Bumped whenever the workspace has been written to and re-read.
    ///
    /// `pages` is enough for the list, which observes it directly. The calendar
    /// asks a different question — occurrences projected onto the days on
    /// screen — and its answer is not in `pages`, so without something to
    /// observe it would keep showing what it fetched when the range last
    /// changed. Completing a task from the editor and coming back to a calendar
    /// still showing it undone is the symptom.
    public private(set) var dataVersion = 0

    public var scope: Scope = .today {
        didSet {
            guard scope != oldValue else { return }
            // The finished pages belong to the view that was showing, and the
            // new one's are a different set entirely — Today's are today's
            // across every folder. Dropped rather than re-fetched, so the
            // section starts collapsed in the new view and costs nothing until
            // somebody asks for it.
            completedPages = []
            completedTotal = 0
            hasLoadedCompleted = false
            Task { await refresh() }
        }
    }

    /// What this view has loaded of its finished pages, newest first.
    ///
    /// Empty until the section is opened. A folder accumulates completed pages
    /// without limit, so this is the one list in the app that is paginated —
    /// loading all of them would make the screen slower every week for rows
    /// nobody is looking at.
    public private(set) var completedPages: [PageSummary] = []

    /// How many finished pages this view has in total, which is usually more
    /// than `completedPages.count`. The difference is what "Show more" is for.
    public private(set) var completedTotal: UInt32 = 0

    /// Whether the section has been opened at all. Distinct from
    /// `completedPages.isEmpty`, which is also true for a view that has been
    /// opened and genuinely has nothing finished in it — a state that should
    /// say so rather than silently re-fetching on every redraw.
    public private(set) var hasLoadedCompleted = false

    private var workspace: Workspace?

    /// The open workspace, for the one caller that needs the handle rather than
    /// this store's methods.
    ///
    /// `CalendarSyncStore` talks to the same file but keeps its own state,
    /// because its failures are a different kind — a server that is down, a
    /// password that was rotated — and folding them into this store's single
    /// `errorMessage` would show "could not read or write" over all of them.
    /// Read-only: the one-writer rule still means every *write* goes through a
    /// method here or on that store, never through a handle passed around.
    public var handle: Workspace? { workspace }

    public init() {}

    /// Open the workspace and load the first screen's worth of data.
    ///
    /// Separate from `init` because it can fail and because it is async; a
    /// failing initialiser would leave the app with no store to show the error
    /// with.
    public func start() async {
        do {
            let url = try WorkspaceLocation.databaseURL()
            workspace = try await Workspace.open(path: url.path)
            // After the open, so the sidecar files SQLite creates get the class
            // too. The app is the only writer, so this is the one place it can
            // be applied without racing anyone.
            try? WorkspaceLocation.applyProtectionClass()
            await refresh()
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    public func refresh() async {
        guard let workspace else { return }
        do {
            // Sequential rather than concurrent. These are two local SQLite
            // queries measured in single-digit milliseconds; overlapping them
            // would buy nothing and put two readers on the pool for no reason.
            sections = try await load(scope)
            folders = try await workspace.listFolders()
            // An opened section re-reads its rows; a closed one re-reads only
            // its count. The count is not decoration: the screen decides
            // whether to show "nothing here yet" from it, and a view whose
            // pages are all finished is not empty — it just has nothing open.
            if hasLoadedCompleted {
                await reloadCompleted()
            } else {
                await countCompleted()
            }
            isLoading = false
            dataVersion += 1
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    /// The rows for one view, already grouped the way it is drawn.
    ///
    /// The two date views come back sectioned from the workspace rather than
    /// being sectioned here. Both rules behind the grouping are subtle enough
    /// to be worth having in one place: an all-day item stays "today" until
    /// midnight while a timed one slips the moment it passes, and an all-day
    /// item dated today sorts at *now* so it lands between what has gone and
    /// what has not. A Swift copy of either would be a second definition that
    /// drifts from the one the desktop is graded against.
    private func load(_ scope: Scope) async throws -> [Section] {
        guard let workspace else { return [] }
        switch scope {
        case .today:
            let split = try await workspace.listTodaySections()
            // A heading only when there is something under it, and none at all
            // when nothing has slipped — an empty "Overdue" is a small daily
            // accusation, and a lone "Today" over the only list on screen is a
            // label for something that needs none.
            guard !split.overdue.isEmpty else {
                return [Section(id: "today", title: nil, pages: split.today)]
            }
            return [
                Section(id: "overdue", title: "Overdue", pages: split.overdue),
                Section(id: "today", title: "Today", pages: split.today),
            ].filter { !$0.pages.isEmpty }

        case .upcoming:
            let today = DayLabel.today()
            return try await workspace.listUpcoming().map { day in
                Section(
                    id: day.date,
                    title: DayLabel.relative(day.date, today: today),
                    pages: day.pages)
            }

        case .inbox, .folder:
            return [
                Section(id: "all", title: nil, pages: try await workspace.listPages(query: scope.query))
            ]
        }
    }

    // MARK: - Completed pages

    /// How many finished pages one fetch brings back.
    private static let completedPageSize: UInt32 = 20

    /// Load the first page of finished work. Call it when the section opens.
    ///
    /// Idempotent: reopening a section that is already loaded shows what is
    /// there rather than re-querying, which is what makes expanding and
    /// collapsing free.
    public func expandCompleted() async {
        guard !hasLoadedCompleted else { return }
        hasLoadedCompleted = true
        await fetchCompleted(offset: 0, replacing: true)
    }

    /// Load the next page. The caller checks `hasMoreCompleted` first.
    public func loadMoreCompleted() async {
        guard hasMoreCompleted else { return }
        await fetchCompleted(offset: UInt32(completedPages.count), replacing: false)
    }

    public var hasMoreCompleted: Bool {
        completedPages.count < Int(completedTotal)
    }

    /// Re-read everything already on screen, in one query rather than page by
    /// page.
    ///
    /// A write can add a row to the top of this list (a page just ticked) or
    /// take one out of it (unticked, deleted), and both shift every row after
    /// it. Re-fetching from offset 0 with the count already shown is the only
    /// way to stay consistent — paging further after an insert with per-page
    /// offsets would show one row twice and skip another.
    private func reloadCompleted() async {
        let shown = max(UInt32(completedPages.count), Self.completedPageSize)
        await fetchCompleted(offset: 0, replacing: true, limit: shown)
    }

    /// How many finished pages this view has, without reading any of them.
    ///
    /// A limit of zero is the point: the query still runs its `COUNT(*)`, which
    /// is what the caller wants, and returns no rows to build summaries from.
    private func countCompleted() async {
        await fetchCompleted(offset: 0, replacing: false, limit: 0)
    }

    private func fetchCompleted(
        offset: UInt32, replacing: Bool, limit: UInt32? = nil
    ) async {
        guard let workspace else { return }
        do {
            let result = try await workspace.listCompleted(
                scope: scope.completedScope,
                limit: limit ?? Self.completedPageSize,
                offset: offset)
            completedTotal = result.total
            if replacing {
                completedPages = result.pages
            } else {
                completedPages.append(contentsOf: result.pages)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Reads

    public func page(id: String) async -> Page? {
        guard let workspace else { return nil }
        do {
            return try await workspace.getPage(id: id)
        } catch let error as WorkspaceError {
            // A page that has been deleted is routine — a stale deep link, a
            // widget tap, a restored navigation stack. Not worth an alert.
            // `NotFound`, capitalised: UniFFI spells an error case exactly as
            // the Rust variant is spelled, not in Swift's lowerCamelCase. The
            // lowercase form compiles nowhere and is easy to write from habit.
            if case .NotFound = error { return nil }
            errorMessage = error.localizedDescription
            return nil
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Everything the calendar draws for a visible range, inclusive of both
    /// ends and in `YYYY-MM-DD`.
    ///
    /// Not cached and not folded into `pages`. The calendar's question is a
    /// different one — it needs recurring occurrences projected onto the days
    /// on screen, which no page list contains — and the range changes as the
    /// user swipes, so a cache keyed on nothing in particular would be a
    /// staleness bug waiting to happen.
    public func calendarRange(from start: String, to end: String) async -> [CalendarEntry] {
        guard let workspace else { return [] }
        do {
            return try await workspace.calendarRange(start: start, end: end)
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    public func search(_ query: String, limit: UInt32 = 50) async -> [SearchHit] {
        guard let workspace, !query.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        do {
            return try await workspace.search(query: query, limit: limit)
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    // MARK: - Writes

    /// Save an edited document.
    ///
    /// Deliberately does not refresh the list: this is called on every debounced
    /// keystroke while the editor is open, and reloading the page list under the
    /// user on each one would be both wasteful and visibly janky. The list
    /// refreshes when the editor closes.
    public func saveDocument(pageId: String, json: String, plainText: String) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.updatePage(
                id: pageId, edit: PageEdit(content: json, contentText: plainText))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func createPage(_ page: NewPage) async -> Page? {
        guard let workspace else { return nil }
        do {
            let created = try await workspace.createPage(page: page)
            await refresh()
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Folders the user can file into.
    ///
    /// Excludes any a calendar owns: the workspace refuses a page filed into
    /// one, so offering it in a picker is offering a choice that cannot be
    /// taken. Better to leave it out than to explain the refusal afterwards.
    public var fileableFolders: [Folder] {
        folders.filter { !$0.isExternalCalendar }
    }

    @discardableResult
    public func createFolder(named name: String) async -> Folder? {
        guard let workspace else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        do {
            let folder = try await workspace.createFolder(name: trimmed, color: nil)
            await refresh()
            return folder
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    public func renameFolder(id: String, to name: String) async {
        guard let workspace else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            _ = try await workspace.renameFolder(id: id, name: trimmed)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Delete everything on this device.
    ///
    /// No trash, no undo, and nothing here asks — the screen offering this has
    /// asked twice by the time it is called. The workspace stays open and
    /// usable afterwards rather than needing a restart, which is why this
    /// refreshes instead of tearing anything down.
    public func deleteAllData() async {
        guard let workspace else { return }
        do {
            try await workspace.deleteAllData()
            // Back to the view that always has something to show, since the one
            // that was open may have been a folder that no longer exists.
            scope = .today
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The colours a folder can be, served by the workspace.
    ///
    /// Read once and held: it is a constant, and the only reason it crosses the
    /// boundary at all is so that this app is not a fourth place the palette is
    /// written down.
    public var paletteColors: [PaletteColor] {
        workspace?.paletteColors() ?? []
    }

    /// Set a folder's colour, or clear it with `nil`.
    ///
    /// Offered on a calendar's folder too. Its name and its placement belong to
    /// the calendar; what colour it is here does not — and the write latches
    /// that choice, so the next sync stops pulling the provider's colour back
    /// over it.
    public func setFolderColor(id: String, to color: String?) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.setFolderColor(id: id, color: color)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Nest a folder inside another, or pass `nil` to bring it back to the top.
    public func setFolderParent(id: String, to parent: String?) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.setFolderParent(id: id, parent: parent)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Move a folder to the trash, taking its pages with it.
    ///
    /// If the deleted folder was the one being shown, the scope falls back to
    /// Today — leaving it selected would show an empty list under the name of
    /// something that no longer exists.
    public func trashFolder(id: String) async {
        guard let workspace else { return }
        do {
            try await workspace.trashFolder(id: id)
            if case .folder(let shown, _) = scope, shown == id {
                scope = .today
            }
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Rename a page without opening it.
    ///
    /// The title is the first line of the document on desktop, but renaming
    /// from a list must not load and re-save the body — that would restamp
    /// `content_schema_version` for a change that touched no content, and on a
    /// page written by a newer build it would be the exact overwrite the
    /// version stamp exists to prevent.
    public func renamePage(id: String, to title: String) async {
        guard let workspace else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            _ = try await workspace.updatePage(id: id, edit: PageEdit(title: trimmed))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// File a page into a folder, or `nil` for the Inbox.
    ///
    /// The two are one call rather than a move and an unfile, because `nil`
    /// here means the Inbox rather than "leave it alone" — `PageEdit.folder`
    /// draws that distinction with an enum precisely so a caller cannot lose it
    /// to an optional.
    public func movePage(id: String, toFolder folderId: String?) async {
        guard let workspace else { return }
        do {
            let assignment: FolderAssignment =
                folderId.map { .folder(id: $0) } ?? .inbox
            _ = try await workspace.updatePage(id: id, edit: PageEdit(folder: assignment))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Move a page to a date, or give one to a page that had none.
    ///
    /// Replaces whatever one-off date the page carried rather than adding a
    /// second — a page can hold several, and the earliest still ahead is the
    /// one it shows, so adding when the user meant moving leaves the old date
    /// to resurface days later.
    ///
    /// Both strings are local wall clocks: `yyyy-MM-dd` for an all-day page,
    /// `yyyy-MM-ddTHH:mm:ss` for a timed one, and the workspace refuses a
    /// mismatched pair.
    public func setSchedule(pageId: String, start: String, end: String?) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.setPageSchedule(
                pageId: pageId, scheduledStart: start, scheduledEnd: end)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Replace a page's tags.
    ///
    /// Whole-list rather than add/remove: tags are stored as one JSON column
    /// plus a join table the writer keeps in step, so every write is a
    /// replacement underneath. Offering "remove one" on top of that would be a
    /// read-modify-write in the UI that two edits in quick succession could
    /// interleave and lose.
    ///
    /// Blank entries are dropped and the leading `#` is optional, because the
    /// same person types `#work` in quick add an hour earlier.
    public func setTags(pageId: String, to tags: [String]) async {
        guard let workspace else { return }
        let cleaned =
            tags
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .map { $0.hasPrefix("#") ? String($0.dropFirst()) : $0 }
            .filter { !$0.isEmpty }
        do {
            _ = try await workspace.updatePage(id: pageId, edit: PageEdit(tags: cleaned))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// What a page repeats as, and whether this app may change it.
    ///
    /// Fetched on demand rather than carried on every summary: a repeat is read
    /// when somebody opens the picker, and a rule row per listed page would be
    /// a join on every refresh for a field almost no row uses.
    public func pageRepeat(for pageId: String) async -> PageRepeat? {
        guard let workspace else { return nil }
        do {
            return try await workspace.pageRepeat(pageId: pageId)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Make a page repeat, or change how it already does.
    ///
    /// Returns whether it took, so a sheet knows whether to close. The workspace
    /// refuses a page with no date, a rule it cannot represent, and one a
    /// calendar owns — and each refusal carries a sentence worth showing.
    @discardableResult
    public func setRepeat(pageId: String, to value: Repeat) async -> Bool {
        guard let workspace else { return false }
        do {
            try await workspace.setPageRepeat(pageId: pageId, pattern: value)
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Stop a page repeating. The page stays, on the date it was last on.
    @discardableResult
    public func removeRepeat(pageId: String) async -> Bool {
        guard let workspace else { return false }
        do {
            try await workspace.removePageRepeat(pageId: pageId)
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Take a page's date away, leaving any recurrence intact.
    public func clearDate(pageId: String) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.clearPageSchedule(pageId: pageId)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Set a page's priority, or take it away with `nil`.
    ///
    /// Stored as a number, low value first: 1 urgent through 4 low, with 0
    /// meaning none. The naming runs the opposite way to the number, which is
    /// exactly why this mapping lives in one place — and why "none" is a real
    /// value here rather than the absence of one. `PageEdit.priority` uses nil
    /// for "leave it alone", so clearing has to say 0 out loud.
    public func setPriority(pageId: String, priority: Priority?) async {
        guard let workspace else { return }
        let stored: Int64
        switch priority {
        case .urgent: stored = 1
        case .high: stored = 2
        case .medium: stored = 3
        case .low: stored = 4
        case nil: stored = 0
        }
        do {
            _ = try await workspace.updatePage(id: pageId, edit: PageEdit(priority: stored))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Create whatever a quick-add line asks for — one page, several, or a
    /// recurring one — and return them.
    ///
    /// The line is parsed in Rust, by the same code the desktop's parser is
    /// graded against, so "standup every weekday at 9am #work" means the same
    /// thing on both. `reference` is passed explicitly rather than read from
    /// the clock inside, so a line typed at 23:59 cannot resolve against a
    /// different day than the one the user is looking at.
    public func createFromQuickAdd(
        _ line: String,
        reference: Date = Date(),
        folderId: String? = nil
    ) async -> [Page] {
        guard let workspace else { return [] }
        do {
            let created = try await workspace.createFromQuickAdd(
                input: line,
                reference: Self.wallClock(reference),
                folderId: folderId,
                timezone: TimeZone.current.identifier
            )
            await refresh()
            return created
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    /// A `Date` as the wall-clock string the workspace speaks.
    ///
    /// Fixed format and fixed locale, with no timezone conversion: the stored
    /// value is a wall clock and `Date` is an instant, so converting is the
    /// mistake the string-typed boundary exists to prevent.
    ///
    /// `nonisolated` because it reads nothing from the store — the class is
    /// main-actor bound and callers of this are not.
    nonisolated static func wallClock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.string(from: date)
    }

    /// Tick or untick a page.
    ///
    /// One call, whatever kind of page it is. The routing lives in Rust because
    /// the two operations behind this checkbox are indistinguishable at the
    /// call site and one of them is destructive: setting `status` on a
    /// recurring head ends the series, while completing an occurrence of it
    /// clones the head and advances it.
    ///
    /// An earlier version decided here, reading `is_recurring` from `pages` and
    /// defaulting to false when the page was not in the list. That is correct
    /// for this screen and a trap for every other caller — a widget action or an
    /// App Intent completing a page it never listed would silently take the
    /// corrupting path. Moving the decision removed the trap instead of
    /// documenting it.
    public func setStatus(pageId: String, done: Bool) async {
        guard let workspace else { return }
        let isRecurring = pages.first { $0.id == pageId }?.isRecurring ?? false

        // Optimistic, but only for a plain page. A recurring one does not simply
        // become done — the head advances and a completed clone appears beside
        // it — so there is nothing honest to show before the write lands.
        if !isRecurring, let index = pages.firstIndex(where: { $0.id == pageId }) {
            pages[index].status = done ? "done" : "not_started"
        }

        do {
            try await workspace.setPageStatus(pageId: pageId, done: done)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
            await refresh()
        }
    }

    /// Move everything overdue onto today.
    ///
    /// Returns what it did, so the caller can say so and offer the way back.
    /// Which pages are overdue is decided by the workspace, not by the list on
    /// screen: that list is as old as the last refresh, and a bulk write keyed
    /// on a stale one moves pages the reader can no longer see.
    public func moveOverdueToToday() async -> OverdueMoveResult? {
        guard let workspace else { return nil }
        do {
            let result = try await workspace.moveOverdueToToday()
            await refresh()
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Put a bulk move back.
    public func undoOverdueMove(_ moved: [MovedPage]) async {
        guard let workspace, !moved.isEmpty else { return }
        do {
            _ = try await workspace.undoOverdueMove(moved: moved)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - One occurrence at a time

    /// Finish the occurrence the user tapped, not the one the series owes.
    ///
    /// `setStatus` completes whichever occurrence is next due, which is right
    /// for a checkbox in a list — that row *is* the next one due. On a calendar
    /// it is wrong the moment a series falls behind: the head sits on last
    /// Monday while the block on screen is this Thursday's, and ticking the
    /// block would close last Monday and leave Thursday drawn undone.
    ///
    /// So the calendar names its occurrence. Every field comes off the entry it
    /// drew, which is the only place they agree.
    public func completeOccurrence(_ entry: CalendarEntry) async {
        guard let workspace else { return }
        do {
            _ = try await workspace.completeRecurringOccurrence(
                pageId: entry.pageId, occurrence: occurrence(of: entry))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Drop one occurrence without finishing it — "not this week".
    ///
    /// Returns the date it skipped, for an undo. Nothing is destroyed, so the
    /// undo is one call back the other way and the action needs no confirmation.
    @discardableResult
    public func skipOccurrence(_ entry: CalendarEntry) async -> String? {
        guard let workspace else { return nil }
        let date = occurrence(of: entry).originalDate
        do {
            try await workspace.skipOccurrence(pageId: entry.pageId, occurrenceDate: date)
            await refresh()
            return date
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Put a skipped occurrence back.
    public func unskipOccurrence(pageId: String, on date: String) async {
        guard let workspace else { return }
        do {
            try await workspace.unskipOccurrence(pageId: pageId, occurrenceDate: date)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Move one occurrence of a series to a new time.
    ///
    /// Returns whether it took, so the sheet knows whether to close. Only a
    /// projected block can be moved this way: a real one is a row, and a row
    /// moves through `setSchedule`. The guard is here rather than only in the
    /// menu because a calendar can be a refresh out of date by the time a sheet
    /// is confirmed.
    ///
    /// The timezone is the one the phone is in, which is the zone the new wall
    /// clock is written in.
    @discardableResult
    public func moveOccurrence(_ entry: CalendarEntry, to start: String, end: String?) async
        -> Bool
    {
        guard let workspace, let ruleId = entry.ruleId, let originalDate = entry.originalDate
        else { return false }
        do {
            try await workspace.moveOccurrence(
                ruleId: ruleId, originalDate: originalDate, scheduledStart: start,
                scheduledEnd: end, timezone: TimeZone.current.identifier)
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Which occurrence a drawn block is, in the terms the sets are keyed by.
    ///
    /// A projected block carries the rule's own date already. A real one — the
    /// series head, drawn from its row — does not, and its date is the first ten
    /// characters of its start: the same slice `pikos-db` takes when it resolves
    /// the head's occurrence itself, so the two cannot disagree about which day
    /// was meant.
    private func occurrence(of entry: CalendarEntry) -> Occurrence {
        Occurrence(
            originalDate: entry.originalDate ?? String(entry.scheduledStart.prefix(10)),
            scheduledStart: entry.scheduledStart,
            scheduledEnd: entry.scheduledEnd)
    }

    /// What is in the trash, newest first.
    ///
    /// Fetched on demand rather than held: the trash is a screen someone opens
    /// rarely and deliberately, so keeping it live would be paying for it on
    /// every refresh of a list nobody is looking at.
    public func trashedPages() async -> [TrashedPage] {
        guard let workspace else { return [] }
        do {
            return try await workspace.listTrashedPages()
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    /// How long the trash keeps a page. Read from the workspace so the sentence
    /// shown to the user cannot drift from the purge that enforces it.
    public var trashRetentionDays: Int64 {
        workspace?.trashRetentionDays() ?? 30
    }

    public func trash(pageId: String) async {
        guard let workspace else { return }
        do {
            try await workspace.trashPage(id: pageId)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func restore(pageId: String) async {
        guard let workspace else { return }
        do {
            try await workspace.restorePage(id: pageId)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The document schema this build writes.
    ///
    /// A page whose `contentSchemaVersion` exceeds this must be opened
    /// read-only: saving would re-serialise through an older schema and
    /// silently drop node types this build cannot represent.
    public var contentSchemaVersion: Int64 {
        workspace?.contentSchemaVersion() ?? 0
    }

    public func canEdit(_ page: Page) -> Bool {
        page.contentSchemaVersion <= contentSchemaVersion
    }
}
