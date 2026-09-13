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
    @Environment(SettingsStore.self) private var settings
    @Environment(\.horizontalSizeClass) private var widthClass

    @State private var anchor = Date()
    @State private var span: CalendarSpan?
    @State private var entries: [CalendarEntry] = []
    @State private var isLoading = true
    @State private var now = WallClockDay.instant(from: Date())
    @State private var undo: SkippedOccurrence?
    @State private var moving: Moving?

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
                    hourHeightBase: settings.calendarDensity.hourHeight,
                    onOpen: { pageId in openPage(pageId) },
                    onComplete: { entry in Task { await store.completeOccurrence(entry) } },
                    onSkip: { entry in Task { await skip(entry) } },
                    onMove: { entry in moving = Moving(entry: entry) })
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .overlay(alignment: .bottom) { undoBar }
        .sheet(item: $moving) { MoveOccurrenceSheet(entry: $0.entry) }
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

    // MARK: - Acting on one occurrence

    /// The occurrence whose move sheet is open.
    ///
    /// A wrapper because `sheet(item:)` needs `Identifiable` and the generated
    /// records are not. `key` is the identity being borrowed — it is distinct
    /// per drawn occurrence, which `page_id` deliberately is not.
    private struct Moving: Identifiable {
        let entry: CalendarEntry
        var id: String { entry.key }
    }


    /// What was skipped, for as long as it can be put back.
    private struct SkippedOccurrence: Equatable {
        let pageId: String
        let date: String
        let title: String
    }

    private func skip(_ entry: CalendarEntry) async {
        guard let date = await store.skipOccurrence(entry) else { return }
        undo = SkippedOccurrence(
            pageId: entry.pageId, date: date,
            title: entry.title.isEmpty ? "Untitled" : entry.title)
    }

    /// The way back, and the reason skipping asks for no confirmation.
    ///
    /// A confirmation before every skip would make the common case — clearing
    /// one week's standup — two taps and a decision, for something that destroys
    /// nothing. An undo afterwards costs nothing when it is not wanted, which is
    /// almost always.
    ///
    /// It clears itself on a timer rather than waiting to be dismissed, because
    /// a bar that sits over the last hour of the day until somebody notices it
    /// is worse than a missed undo: the skip is reversible from the desktop for
    /// as long as the series exists.
    @ViewBuilder
    private var undoBar: some View {
        if let undo {
            HStack {
                Text("Skipped \(undo.title)")
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 12)
                Button("Undo") {
                    Task {
                        await store.unskipOccurrence(pageId: undo.pageId, on: undo.date)
                        self.undo = nil
                    }
                }
                .font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .shadow(radius: 6, y: 2)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            // Keyed on the occurrence, so skipping a second one restarts the
            // countdown instead of inheriting the first one's remaining time.
            .task(id: undo) {
                try? await Task.sleep(for: .seconds(6))
                guard !Task.isCancelled else { return }
                withAnimation(.snappy) { self.undo = nil }
            }
        }
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
