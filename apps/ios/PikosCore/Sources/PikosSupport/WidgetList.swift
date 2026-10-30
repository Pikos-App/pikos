import Foundation
import PikosCore

/// A list the List widget can show, read the way the app's views read it.
///
/// Here rather than in the widget extension so a host test can open a real workspace and read
/// exactly what the widget would: no test target builds the extension.
public enum WidgetList: Equatable, Sendable {
    case today
    case upcoming
    case inbox
    case folder(id: String)

    /// The open pages the widget draws, in its order. Upcoming is the next seven days in time
    /// order; its bounds are inclusive strings, so the upper one is the day after the last day wanted.
    public func openPages(in workspace: ReadOnlyWorkspace) async throws -> [PageSummary] {
        switch self {
        case .today:
            return try await workspace.listToday()
        case .upcoming:
            let query = PageQuery(
                scheduledAfter: Self.day(offset: 1), scheduledBefore: Self.day(offset: 8), hasSchedule: true,
                openOnly: true)
            return try await workspace.listPages(query: query)
                .sorted { PageSort.instant(of: $0.scheduledStart ?? "") < PageSort.instant(of: $1.scheduledStart ?? "") }
        case .inbox:
            return try await workspace.listPages(query: PageQuery(folder: .inbox, openOnly: true))
        case .folder(let id):
            return try await workspace.listPages(query: PageQuery(folder: .folder(id: id), openOnly: true))
        }
    }

    /// A ring's tick, written from the widget's own process; `CompletePageIntent` says why that is safe.
    public static func setDone(_ done: Bool, pageId: String, workspaceAt path: String) async throws {
        let workspace = try await Workspace.open(path: path)
        try await workspace.setPageStatus(pageId: pageId, done: done)
    }

    private static func day(offset days: Int) -> String {
        let now = Date()
        let target = Calendar.current.date(byAdding: .day, value: days, to: now) ?? now
        return DayLabel.today(now: target)
    }
}
