import CoreSpotlight
import Foundation
import PikosCore

/// The parts of Core Spotlight the indexer uses, so a test can stand in for the index.
public protocol SpotlightIndex: Sendable {
    func deleteAll() async throws
    func delete(ids: [String]) async throws
    func add(_ items: [CSSearchableItem]) async throws
}

/// The phone's own index. Nothing in it leaves the phone.
public struct CoreSpotlightIndex: SpotlightIndex {
    public init() {}

    public func deleteAll() async throws {
        try await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [SpotlightItem.domain])
    }

    public func delete(ids: [String]) async throws {
        try await CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: ids)
    }

    public func add(_ items: [CSSearchableItem]) async throws {
        try await CSSearchableIndex.default().indexSearchableItems(items)
    }
}

/// How far the index has caught up with the workspace, and the pass that moves it on. The mark
/// moves only once everything since it is in the index: the next pass reads from the mark, so one
/// saved over a failed batch would leave that batch's pages out of search for good.
public struct SpotlightCatchUp: Sendable {
    private let index: SpotlightIndex
    /// By name, since `UserDefaults` isn't `Sendable` and the pass runs off the main actor.
    private let suiteName: String?

    private var defaults: UserDefaults {
        suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }

    /// A nil `suiteName` is the app's standard defaults, where the mark has always been kept.
    public init(index: SpotlightIndex = CoreSpotlightIndex(), suiteName: String? = nil) {
        self.index = index
        self.suiteName = suiteName
    }

    static let seqKey = "pikos.spotlight.seq"
    static let epochKey = "pikos.spotlight.epoch"
    static let foldersKey = "pikos.spotlight.folders"
    static let batchSize = 1_000

    /// Where the next pass reads from, or nil to start over. A change to the folders starts over,
    /// since every item names its folder.
    public func since(folderShape: String) -> IndexMark? {
        guard defaults.string(forKey: Self.foldersKey) == folderShape,
            let epoch = defaults.string(forKey: Self.epochKey)
        else { return nil }

        return IndexMark(seq: Int64(defaults.integer(forKey: Self.seqKey)), epoch: epoch)
    }

    /// Puts `changes` in the index and then keeps their mark. Throws the first failure, leaving
    /// the old mark, so the next pass tries the same pages again.
    public func apply(_ changes: IndexChanges, folderNames: [String: String], folderShape: String) async throws {
        if changes.everything {
            try await index.deleteAll()
        } else if !changes.removed.isEmpty {
            try await index.delete(ids: changes.removed)
        }
        for start in stride(from: 0, to: changes.pages.count, by: Self.batchSize) {
            let items = changes.pages[start..<min(start + Self.batchSize, changes.pages.count)].map {
                SpotlightItem.make(for: $0, folderName: $0.folderId.flatMap { folderNames[$0] })
            }
            try await index.add(items)
        }
        defaults.set(Int(changes.mark.seq), forKey: Self.seqKey)
        defaults.set(changes.mark.epoch, forKey: Self.epochKey)
        defaults.set(folderShape, forKey: Self.foldersKey)
    }

    /// Forgets the mark and empties the index, for "Delete all data": a stale index would keep
    /// offering the titles of a wiped phone's notes. The mark goes first, so a failed delete still
    /// leaves the next pass to rebuild everything.
    public func clear() async throws {
        for key in [Self.seqKey, Self.epochKey, Self.foldersKey] { defaults.removeObject(forKey: key) }
        try await index.deleteAll()
    }
}
