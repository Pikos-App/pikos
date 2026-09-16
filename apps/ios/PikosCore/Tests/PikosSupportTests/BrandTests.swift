import SwiftUI
import XCTest

@testable import PikosSupport

final class BrandTests: XCTestCase {
    func testTheEditorLinkHexIsTheReadableTealInEachScheme() {
        XCTAssertEqual(Brand.linkHex(dark: false), "#117A60")
        XCTAssertEqual(Brand.linkHex(dark: true), "#2DD4A8")
        XCTAssertNotNil(Color(hex: Brand.linkHex(dark: false)))
    }

    func testATokenKeepsItsAlphaChannel() {
        let (_, _, _, alpha) = TokenColor.components(PikosToken.surfaceSelected.light)
        XCTAssertEqual(alpha, 0.102, accuracy: 0.001)
    }
}
