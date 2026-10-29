import CoreSpotlight
import Foundation
import PikosCore
import PikosSupport

/// Pages, findable from the home screen's search.
///
/// A notes app whose notes cannot be found by pulling down on the home screen
/// is one the phone treats as a stranger: Notes, Reminders, Things and Bear
/// all index, and a reader who searches for "dentist" and sees every app's
/// answer but this one's concludes the page is not there. What each entry
/// holds is `SpotlightItem`.
///
/// Caught up rather than rebuilt. Every write bumps the store's version, and the index follows a
/// few seconds later with the pages the workspace's change counter says were written since its
/// last pass, so the delta is the database's, not a guess about which writes mattered. A full
/// rebuild was tried first: at 200,000 pages it held the main thread for seconds after every tick.
/// It still starts over when the counter's epoch changes or a folder is renamed, since every
/// item names its folder.
///
/// Nothing leaves the phone. Core Spotlight's index is on-device, and the
/// privacy manifest's claims about the binary remain true.
@MainActor
final class SpotlightIndexer {
    private let workspace: @MainActor () -> Workspace?

    init(workspace: @escaping @MainActor () -> Workspace?) {
        self.workspace = workspace
    }

    /// Bring the index up to date with the open pages as they are now.
    func reindex() async {
        guard CSSearchableIndex.isIndexingAvailable(), let workspace = workspace() else { return }
        let folders = (try? await workspace.listFolders()) ?? []
        let names = Dictionary(folders.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let shape = folders.map { "\($0.id)=\($0.name)" }.sorted().joined(separator: "\n")
        let defaults = UserDefaults.standard
        let since: IndexMark? =
            defaults.string(forKey: Self.foldersKey) == shape
            ? defaults.string(forKey: Self.epochKey).map {
                IndexMark(seq: Int64(defaults.integer(forKey: Self.seqKey)), epoch: $0)
            } : nil
        guard let changes = try? await workspace.indexChanges(since: since) else { return }
        // Best-effort throughout: an index briefly behind is a search that misses one page.
        await Task.detached(priority: .utility) {
            let index = CSSearchableIndex.default()
            if changes.everything {
                try? await index.deleteSearchableItems(withDomainIdentifiers: [SpotlightItem.domain])
            } else if !changes.removed.isEmpty {
                try? await index.deleteSearchableItems(withIdentifiers: changes.removed)
            }
            for batch in stride(from: 0, to: changes.pages.count, by: Self.batchSize) {
                let items = changes.pages[batch..<min(batch + Self.batchSize, changes.pages.count)].map {
                    SpotlightItem.make(for: $0, folderName: $0.folderId.flatMap { names[$0] })
                }
                try? await index.indexSearchableItems(items)
            }
        }.value
        defaults.set(Int(changes.mark.seq), forKey: Self.seqKey)
        defaults.set(changes.mark.epoch, forKey: Self.epochKey)
        defaults.set(shape, forKey: Self.foldersKey)
    }

    private static let seqKey = "pikos.spotlight.seq"
    private static let epochKey = "pikos.spotlight.epoch"
    private static let foldersKey = "pikos.spotlight.folders"
    private nonisolated static let batchSize = 1_000

    /// Forget everything, for "Delete all data".
    ///
    /// The one place a stale index would be worse than a missing one: a phone
    /// wiped of its notes must not keep offering their titles from the home
    /// screen.
    static func clear() async {
        for key in [seqKey, epochKey, foldersKey] { UserDefaults.standard.removeObject(forKey: key) }
        try? await CSSearchableIndex.default().deleteSearchableItems(
            withDomainIdentifiers: [SpotlightItem.domain])
    }

    /// The page a Spotlight result names, or nil for an activity that is not
    /// one of ours.
    static func pageId(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType else { return nil }
        return activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    }
}
