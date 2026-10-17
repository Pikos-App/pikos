import XCTest

@testable import PikosSupport

final class CurrentPaletteColorTests: XCTestCase {
    func testAFolderStoredWithTheOldRedIsDrawnWithTheNewOneInEitherCase() {
        XCTAssertEqual(CurrentPaletteColor.of("#E5534B"), "#D9577A")
        XCTAssertEqual(CurrentPaletteColor.of("#e5534b"), "#D9577A")
    }

    func testAnyOtherColourAndNoColourPassThrough() {
        XCTAssertEqual(CurrentPaletteColor.of("#539BF5"), "#539BF5")
        XCTAssertNil(CurrentPaletteColor.of(nil))
    }
}
