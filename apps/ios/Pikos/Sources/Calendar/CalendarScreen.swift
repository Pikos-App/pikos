import PikosCore
import PikosSupport
import SwiftUI

/// The calendar.
///
/// Owns one question — which days are on screen — and asks the workspace for
/// everything to draw on them. It holds no `NavigationStack` of its own, like
/// the other screens: the shell owns navigation, so this can sit in a tab's
/// stack on a phone and in a split view's detail column on iPad without
/// changing.
///
/// The span defaults by width class and is then the user's to change. A week on
/// a phone is cramped but perfectly usable when someone deliberately asks for
/// it, and an iPad in a narrow split view is a phone-shaped screen on a large
/// device — so the width class picks the *default*, never the options.
struct CalendarScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(\.horizontalSizeClass) private var widthClass

    @State private var anchor = Date()
    @State private var span: CalendarSpan?
    @State private var entries: [CalendarEntry] = []
    @State private var isLoading = true
    @State private var now = WallClockDay.instant(from: Date())

    /// Moves the current-time line without a timer.
    ///
    /// A calendar left open is usually a calendar in the background. Re-reading
    /// the clock on the way back to the foreground covers the case that
    /// matters — coming back to a line an hour out of date — where a ticking
    /// timer would spend battery all day to fix a line nobody is looking at.
    @Environment(\.scenePhase) private var scenePhase

    private var effectiveSpan: CalendarSpan {
        span ?? .default(isCompactWidth: widthClass == .compact)
    }

    private var days: [Date] { effectiveSpan.days(anchoredOn: anchor) }
    private var dayStrings: [String] { days.map(WallClockDay.string(from:)) }

    private var reloadKey: String {
        dayStrings.joined(separator: ",") + "#\(store.dataVersion)"
    }

    var body: some View {
        VStack(spacing: 0) {
            if isLoading && entries.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                CalendarGrid(
                    days: dayStrings,
                    entries: entries,
                    now: now,
                    onOpen: { pageId in openPage(pageId) })
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        // Keyed on the range *and* on the workspace's version. The range half
        // means swiping to another week cancels the query for the one being
        // left rather than racing it. The version half means a page completed
        // in the editor is not still sitting there undone when the user comes
        // back — the calendar's data is not `store.pages`, so it has nothing
        // else to observe.
        .task(id: reloadKey) {
            isLoading = true
            now = WallClockDay.instant(from: Date())
            entries = await store.calendarRange(
                from: dayStrings.first ?? "", to: dayStrings.last ?? "")
            isLoading = false
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { now = WallClockDay.instant(from: Date()) }
        }
    }

    // MARK: - Navigation between ranges

    /// Opening a page from the calendar goes through the same stack the list
    /// uses. A virtual occurrence opens its head page — editing one occurrence
    /// on its own would have to materialise a row first, which is a feature and
    /// not a side effect of tapping.
    private func openPage(_ pageId: String) {
        route.calendarPath = [pageId]
    }

    private var title: String {
        guard let first = days.first, let last = days.last else { return "Calendar" }
        if effectiveSpan == .day {
            return first.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        let sameMonth = Calendar.current.isDate(first, equalTo: last, toGranularity: .month)
        let start = first.formatted(.dateTime.month(.abbreviated).day())
        let end =
            sameMonth
            ? last.formatted(.dateTime.day())
            : last.formatted(.dateTime.month(.abbreviated).day())
        return "\(start) – \(end)"
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button {
                anchor = effectiveSpan.step(anchor, by: -1)
            } label: {
                Label("Previous", systemImage: "chevron.left")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Today") { anchor = Date() }
                .disabled(showsToday)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                anchor = effectiveSpan.step(anchor, by: 1)
            } label: {
                Label("Next", systemImage: "chevron.right")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("Span", selection: spanBinding) {
                    ForEach(CalendarSpan.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
            } label: {
                Label("Span", systemImage: "calendar.day.timeline.left")
            }
        }
    }

    /// True when today is already on screen, which is when "Today" would do
    /// nothing. Disabled rather than hidden so the toolbar does not reflow as
    /// the user pages back and forth.
    private var showsToday: Bool {
        dayStrings.contains(WallClockDay.string(from: Date()))
    }

    private var spanBinding: Binding<CalendarSpan> {
        Binding(get: { effectiveSpan }, set: { span = $0 })
    }
}
