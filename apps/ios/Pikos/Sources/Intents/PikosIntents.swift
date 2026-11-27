import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import UIKit
import WidgetKit
import os

/// Shortcuts and Siri.
///
/// App Intents declared in the app target run in the app's process, launched in the background if
/// needed. That keeps the single-writer rule: an intent that wrote from an extension process
/// would be a second writer against a WAL database that permits one. Anything that writes
/// belongs here, and the widget's `ReadOnlyWorkspace` has no write methods, which enforces the
/// rule by type.
enum PikosIntentError: Error, CustomLocalizedStringResourceConvertible {
    /// The phone hasn't been unlocked since it started, so its files can't be read yet.
    case locked
    case workspaceUnavailable(String)
    /// A workspace call failed while doing what "Couldn't …" names.
    case failed(doing: String, message: String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .locked:
            return "Unlock your iPhone, then try again. Pikos can't read your notes until it has been unlocked."
        case .workspaceUnavailable(let message):
            return "Pikos couldn't open your notes. \(message)"
        case .failed(let doing, let message):
            return "Pikos couldn't \(doing). \(message)"
        }
    }

    /// Logs the failure by its kind and turns it into a sentence Shortcuts can show.
    static func failure(_ doing: String, _ error: Error) -> PikosIntentError {
        intentLog.error(
            "couldn't \(doing, privacy: .public): \(FailureText.kind(error), privacy: .public): \(FailureText.message(error), privacy: .private)"
        )
        return .failed(doing: doing, message: FailureText.message(error))
    }
}

private let intentLog = Logger(subsystem: "app.pikos", category: "intents")

/// Why the workspace didn't open, in words the person can act on. A phone not yet unlocked since
/// it started can't read the workspace's files, and the open's error doesn't say that, so it's
/// asked of the system.
private func openFailure(_ error: Error) async -> PikosIntentError {
    let isLocked = await MainActor.run { !UIApplication.shared.isProtectedDataAvailable }
    intentLog.error(
        "couldn't open the workspace\(isLocked ? " while locked" : "", privacy: .public): \(FailureText.kind(error), privacy: .public): \(FailureText.message(error), privacy: .private)"
    )
    return isLocked ? .locked : .workspaceUnavailable(FailureText.message(error))
}

/// Open the workspace for a single intent run, per invocation: an intent may run in a freshly
/// launched process that is suspended again shortly after, so there is no lifetime to cache against.
private func openWorkspace() async throws -> Workspace {
    do {
        let url = try WorkspaceLocation.databaseURL()
        return try await Workspace.open(path: url.path)
    } catch {
        throw await openFailure(error)
    }
}

/// Open the workspace read-only, for the parts of an intent that only look. Entity queries run
/// while the user is still assembling a shortcut, and a writable handle there would be a second
/// writer, so the type enforces the rule. `openExisting` refuses to create a database: a picker
/// shown before the app has ever run must come back empty, not leave an empty workspace behind.
/// workspace behind for the app to find.
private func openForReading() async throws -> ReadOnlyWorkspace {
    do {
        let url = try WorkspaceLocation.databaseURL()
        return try await ReadOnlyWorkspace.openExisting(path: url.path)
    } catch {
        throw await openFailure(error)
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
        // An intent has no picker, so an unanswered folder falls back to the default-folder
        // preference rather than the Inbox, which is what that setting is mostly for.
        let folderId: String?
        if let chosen = folder?.id {
            folderId = chosen
        } else {
            folderId = await preferredFolderID(in: workspace)
        }
        let page: Page
        do {
            page = try await workspace.createPage(page: NewPage(title: title, folderId: folderId))
        } catch {
            throw PikosIntentError.failure("add the page", error)
        }

        // A page created by voice should appear in the widget without waiting for its next refresh.
        WidgetCenter.shared.reloadAllTimelines()

        return .result(dialog: "Added \(page.title).")
    }
}

/// The default folder, if it still exists: a deleted one would fail the create on the foreign
/// key. Read through the handle the intent already holds, since a second handle on the same
/// file is a near miss of the one-writer rule.
@MainActor
private func preferredFolderID(in workspace: Workspace) async -> String? {
    guard let preferred = Preferences.shared.defaultFolderID else { return nil }
    let folders: [Folder]
    do {
        folders = try await workspace.listFolders()
    } catch {
        // The Inbox, where a page with no folder goes, is still somewhere to put it.
        intentLog.notice("reading the folders for the default failed: \(FailureText.kind(error), privacy: .public)")
        return nil
    }
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
        let hits: [SearchHit]
        do {
            hits = try await workspace.search(query: query, includeCompleted: false, limit: 20).hits
        } catch {
            throw PikosIntentError.failure("search", error)
        }
        let entities = hits.map { PageEntity(id: $0.pageId, title: $0.title) }

        let dialog: IntentDialog =
            entities.isEmpty
            ? "No pages matched \(query)."
            : "Found \(entities.count) \(entities.count == 1 ? "page" : "pages")."
        return .result(value: entities, dialog: dialog)
    }
}

// MARK: - Today's list

