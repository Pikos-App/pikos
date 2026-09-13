import XCTest

@testable import PikosCore

/// Tests for the workspace binding as Swift sees it.
///
/// The Rust side has its own tests for the translation layer. These cover what
/// those cannot: that the async bridge actually suspends and resumes correctly,
/// that errors surface as thrown Swift errors, and that the read-only handle is
/// read-only in a way the compiler enforces rather than the documentation.
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

    /// A deleted page's id can outlive it — in a widget's timeline, a deep
    /// link, a restored navigation state. The caller has to tell that apart
    /// from a database that is broken, so it arrives as a distinct case.
    func testMissingPageThrowsNotFound() async throws {
        let workspace = try await Workspace.open(path: path)
        do {
            _ = try await workspace.getPage(id: "nope")
            XCTFail("expected a thrown error")
        } catch let error as WorkspaceError {
            guard case .notFound(let entity, let id) = error else {
                return XCTFail("expected notFound, got \(error)")
            }
            XCTAssertEqual(entity, "page")
            XCTAssertEqual(id, "nope")
        }
    }

    /// The editor's save path: hand back the document and its extracted text
    /// together, so the search index never lags the content.
    func testSavingContentAlsoStampsTheSchemaVersion() async throws {
        let workspace = try await Workspace.open(path: path)
        let page = try await workspace.createPage(
            page: NewPage(title: "Doc"))

        let saved = try await workspace.updatePage(
            id: page.id,
            edit: PageEdit(content: #"{"type":"doc","content":[]}"#, contentText: ""))

        XCTAssertEqual(saved.contentSchemaVersion, workspace.contentSchemaVersion())
    }

    /// iOS must refuse to save over a document written by a newer editor:
    /// re-serialising through an older schema silently drops node types it
    /// cannot represent. This is the check the app is expected to make.
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
                content: #"{"type":"doc"}"#, contentText: "the quick brown fox"))

        let hits = try await workspace.search(query: "brown", limit: 10)
        XCTAssertEqual(hits.map(\.pageId), [page.id])
    }

    /// A widget must never create an empty workspace — to the user that looks
    /// exactly like their notes disappearing.
    func testReadOnlyOpenRefusesToCreateADatabase() async throws {
        do {
            _ = try await ReadOnlyWorkspace.openExisting(path: path)
            XCTFail("expected a thrown error")
        } catch let error as WorkspaceError {
            guard case .open = error else {
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

    /// Concurrent reads must not serialise behind one another. The runtime is
    /// multi-threaded precisely so a widget refresh and a foreground query can
    /// overlap; if this ever deadlocks, that is the reason to look at.
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
