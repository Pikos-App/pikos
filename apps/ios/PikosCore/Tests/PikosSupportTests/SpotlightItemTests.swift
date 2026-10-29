import CoreSpotlight
import PikosCore
import XCTest

@testable import PikosSupport

final class SpotlightItemTests: XCTestCase {
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

    // qa: IOS-43
    func testADatedPageInAFolderIsIndexedByTitleWithItsFolderAndDayAndNoneOfItsBody() async throws {
        let workspace = try await Workspace.open(path: path)
        let folder = try await workspace.createFolder(name: "Health", color: nil)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'09:00:00"
        let page = try await workspace.createPage(
            page: NewPage(title: "Dentist", folderId: folder.id, scheduledStart: formatter.string(from: Date())))
        _ = try await workspace.updatePage(
            id: page.id,
            edit: PageEdit(
                content: #"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"molar filling on the left"}]}]}"#))

        let changes = try await workspace.indexChanges(since: nil)
        let summary = try XCTUnwrap(changes.pages.first { $0.id == page.id })
        let attributes = SpotlightItem.make(for: summary, folderName: folder.name).attributeSet

        XCTAssertEqual(attributes.title, "Dentist")
        XCTAssertEqual(attributes.contentDescription, "Health · Today", "the folder and the day sit under the title")
        let indexed = [attributes.title, attributes.contentDescription, attributes.textContent]
            .compactMap { $0 } + (attributes.keywords ?? [])
        XCTAssertFalse(indexed.contains { $0.contains("molar") }, "nothing from the body is indexed")
    }
}
