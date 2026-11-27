import CoreSpotlight
import PikosCore
import XCTest

@testable import PikosSupport

/// An index that records what it was given, and can refuse to take any more.
private final class FakeIndex: SpotlightIndex, @unchecked Sendable {
    var refusesItems = false
    private(set) var indexed: [String] = []

    func deleteAll() async throws {}

    func delete(ids: [String]) async throws {}

    func add(_ items: [CSSearchableItem]) async throws {
        if refusesItems { throw CocoaError(.fileWriteOutOfSpace) }
        indexed += items.map(\.uniqueIdentifier)
    }
}

final class SpotlightCatchUpTests: XCTestCase {
    private var path: String!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUpWithError() throws {
        path = FileManager.default.temporaryDirectory.appendingPathComponent("pikos-\(UUID().uuidString).db").path
        suite = "pikos-spotlight-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
    }

    func testAPassThatFailsToIndexKeepsTheOldMarkSoTheNextPassIndexesThosePages() async throws {
        let workspace = try await Workspace.open(path: path)
        let page = try await workspace.createPage(page: NewPage(title: "Dentist"))
        let index = FakeIndex()
        let catchUp = SpotlightCatchUp(index: index, suiteName: suite)
        index.refusesItems = true

        let failed = try await workspace.indexChanges(since: catchUp.since(folderShape: ""))
        do {
            try await catchUp.apply(failed, folderNames: [:], folderShape: "")
            XCTFail("the failure reaches the indexer, which logs it")
        } catch {}
        let markAfterFailure = catchUp.since(folderShape: "")
        index.refusesItems = false
        let retried = try await workspace.indexChanges(since: markAfterFailure)
        try await catchUp.apply(retried, folderNames: [:], folderShape: "")

        XCTAssertNil(markAfterFailure, "no mark is saved over pages that never reached the index")
        XCTAssertEqual(index.indexed, [page.id])
        XCTAssertEqual(catchUp.since(folderShape: ""), retried.mark)
    }

    func testRenamingAFolderStartsTheIndexOver() async throws {
        let workspace = try await Workspace.open(path: path)
        _ = try await workspace.createPage(page: NewPage(title: "Dentist"))
        let catchUp = SpotlightCatchUp(index: FakeIndex(), suiteName: suite)

        let changes = try await workspace.indexChanges(since: nil)
        try await catchUp.apply(changes, folderNames: [:], folderShape: "f1=Health")

        XCTAssertEqual(catchUp.since(folderShape: "f1=Health"), changes.mark)
        XCTAssertNil(catchUp.since(folderShape: "f1=Doctors"))
    }
}
