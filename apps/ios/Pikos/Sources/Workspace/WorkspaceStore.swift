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

    public func setStatus(pageId: String, done: Bool) async {
        guard let workspace else { return }
        // Optimistic: a task checkbox that waits for a database round trip
        // before filling in feels broken, and the write practically never fails.
        // The refresh below reconciles if it does.
        if let index = pages.firstIndex(where: { $0.id == pageId }) {
            pages[index].status = done ? "done" : "not_started"
        }
        do {
            _ = try await workspace.updatePage(
                id: pageId, edit: PageEdit(status: done ? "done" : "not_started"))
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
            await refresh()
        }
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
