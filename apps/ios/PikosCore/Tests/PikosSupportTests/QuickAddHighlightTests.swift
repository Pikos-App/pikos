import PikosSupport
import XCTest

final class QuickAddHighlightTests: XCTestCase {
    private func read(_ line: String, title: String) -> [(String, QuickAddHighlight.Kind)] {
        QuickAddHighlight.tokens(in: line, title: title).map { (String(line[$0.range]), $0.kind) }
    }

    func testTheWordsTheParserTookAreMarkedByWhatTheyAre() {
        let tokens = read("Call the dentist tomorrow at 3pm !high #health ~Personal", title: "Call the dentist")
        XCTAssertEqual(tokens.map(\.0), ["tomorrow", "at", "3pm", "!high", "#health", "~Personal"])
        XCTAssertEqual(tokens.map(\.1), [.when, .when, .when, .priority, .tag, .folder])
    }

    func testAMarkerInTheMiddleOfTheTitleIsFoundWhereItWasTyped() {
        let tokens = read("Buy #home milk", title: "Buy milk")
        XCTAssertEqual(tokens.map(\.0), ["#home"])
    }

    func testATitleWordThatRepeatsADateWordIsNotMarked() {
        let tokens = read("Plan tomorrow tomorrow", title: "Plan tomorrow")
        XCTAssertEqual(tokens.count, 1)
        XCTAssertEqual(tokens.first?.1, .when)
    }

    func testCaseDoesNotHideATitleWord() {
        XCTAssertEqual(read("call Mom today", title: "Call mom").map(\.0), ["today"])
    }

    func testEverythingAfterTheNoteMarkerIsTheNote() {
        let tokens = read("Groceries today // eggs, milk", title: "Groceries")
        XCTAssertEqual(tokens.map(\.0), ["today", "// eggs, milk"])
        XCTAssertEqual(tokens.map(\.1), [.when, .note])
    }

    func testALineTheParserLeftAloneHasNothingMarked() {
        XCTAssertTrue(read("Water the plants", title: "Water the plants").isEmpty)
        XCTAssertTrue(read("", title: "").isEmpty)
    }

    func testRemovingTheDateKeepsEverythingElseAsTyped() {
        let line = "Call the dentist tomorrow at 3pm #health // ask  about the bill"
        XCTAssertEqual(
            QuickAddHighlight.removingWhen(from: line, title: "Call the dentist"),
            "Call the dentist #health // ask  about the bill")
    }

    func testALineThatWasOnlyADateBecomesEmpty() {
        XCTAssertEqual(QuickAddHighlight.removingWhen(from: "today ", title: ""), "")
        XCTAssertEqual(QuickAddHighlight.removingWhen(from: "today at 3pm #home ", title: ""), "#home ")
    }

    func testALineWithNoDateIsLeftAlone() {
        XCTAssertEqual(QuickAddHighlight.removingWhen(from: "Buy milk #home", title: "Buy milk"), "Buy milk #home")
    }
}
