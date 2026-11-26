import XCTest

@testable import PikosCore

/// Covers what the Rust tests cannot: that the async bridge suspends and resumes,
/// that errors surface as thrown Swift errors, and that the read-only handle is
/// read-only by the compiler.
final class WorkspaceTests: XCTestCase {
    private var path: String!

    override func setUpWithError() throws {
        path = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-\(UUID().uuidString).db")
            .path
    }

    override func tearDownWithError() throws {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
    }

    func testOpensAndRoundTripsAPage() async throws {
        let workspace = try await Workspace.open(path: path)

        let created = try await workspace.createPage(
            page: NewPage(title: "From Swift"))
        XCTAssertEqual(created.title, "From Swift")

        let fetched = try await workspace.getPage(id: created.id)
        XCTAssertEqual(fetched.id, created.id)
    }

    /// A deleted page's id can outlive it (widget timeline, deep link), and must
    /// be distinguishable from a broken database.
    func testMissingPageThrowsNotFound() async throws {
        let workspace = try await Workspace.open(path: path)
        do {
            _ = try await workspace.getPage(id: "nope")
            XCTFail("expected a thrown error")
        } catch let error as WorkspaceError {
            guard case .NotFound(let entity, let id) = error else {
                return XCTFail("expected notFound, got \(error)")
            }
            XCTAssertEqual(entity, "page")
            XCTAssertEqual(id, "nope")
        }
    }

    func testSavingContentAlsoStampsTheSchemaVersion() async throws {
        let workspace = try await Workspace.open(path: path)
        let page = try await workspace.createPage(
            page: NewPage(title: "Doc"))

        let saved = try await workspace.updatePage(
            id: page.id,
            edit: PageEdit(content: #"{"type":"doc","content":[]}"#))

        XCTAssertEqual(saved.contentSchemaVersion, workspace.contentSchemaVersion())
    }

    /// The app refuses to save over a document from a newer editor, since an
    /// older schema silently drops node types it cannot represent.
    func testSchemaVersionGuardIsExpressible() async throws {
        let workspace = try await Workspace.open(path: path)
        let page = try await workspace.createPage(
            page: NewPage(title: "Doc"))

        XCTAssertLessThanOrEqual(
            page.contentSchemaVersion, workspace.contentSchemaVersion(),
            "a page this build wrote must be readable by it")
    }

    func testInboxIsDistinctFromEveryFolder() async throws {
        let workspace = try await Workspace.open(path: path)
        let folder = try await workspace.createFolder(name: "Work", color: nil)

        _ = try await workspace.createPage(
            page: NewPage(title: "Unfiled"))
        _ = try await workspace.createPage(
            page: NewPage(title: "Filed", folderId: folder.id))

        let all = try await workspace.listPages(query: PageQuery())
        let inbox = try await workspace.listPages(query: PageQuery(folder: .inbox))
        let filed = try await workspace.listPages(
            query: PageQuery(folder: .folder(id: folder.id)))

        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(inbox.map(\.title), ["Unfiled"])
        XCTAssertEqual(filed.map(\.title), ["Filed"])
    }

    func testSearchFindsPagesByBody() async throws {
        let workspace = try await Workspace.open(path: path)
        let page = try await workspace.createPage(
            page: NewPage(title: "Notes"))
        _ = try await workspace.updatePage(
            id: page.id,
            edit: PageEdit(
                content: #"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"the quick brown fox"}]}]}"#))

        let hits = try await workspace.search(query: "brown", includeCompleted: false, limit: 10).hits
        XCTAssertEqual(hits.map(\.pageId), [page.id])
    }

    /// An empty workspace created by a widget looks like the notes disappearing.
    func testReadOnlyOpenRefusesToCreateADatabase() async throws {
        do {
            _ = try await ReadOnlyWorkspace.openExisting(path: path)
            XCTFail("expected a thrown error")
        } catch let error as WorkspaceError {
            guard case .Open = error else {
                return XCTFail("expected .open, got \(error)")
            }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testReadOnlyHandleSeesTheAppsWrites() async throws {
        let workspace = try await Workspace.open(path: path)
        _ = try await workspace.createPage(
            page: NewPage(title: "Visible"))

        let reader = try await ReadOnlyWorkspace.openExisting(path: path)
        let pages = try await reader.listPages(query: PageQuery())
        XCTAssertEqual(pages.map(\.title), ["Visible"])
    }

    /// A widget refresh and a foreground query must be able to overlap.
    func testConcurrentReadsComplete() async throws {
        let workspace = try await Workspace.open(path: path)
        for index in 0..<5 {
            _ = try await workspace.createPage(
                page: NewPage(title: "Page \(index)"))
        }

        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    try await workspace.listPages(query: PageQuery()).count
                }
            }
            for try await count in group {
                XCTAssertEqual(count, 5)
            }
        }
    }
}
