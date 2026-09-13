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
        case inbox
        case folder(id: String, name: String)

        var query: PageQuery {
            switch self {
            case .today:
                // `listToday` covers this case; the query is unused.
                return PageQuery()
            case .inbox:
                return PageQuery(folder: .inbox)
            case .folder(let id, _):
                return PageQuery(folder: .folder(id: id))
            }
        }

        var title: String {
            switch self {
            case .today: return "Today"
            case .inbox: return "Inbox"
            case .folder(_, let name): return name
            }
        }
    }

    public private(set) var pages: [PageSummary] = []
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
            Task { await refresh() }
        }
    }

    private var workspace: Workspace?

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
            if scope == .today {
                pages = try await workspace.listToday()
            } else {
                pages = try await workspace.listPages(query: scope.query)
            }
            folders = try await workspace.listFolders()
            isLoading = false
            dataVersion += 1
        } catch {
            isLoading = false
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
            if case .notFound = error { return nil }
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

    /// Set a page's priority.
    ///
    /// Stored as a number, low value first: 1 urgent through 4 low, with 0
    /// meaning none. The naming runs the opposite way to the number, which is
    /// exactly why this mapping lives in one place.
    public func setPriority(pageId: String, priority: Priority) async {
        guard let workspace else { return }
        let stored: Int64
        switch priority {
        case .urgent: stored = 1
        case .high: stored = 2
        case .medium: stored = 3
        case .low: stored = 4
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
