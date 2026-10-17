import PikosSupport
import XCTest

final class SearchHighlightTests: XCTestCase {
    private func marked(_ text: String, _ terms: [String]) -> [String] {
        SearchHighlight.ranges(in: text, terms: terms).map { String(text[$0]) }
    }

    func testEveryOccurrenceOfATermIsMarkedWhateverItsCase() {
        XCTAssertEqual(marked("Plan the plan, PLAN", ["plan"]), ["Plan", "plan", "PLAN"])
    }

    func testATermInsideALongerWordIsMarkedBecauseTheLastTermIsAPrefix() {
        XCTAssertEqual(marked("Morning pages", ["morn"]), ["Morn"])
    }

    func testOverlappingTermsBecomeOneMark() {
        XCTAssertEqual(marked("Dentistry", ["dent", "denti"]), ["Denti"])
    }

    func testAccentsDoNotHideAMatch() {
        XCTAssertEqual(marked("Café notes", ["cafe"]), ["Café"])
    }

    func testNoTermsMarkNothing() {
        XCTAssertEqual(marked("Anything", []), [])
        XCTAssertEqual(marked("Anything", [""]), [])
    }

    func testAPassageLeadsInCloseToItsMatchAtAWordBoundary() {
        let passage = "…Assembly: weekend after delivery\nMeasure the alcove\nOrder the desktop top"
        XCTAssertEqual(
            SearchHighlight.leadIn(passage, terms: ["desk"]), "…the alcove · Order the desktop top")
    }

    func testAPassageWhoseMatchIsAlreadyNearTheStartIsOnlyFlattened() {
        XCTAssertEqual(
            SearchHighlight.leadIn("Call the  dentist\ntoday", terms: ["dent"]), "Call the dentist · today")
    }

    func testAPassageWithNoMatchIsOnlyFlattened() {
        XCTAssertEqual(SearchHighlight.leadIn("one\n\ntwo", terms: ["zebra"]), "one · two")
    }

    func testTheAttributedFormCarriesTheAttributeOnlyOnTheMatch() {
        let result = SearchHighlight.attributed("call the dentist", terms: ["dent"]) {
            $0.inlinePresentationIntent = .stronglyEmphasized
        }
        let emphasised = result.runs
            .filter { $0.inlinePresentationIntent == .stronglyEmphasized }
            .map { String(result[$0.range].characters) }
        XCTAssertEqual(emphasised, ["dent"])
    }
}
