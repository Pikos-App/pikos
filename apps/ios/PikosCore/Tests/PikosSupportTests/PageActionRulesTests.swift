import Foundation
import PikosSupport
import XCTest

final class PageActionRulesTests: XCTestCase {
    private struct Case: Decodable {
        struct Page: Decodable {
            let isRecurring: Bool
            let scheduleLocked: Bool
            let hasDate: Bool
        }
        let name: String
        let page: Page
        let actsOn: Int
        let expect: [String: String]
    }

    func testAnswersAsTheDesktopsMenuDoes() throws {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let table = repo.appendingPathComponent("packages/core/src/pages/pageActions.cases.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: table))
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            var answers: [String: String] = [:]
            for action in PageActionRules.Action.allCases {
                answers[action.rawValue] = PageActionRules.answer(
                    action, isRecurring: c.page.isRecurring, scheduleLocked: c.page.scheduleLocked,
                    hasDate: c.page.hasDate, actsOn: c.actsOn)
            }
            XCTAssertEqual(answers, c.expect, c.name)
        }
    }
}
