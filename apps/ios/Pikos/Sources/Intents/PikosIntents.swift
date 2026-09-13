import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// Shortcuts and Siri.
///
/// ## Why these live in the app target
///
/// App Intents declared in the app target run in the app's process — launched
/// in the background if it is not already running. That is what keeps the
/// single-writer rule intact: an intent that wrote from an extension process
/// would be a second writer against a database whose WAL mode permits one, and
/// the app would block behind it.
///
/// Anything that needs to write therefore belongs here rather than in the
/// widget extension. The widget's `ReadOnlyWorkspace` has no write methods at
/// all, which is the same rule enforced by the type system rather than by
/// where a file happens to sit.
enum PikosIntentError: Error, CustomLocalizedStringResourceConvertible {
    case workspaceUnavailable

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .workspaceUnavailable:
            return "Pikos couldn't open your notes."
        }
    }
}

/// Open the workspace for a single intent run.
///
/// Opened per invocation rather than held: an intent may run in a process that
/// has just been launched for it and will be suspended again shortly after, so
/// there is no meaningful lifetime to cache against.
private func openWorkspace() async throws -> Workspace {
    do {
        let url = try WorkspaceLocation.databaseURL()
        return try await Workspace.open(path: url.path)
    } catch {
        throw PikosIntentError.workspaceUnavailable
    }
}

/// Open the workspace read-only, for the parts of an intent that only look.
///
/// Entity queries are not intent runs: Shortcuts calls `suggestedEntities` to
/// populate a parameter picker while the user is still assembling a shortcut,
/// and `entities(for:)` to resolve saved references. Opening a writable handle
/// for those would put a second writer on a database whose WAL mode permits
/// one, which is the rule this whole file is arranged around — so the type
/// enforces it here too rather than the comment above doing it alone.
///
/// `openExisting` also refuses to create a database, which matters: a picker
/// shown before the app has ever run must come back empty, not leave an empty
/// workspace behind for the app to find.
private func openForReading() async throws -> ReadOnlyWorkspace {
    do {
        let url = try WorkspaceLocation.databaseURL()
        return try await ReadOnlyWorkspace.openExisting(path: url.path)
    } catch {
        throw PikosIntentError.workspaceUnavailable
    }
}

// MARK: - Create

struct CreatePageIntent: AppIntent {
    static let title: LocalizedStringResource = "New page"
    static let description = IntentDescription(
        "Create a page in Pikos.",
        categoryName: "Pages")

    /// Not opened by default: the point of "Hey Siri, add a page to Pikos" is
    /// that it does not interrupt what the user is doing.
    static let openAppWhenRun = false

    @Parameter(title: "Title", requestValueDialog: "What should the page say?")
    var title: String

    @Parameter(title: "Folder")
    var folder: FolderEntity?

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let workspace = try await openWorkspace()
        // An intent has no sheet to show a folder picker in, so an unanswered
        // folder parameter falls back to the preference rather than to the
        // Inbox. This is the path that setting is mostly *for*: in the app the
        // user can see the picker and change it, and here they cannot.
        //
        // The stored id can name a folder that has since been deleted, in
        // which case the create would fail on the foreign key — so it is
        // checked first and the Inbox is the fallback, the same resolution the
        // settings screen describes.
        let folderId: String?
        if let chosen = folder?.id {
            folderId = chosen
        } else {
            folderId = await preferredFolderID(in: workspace)
        }
        let page = try await workspace.createPage(
            page: NewPage(title: title, folderId: folderId))

        // The widget shows today's pages, and a page created by voice should
        // appear there without waiting for the next scheduled refresh.
        WidgetCenter.shared.reloadAllTimelines()

        return .result(dialog: "Added \(page.title).")
    }
}

/// The default folder, if it still exists.
///
/// Read through the handle the intent already holds rather than opening a
/// second one: two handles on the same file is the one-writer rule's near miss,
/// and this needs nothing the existing handle cannot answer.
@MainActor
private func preferredFolderID(in workspace: Workspace) async -> String? {
    guard let preferred = Preferences.shared.defaultFolderID else { return nil }
    let folders = (try? await workspace.listFolders()) ?? []
    return folders.contains { $0.id == preferred && !$0.isExternalCalendar } ? preferred : nil
}

