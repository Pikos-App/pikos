import PikosCore
import XCTest

@testable import PikosSupport

final class WidgetListTests: XCTestCase {
    private var path: String!

    override func setUpWithError() throws {
        path = FileManager.default.temporaryDirectory
            .appendingPathComponent("pikos-\(UUID().uuidString).db")
            .path
    }

    override func tearDownWithError() throws {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: path + suffix)
        }
    }

    // qa: IOS-50
    func testAPageAddedForTodayIsInTheNextReadOfTheListWidgetsToday() async throws {
        let workspace = try await Workspace.open(path: path)
        _ = try await workspace.createPage(page: NewPage(title: "Dentist", scheduledStart: DayLabel.today()))

        let widget = try await ReadOnlyWorkspace.openExisting(path: path)
        let titles = try await WidgetList.today.openPages(in: widget).map(\.title)

        XCTAssertEqual(titles, ["Dentist"])
    }

    // qa: IOS-41:2
    func testTickingARingTakesItsPageOutOfTheNextReadAndLeavesTheOthers() async throws {
        let workspace = try await Workspace.open(path: path)
        let dentist = try await workspace.createPage(page: NewPage(title: "Dentist", scheduledStart: DayLabel.today()))
        _ = try await workspace.createPage(page: NewPage(title: "Call mom", scheduledStart: DayLabel.today()))

        try await WidgetList.setDone(true, pageId: dentist.id, workspaceAt: path)

        let widget = try await ReadOnlyWorkspace.openExisting(path: path)
        let titles = try await WidgetList.today.openPages(in: widget).map(\.title)
        XCTAssertEqual(titles, ["Call mom"])
    }

    // qa: LIST-21
    func testUpcomingPutsADaysAllDayPageAfterItsTimedPages() async throws {
        let workspace = try await Workspace.open(path: path)
        let tomorrow = DayLabel.today(now: Calendar.current.date(byAdding: .day, value: 1, to: Date())!)
        _ = try await workspace.createPage(page: NewPage(title: "Bins out", scheduledStart: tomorrow))
        _ = try await workspace.createPage(page: NewPage(title: "Dentist", scheduledStart: tomorrow + "T09:00:00"))

        let widget = try await ReadOnlyWorkspace.openExisting(path: path)
        let titles = try await WidgetList.upcoming.openPages(in: widget).map(\.title)

        XCTAssertEqual(titles, ["Dentist", "Bins out"])
    }
}