/// "What's on my list today", read out rather than opened, with the pages handed back for a
/// shortcut to use. Titles and times only.
struct TodayListIntent: AppIntent {
    static let title: LocalizedStringResource = "Today's list"
    static let description = IntentDescription(
        "Hear what's on your list today: what's due and what's overdue.",
        categoryName: "Pages")

    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[PageEntity]> & ProvidesDialog {
        let workspace = try await openForReading()
        let open: [PageSummary]
        do {
            open = try await workspace.listToday().filter { $0.status != "done" }
        } catch {
            throw PikosIntentError.failure("read today's list", error)
        }
        let entities = await PageEntity.describing(open, in: workspace)
        let items = open.map { TodaySpeech.Item(title: $0.title, time: PageEntity.timeLabel($0.scheduledStart)) }
        return .result(value: entities, dialog: IntentDialog(stringLiteral: TodaySpeech.sentence(for: items)))
    }
}

// MARK: - Open

struct OpenTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Open today"
    static let description = IntentDescription(
        "Open Pikos showing today's pages.",
        categoryName: "Navigation")

    static let openAppWhenRun = true

    /// The app's router, injected by `AppDependencyManager`: `openAppWhenRun` doesn't say where the
    /// app should land, and an intent has no view to reach `openURL` through, but it runs in the
    /// app's process and can move the router directly.
    @Dependency private var route: Route

    @MainActor
    func perform() async throws -> some IntentResult {
        route.showToday()
        return .result()
    }
}

// MARK: - Entities

/// A page, as Shortcuts, Siri and Apple Intelligence see it: its title, date, folder and whether
/// it's done, and never its body.
struct PageEntity: AppEntity, Identifiable {
    let id: String
    @Property(title: "Title") var title: String
    @Property(title: "Date") var date: Date?
    @Property(title: "Folder") var folder: String?
    @Property(title: "Done") var isDone: Bool

    init(id: String, title: String, date: Date? = nil, folder: String? = nil, isDone: Bool = false) {
        self.id = id
        self.title = title
        self.date = date
        self.folder = folder
        self.isDone = isDone
    }

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Page"

    var displayRepresentation: DisplayRepresentation {
        let place = [folder, date.map { $0.formatted(date: .abbreviated, time: .omitted) }]
            .compactMap { $0 }
            .joined(separator: " · ")
        return DisplayRepresentation(
            title: "\(title.isEmpty ? "Untitled" : title)",
            subtitle: place.isEmpty ? nil : "\(place)")
    }

    static let defaultQuery = PageEntityQuery()

    /// Pages as entities, with their folders' names looked up once.
    static func describing(_ pages: [PageSummary], in workspace: ReadOnlyWorkspace) async -> [PageEntity] {
        var folders: [Folder] = []
        do {
            folders = try await workspace.listFolders()
        } catch {
            // The pages still go back, only without their folders' names.
            intentLog.notice("reading the folders' names failed: \(FailureText.kind(error), privacy: .public)")
        }
        let names = Dictionary(folders.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        return pages.map { page in
            PageEntity(
                id: page.id, title: page.title,
                date: page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) },
                folder: page.folderId.flatMap { names[$0] }, isDone: page.status == "done")
        }
    }

    /// "9:30 AM" for a timed page, nil for one with a day and no time.
    static func timeLabel(_ scheduledStart: String?) -> String? {
        guard let start = scheduledStart, start.contains("T"),
            let date = StorageTimestamp.wallClock(start)
        else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

/// Also how Siri finds a page by name, through the search index on the device.
struct PageEntityQuery: EntityStringQuery {
    func entities(matching string: String) async throws -> [PageEntity] {
        let workspace = try await openForReading()
        let ids = try await workspace.search(query: string, includeCompleted: false, limit: 20).hits.map(\.pageId)
        return try await entities(for: ids)
    }

    func entities(for identifiers: [String]) async throws -> [PageEntity] {
        let workspace = try await openForReading()
        var found: [PageEntity] = []
        for id in identifiers {
            // A page in a saved shortcut may since have been deleted. Skipping
            // it is right: Shortcuts drops entities it cannot resolve, which is
            // better than failing the whole run over one stale reference.
            let page: Page
            do {
                page = try await workspace.getPage(id: id)
            } catch WorkspaceError.NotFound {
                continue
            } catch {
                throw PikosIntentError.failure("find a page", error)
            }
            found.append(
                PageEntity(
                    id: page.id, title: page.title,
                    date: page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) },
                    isDone: page.status == "done"))
        }
        return found
    }

    /// Shortcuts calls this to fill a parameter picker, possibly before Pikos has ever been opened
    /// and so before a database exists. An empty picker is the honest answer there; throwing would
    /// show an error for an app the user has not used yet.
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
            intent: TodayListIntent(),
            phrases: [
                "What's on my \(.applicationName) list",
                "What's on my list today in \(.applicationName)",
                "What's due in \(.applicationName)",
            ],
            shortTitle: "Today's list",
            systemImageName: "list.bullet")

        AppShortcut(
            intent: SearchPagesIntent(),
            phrases: [
                "Search \(.applicationName)",
                "Find a page in \(.applicationName)",
            ],
            shortTitle: "Search pages",
            systemImageName: "magnifyingglass")

        AppShortcut(
            intent: OpenTodayIntent(),
            phrases: ["Open \(.applicationName) today"],
            shortTitle: "Today",
            systemImageName: "sun.max")
    }
}
