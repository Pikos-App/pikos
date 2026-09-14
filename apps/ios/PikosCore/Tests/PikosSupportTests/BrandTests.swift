import SwiftUI
import XCTest

@testable import PikosSupport

final class BrandTests: XCTestCase {
    /// The accent is written as a hex string because the editor needs it as
    /// one. A typo there would fall back to the system colour in the widget
    /// and be sent verbatim to the editor, which is two different wrongs from
    /// one character — so the string is pinned to the parser's idea of valid.
    func testTheAccentHexParses() {
        XCTAssertNotNil(Color(hex: Brand.accentHex))
        XCTAssertEqual(Brand.accentHex.count, 7)
        XCTAssertTrue(Brand.accentHex.hasPrefix("#"))
    }
}
