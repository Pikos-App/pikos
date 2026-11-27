import PikosCore
import XCTest

@testable import PikosSupport

final class FailureTextTests: XCTestCase {
    func testAWorkspaceFailureSaysWhatWasBeingDoneAndTheMessageItCarried() {
        let notice = FailureNotice(doing: "save the page", error: WorkspaceError.Database(message: "database is locked"))

        XCTAssertEqual(notice.title, "Couldn't save the page")
        XCTAssertEqual(notice.message, "database is locked")
    }

    func testNoWorkspaceFailureShowsTheSwiftTypeOrCaseName() {
        let errors: [WorkspaceError] = [
            .Open(message: "a"), .NotFound(entity: "page", id: "p1"), .Database(message: "b"), .ReadOnly,
            .InvalidInput(message: "c"), .Refused(message: "d"), .Network(message: "e"),
            .MadeByAnotherBuild(message: "f"), .TooNew,
        ]

        for error in errors {
            let message = FailureText.message(error)
            XCTAssertFalse(message.contains("WorkspaceError"), message)
            XCTAssertFalse(message.contains(error.kind + "("), message)
        }
        XCTAssertEqual(FailureText.message(WorkspaceError.NotFound(entity: "page", id: "p1")), "That page no longer exists.")
    }

    func testTheLogKindNamesTheCaseAndLeavesTheMessageOut() {
        XCTAssertEqual(FailureText.kind(WorkspaceError.Refused(message: "the tag Therapy")), "WorkspaceError.Refused")
        XCTAssertEqual(FailureText.kind(CocoaError(.fileWriteOutOfSpace)), "NSCocoaErrorDomain 640")
    }

    func testAnyOtherErrorKeepsTheSystemsMessage() {
        let error = CocoaError(.fileWriteOutOfSpace)

        XCTAssertEqual(FailureText.message(error), error.localizedDescription)
    }
}
