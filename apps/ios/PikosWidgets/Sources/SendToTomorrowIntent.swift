import AppIntents
import PikosCore
import PikosSupport
import WidgetKit

/// Move a page to tomorrow from the widget, keeping its time and length, as the app's swipe does.
///
/// A write from the widget's own process, safe for the reasons `CompletePageIntent` gives.
struct SendToTomorrowIntent: AppIntent {
    static let title: LocalizedStringResource = "Move page to tomorrow"
    static let description = IntentDescription("Move a page in Pikos to tomorrow.", categoryName: "Pages")
    static let isDiscoverable = false

    @Parameter(title: "Page")
    var pageId: String

    init() {}

    init(pageId: String) {
        self.pageId = pageId
    }

    /// A repeating page's date belongs to its rule and a calendar's page to the calendar, so the
    /// widget doesn't offer the move on either.
    static func canMove(_ page: PageSummary) -> Bool {
        !page.isRecurring && !page.scheduleLocked
    }

    func perform() async throws -> some IntentResult {
        let url = try WorkspaceLocation.databaseURL()
        let workspace = try await Workspace.open(path: url.path)
        let page = try await workspace.getPage(id: pageId)
        let moved = ScheduleShift.move(
            start: page.scheduledStart, end: page.scheduledEnd, toDay: WhenChoice.tomorrow.day())
        _ = try await workspace.setPageSchedule(
            pageId: pageId, scheduledStart: moved.start, scheduledEnd: moved.end)
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
