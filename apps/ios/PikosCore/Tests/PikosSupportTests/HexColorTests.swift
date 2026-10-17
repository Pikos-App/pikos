import SwiftUI
import XCTest

@testable import PikosSupport

/// Parsing a palette value into a colour.
///
/// Small enough to look untestable, which is why it is worth pinning: every
/// wrong answer here is a *plausible-looking* colour. A parser that shrugs and
/// returns black turns one mistyped character in the palette into a folder dot
/// that reads as a deliberate choice, and nothing anywhere reports it.
final class HexColorTests: XCTestCase {
    /// The channels have to come out in the right order and at the right
    /// magnitude. A shift or a mask one bit out still produces a colour.
    func testEachChannelIsReadFromItsOwnByte() {
        let cases: [(hex: String, red: Double, green: Double, blue: Double)] = [
            ("#FF0000", 1, 0, 0),
            ("#00FF00", 0, 1, 0),
            ("#0000FF", 0, 0, 1),
            ("#000000", 0, 0, 0),
            ("#FFFFFF", 1, 1, 1),
            // A real palette entry, and an asymmetric one: every channel
            // differs, so a swapped pair is visible.
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

    /// Every shape this deliberately does not accept.
    ///
    /// The three-digit form and an alpha channel are the two a general parser
    /// would take, and taking them is what makes the failure silent: the
    /// workspace only ever serves `#RRGGBB`, so anything else reaching here is
    /// a value from somewhere it should not have come from.
    func testAnythingThatIsNotSixHexDigitsIsRefused() {
        for value in ["", "#", "#FFF", "#FFFFFFFF", "#GGGGGG", "red", "#12345", "#1234567"] {
            XCTAssertNil(Color(hex: value), "\(value) should not parse")
        }
    }

    /// An uncoloured folder passes `nil` straight through, so no call site
    /// needs its own check.
    func testNilStaysNil() {
        XCTAssertNil(Color(hex: nil))
    }

    /// Reads a `Color` back as sRGB channels.
    ///
    /// `Color` has no public accessors, so this goes through the platform
    /// bridge — which is also what proves the value survived into something the
    /// system can actually draw, rather than only into a struct.
    private static func components(_ color: Color) -> (red: Double, green: Double, blue: Double)? {
        let resolved = color.resolve(in: EnvironmentValues())
        return (Double(resolved.red), Double(resolved.green), Double(resolved.blue))
    }
}
