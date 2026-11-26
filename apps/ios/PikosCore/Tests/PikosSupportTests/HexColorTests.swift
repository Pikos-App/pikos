import SwiftUI
import XCTest

@testable import PikosSupport

/// Every wrong answer here is a plausible-looking colour, and nothing reports it.
final class HexColorTests: XCTestCase {
    /// A shift or mask one bit out still produces a colour.
    func testEachChannelIsReadFromItsOwnByte() {
        let cases: [(hex: String, red: Double, green: Double, blue: Double)] = [
            ("#FF0000", 1, 0, 0),
            ("#00FF00", 0, 1, 0),
            ("#0000FF", 0, 0, 1),
            ("#000000", 0, 0, 0),
            ("#FFFFFF", 1, 1, 1),
            // Every channel differs, so a swapped pair is visible.
            ("#539BF5", 83 / 255, 155 / 255, 245 / 255),
        ]
        for (hex, red, green, blue) in cases {
            guard let components = Color(hex: hex).flatMap(Self.components) else {
                return XCTFail("\(hex) should parse")
            }
            XCTAssertEqual(components.red, red, accuracy: 0.001, "\(hex) red")
            XCTAssertEqual(components.green, green, accuracy: 0.001, "\(hex) green")
            XCTAssertEqual(components.blue, blue, accuracy: 0.001, "\(hex) blue")
        }
    }

    func testTheLeadingHashIsOptional() {
        XCTAssertEqual(
            Self.components(Color(hex: "539BF5")!)?.red,
            Self.components(Color(hex: "#539BF5")!)?.red)
    }

    func testLowercaseParsesTheSameAsUppercase() {
        XCTAssertEqual(
            Self.components(Color(hex: "#e8a6a1")!)?.green,
            Self.components(Color(hex: "#E8A6A1")!)?.green)
    }

    func testAnythingThatIsNotSixHexDigitsIsRefused() {
        for value in ["", "#", "#FFF", "#FFFFFFFF", "#GGGGGG", "red", "#12345", "#1234567"] {
            XCTAssertNil(Color(hex: value), "\(value) should not parse")
        }
    }

    func testNilStaysNil() {
        XCTAssertNil(Color(hex: nil))
    }

    /// `Color` has no public accessors, so this resolves it through the environment.
    private static func components(_ color: Color) -> (red: Double, green: Double, blue: Double)? {
        let resolved = color.resolve(in: EnvironmentValues())
        return (Double(resolved.red), Double(resolved.green), Double(resolved.blue))
    }
}
