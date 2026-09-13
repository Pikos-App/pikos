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
