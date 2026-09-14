import CoreSpotlight
import Foundation
import PikosCore
import PikosSupport
import UniformTypeIdentifiers

/// Pages, findable from the home screen's search.
///
/// A notes app whose notes cannot be found by pulling down on the home screen
/// is one the phone treats as a stranger: Notes, Reminders, Things and Bear
/// all index, and a reader who searches for "dentist" and sees every app's
/// answer but this one's concludes the page is not there. The index holds
/// what the list row shows — title, subtitle, tags, date — and nothing from
/// the document body, which stays in the app's own full-text search where
/// the excerpt can be quoted.
///
/// Rebuilt whole rather than patched. Every write bumps the store's version,
/// and the app already re-plans reminders and reloads widgets on that; the
/// index follows the same signal a few seconds later. Open pages only, and a
/// full rebuild is one query and one batch — cheap enough that tracking which
/// page changed would be more code than it saves, and a wrong delta is an
/// index that lies for weeks.
///
/// Nothing leaves the phone. Core Spotlight's index is on-device, and the
/// privacy manifest's claims about the binary remain true.
@MainActor
final class SpotlightIndexer {
    static let domain = "app.pikos.pages"

    private let workspace: @MainActor () -> Workspace?

    init(workspace: @escaping @MainActor () -> Workspace?) {
        self.workspace = workspace
    }

    /// Replace the index with the open pages as they are now.
    func reindex() async {
        guard CSSearchableIndex.isIndexingAvailable(), let workspace = workspace() else { return }
        guard let pages = try? await workspace.listPages(query: PageQuery(openOnly: true)) else {
            return
        }
        let items = pages.map(Self.item(for:))
        let index = CSSearchableIndex.default()
        // Delete then index, so a page that was trashed since the last pass
        // stops being offered. Both calls are best-effort: an index that is
        // briefly stale is a search that misses one page, which is what it was
        // before this existed.
        try? await index.deleteSearchableItems(withDomainIdentifiers: [Self.domain])
        guard !items.isEmpty else { return }
        try? await index.indexSearchableItems(items)
    }

    /// Forget everything, for "Delete all data".
    ///
    /// The one place a stale index would be worse than a missing one: a phone
    /// wiped of its notes must not keep offering their titles from the home
    /// screen.
    static func clear() async {
        try? await CSSearchableIndex.default().deleteSearchableItems(
            withDomainIdentifiers: [domain])
    }

    /// The page a Spotlight result names, or nil for an activity that is not
    /// one of ours.
    static func pageId(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType else { return nil }
        return activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    }

    private static func item(for page: PageSummary) -> CSSearchableItem {
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = page.title.isEmpty ? String(localized: "Untitled") : page.title
        attributes.contentDescription = page.subtitle
        attributes.keywords = page.tags
        if let start = page.scheduledStart {
            attributes.dueDate = StorageTimestamp.wallClock(start)
        }
        // Say what it is under the title: Spotlight shows the app's name, and
        // "in Work" or "Today" is what tells two "Standup" pages apart.
        return CSSearchableItem(
            uniqueIdentifier: page.id, domainIdentifier: domain, attributeSet: attributes)
    }
}

