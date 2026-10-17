import UniformTypeIdentifiers
import XCTest

@testable import PikosSupport

final class AssetNameTests: XCTestCase {
    func testTheWebFormatsAreKeptAsTheyAre() {
        XCTAssertEqual(AssetName.storableExtension(for: [.jpeg]), "jpg")
        XCTAssertEqual(AssetName.storableExtension(for: [.png]), "png")
        XCTAssertEqual(AssetName.storableExtension(for: [.gif]), "gif")
    }

    func testAnythingElseIsReencoded() {
        XCTAssertNil(AssetName.storableExtension(for: [.heic]))
        XCTAssertNil(AssetName.storableExtension(for: [.tiff, .bmp]))
        XCTAssertNil(AssetName.storableExtension(for: []))
    }

    /// A photo offered as both keeps the one every renderer can show.
    func testAKeepableTypeWinsWhereverItSitsInTheList() {
        XCTAssertEqual(AssetName.storableExtension(for: [.heic, .jpeg]), "jpg")
    }

    func testFreshNamesAreDistinctAndCarryTheExtension() {
        let first = AssetName.fresh(extension: "jpg")
        let second = AssetName.fresh(extension: "jpg")
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(first.hasSuffix(".jpg"))
        XCTAssertFalse(first.contains("/"), "a name, not a path")
    }
}