// MARK: - Search

struct SearchPagesIntent: AppIntent {
    static let title: LocalizedStringResource = "Search pages"
    static let description = IntentDescription(
        "Find pages in Pikos by title or content.",
        categoryName: "Pages")

    @Parameter(title: "Search for", requestValueDialog: "What are you looking for?")
    var query: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[PageEntity]> & ProvidesDialog {
        let workspace = try await openWorkspace()
        let hits = try await workspace.search(query: query, limit: 20)
        let entities = hits.map { PageEntity(id: $0.pageId, title: $0.title) }

        let dialog: IntentDialog =
            entities.isEmpty
            ? "No pages matched \(query)."
            : "Found \(entities.count) \(entities.count == 1 ? "page" : "pages")."
        return .result(value: entities, dialog: dialog)
    }
}

// MARK: - Open

struct OpenTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Open today"
    static let description = IntentDescription(
        "Open Pikos showing today's pages.",
        categoryName: "Navigation")

    static let openAppWhenRun = true

    /// The app's router, injected by `AppDependencyManager`.
    ///
    /// `openAppWhenRun` brings the app to the front but says nothing about
    /// where it should land, and an intent has no view to reach `openURL`
    /// through. Injection is the supported way in: the intent runs in the app's
    /// process, so it can move the app's own state directly.
    @Dependency private var route: Route

    @MainActor
    func perform() async throws -> some IntentResult {
        route.showToday()
        return .result()
    }
}

// MARK: - Entities

/// A page, as Shortcuts sees it.
struct PageEntity: AppEntity, Identifiable {
    let id: String
    let title: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Page"

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title.isEmpty ? "Untitled" : title)")
    }

    static let defaultQuery = PageEntityQuery()
}

struct PageEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [PageEntity] {
        let workspace = try await openForReading()
        var found: [PageEntity] = []
        for id in identifiers {
            // A page in a saved shortcut may since have been deleted. Skipping
            // it is right: Shortcuts drops entities it cannot resolve, which is
            // better than failing the whole run over one stale reference.
            if let page = try? await workspace.getPage(id: id) {
                found.append(PageEntity(id: page.id, title: page.title))
            }
        }
        return found
    }

    /// Shortcuts calls this to fill a parameter picker, which can happen
    /// before Pikos has ever been opened and so before a database exists. An
    /// empty picker is the honest answer there; throwing would show the user an
    /// error for a app they have simply not used yet.
    func suggestedEntities() async throws -> [PageEntity] {
        guard let workspace = try? await openForReading(),
            let pages = try? await workspace.listToday()
        else { return [] }
        return pages.prefix(10).map { PageEntity(id: $0.id, title: $0.title) }
    }
}

/// A folder, for the create-page parameter.
struct FolderEntity: AppEntity, Identifiable {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Folder"

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    static let defaultQuery = FolderEntityQuery()
}

struct FolderEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [FolderEntity] {
        try await allFolders().filter { identifiers.contains($0.id) }
    }

    /// Empty rather than an error before the app has run — see the note on
    /// `PageEntityQuery.suggestedEntities`.
    func suggestedEntities() async throws -> [FolderEntity] {
        (try? await allFolders()) ?? []
    }

    private func allFolders() async throws -> [FolderEntity] {
        let workspace = try await openForReading()
        return try await workspace.listFolders().map { FolderEntity(id: $0.id, name: $0.name) }
    }
}

// MARK: - Shortcuts

struct PikosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CreatePageIntent(),
            phrases: [
                "Add a page to \(.applicationName)",
                "New \(.applicationName) page",
            ],
            shortTitle: "New page",
            systemImageName: "square.and.pencil")

        AppShortcut(
            intent: OpenTodayIntent(),
            phrases: ["Open \(.applicationName) today"],
            shortTitle: "Today",
            systemImageName: "sun.max")
    }
}
