import CoreSpotlight
import Foundation
import PikosCore
import PikosSupport
import os

/// Pages, findable from the home screen's search. What each entry holds is `SpotlightItem`.
///
/// Caught up rather than rebuilt. Every write bumps the store's version, and the index follows a
/// few seconds later with the pages the workspace's change counter says were written since its
/// last pass, so the delta is the database's, not a guess about which writes mattered. A full
/// rebuild was tried first: at 200,000 pages it held the main thread for seconds after every tick.
/// It still starts over when the counter's epoch changes or a folder is renamed, since every
/// item names its folder.
///
/// Nothing leaves the phone: Core Spotlight's index is on-device.
@MainActor
final class SpotlightIndexer {
    private let workspace: @MainActor () -> Workspace?
    private nonisolated static let log = Logger(subsystem: "app.pikos", category: "spotlight")

    init(workspace: @escaping @MainActor () -> Workspace?) {
        self.workspace = workspace
    }

    /// Bring the index up to date with the open pages as they are now. A failed pass is logged, not
    /// shown: it keeps the old mark, so the next pass tries the same pages again.
    func reindex() async {
        guard CSSearchableIndex.isIndexingAvailable(), let workspace = workspace() else { return }

        let folders: [Folder]
        let changes: IndexChanges
        let catchUp = SpotlightCatchUp()
        let shape: String
        do {
            folders = try await workspace.listFolders()
            shape = folders.map { "\($0.id)=\($0.name)" }.sorted().joined(separator: "\n")
            changes = try await workspace.indexChanges(since: catchUp.since(folderShape: shape))
        } catch {
            Self.log.error("reading what changed failed: \(FailureText.kind(error), privacy: .public)")
            return
        }
        let names = Dictionary(folders.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        do {
            try await Task.detached(priority: .utility) {
                try await catchUp.apply(changes, folderNames: names, folderShape: shape)
            }.value
        } catch {
            Self.log.error(
                "indexing \(changes.pages.count) pages and removing \(changes.removed.count) failed, so they're tried again next pass: \(FailureText.kind(error), privacy: .public)"
            )
        }
    }

    /// Forget everything, for "Delete all data". Throws when the index couldn't be emptied, which
    /// the person has to hear: their wiped notes' titles would stay in search.
    static func clear() async throws {
        do {
            try await SpotlightCatchUp().clear()
        } catch {
            log.error("emptying the index failed: \(FailureText.kind(error), privacy: .public)")
            throw error
        }
    }

    static func pageId(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType else { return nil }
        return activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    }
}
