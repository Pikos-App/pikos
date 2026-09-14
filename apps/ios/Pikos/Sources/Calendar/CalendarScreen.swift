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
///
/// Moving through time is a swipe, which is what a thumb tries first on any
/// calendar; the chevrons stay for the people who cannot swipe and the ones
/// who would rather not. The title is a menu: today, any date, and the span.
struct CalendarScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(SettingsStore.self) private var settings
    @Environment(\.horizontalSizeClass) private var widthClass

    @State private var anchor = Date()
    @State private var span: CalendarSpan?
    @State private var entries: [CalendarEntry] = []
    /// False until the first range has arrived. Only that first wait shows a
    /// spinner; every later one keeps the grid up while the next range loads,
    /// so paging through weeks does not flash to a blank between each.
    @State private var hasLoaded = false
    @State private var now = WallClockDay.instant(from: Date())
    @State private var moving: Moving?
    @State private var actions = PageActionState()
    @State private var isDatePickerPresented = false
    /// Which way the last step went, so the grid slides in from that side.
    @State private var steppedForward = true

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

    /// The reader's calendar with their week-start preference applied. Every
    /// piece of date arithmetic here goes through it — a week that started on
    /// Sunday in the grid while the setting said Monday was exactly the bug
    /// `Calendar.current` invites.
    private var calendar: Calendar { settings.calendar }

    private var days: [Date] { effectiveSpan.days(anchoredOn: anchor, calendar: calendar) }
    private var dayStrings: [String] { days.map(WallClockDay.string(from:)) }

    private var reloadKey: String {
        dayStrings.joined(separator: ",") + "#\(store.dataVersion)"
    }

    var body: some View {
        VStack(spacing: 0) {
            if !hasLoaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                CalendarGrid(
                    days: dayStrings,
                    entries: entries,
                    now: now,
                    hourHeightBase: settings.calendarDensity.hourHeight,
                    folderColors: folderColors,
                    actions: $actions,
                    onOpen: { pageId in openPage(pageId) },
                    onToggleDone: { entry in
                        Task { await store.setStatus(pageId: entry.pageId, done: entry.status != "done") }
                    },
                    onComplete: { entry in Task { await store.completeOccurrence(entry) } },
                    onSkip: { entry in Task { await store.skipOccurrence(entry) } },
                    onMove: { entry in moving = Moving(entry: entry) }
                )
                // A new identity per range is what lets the grid slide rather
                // than redraw in place when the user pages.
                .id(dayStrings.first ?? "")
                .transition(.push(from: steppedForward ? .trailing : .leading))
            }
        }
        .animation(.snappy, value: dayStrings.first)
        // The swipe below is a gesture VoiceOver does not pass through; the
        // chevrons remain, and these put the same two moves on the rotor so
        // the grid itself can be paged without hunting for them.
        .accessibilityAction(named: "Next \(effectiveSpan.label.lowercased())") { step(by: 1) }
        .accessibilityAction(named: "Previous \(effectiveSpan.label.lowercased())") { step(by: -1) }
        // A horizontal swipe pages the range; a vertical one still scrolls the
        // hours, because the grid's own scroll view fails a pan that is mostly
        // sideways and this one ignores a pan that is mostly up-and-down.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    let dx = value.translation.width
                    let dy = value.translation.height
                    guard abs(dx) > 60, abs(dx) > abs(dy) * 1.5 else { return }
                    step(by: dx < 0 ? 1 : -1)
                }
        )
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle(title)
        .toolbarTitleMenu { titleMenu }
        .toolbar { toolbar }
        .sheet(item: $moving) { MoveOccurrenceSheet(entry: $0.entry) }
        .sheet(isPresented: $isDatePickerPresented) { datePickerSheet }
        .pageActionSheets($actions)
        // Keyed on the range *and* on the workspace's version. The range half
        // means swiping to another week cancels the query for the one being
        // left rather than racing it. The version half means a page completed
        // in the editor is not still sitting there undone when the user comes
        // back — the calendar's data is not `store.pages`, so it has nothing
        // else to observe.
        .task(id: reloadKey) {
            now = WallClockDay.instant(from: Date())
            entries = await store.calendarRange(
                from: dayStrings.first ?? "", to: dayStrings.last ?? "")
            hasLoaded = true
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { now = WallClockDay.instant(from: Date()) }
        }
    }

    // MARK: - Navigation between ranges

    private func step(by spans: Int) {
        steppedForward = spans > 0
        anchor = effectiveSpan.step(anchor, by: spans, calendar: calendar)
    }

    private func goToToday() {
        steppedForward = Date() > anchor
        anchor = Date()
    }

    /// Opening a page from the calendar goes through the same stack the list
    /// uses. A virtual occurrence opens its head page — editing one occurrence
    /// on its own would have to materialise a row first, which is a feature and
    /// not a side effect of tapping.
    private func openPage(_ pageId: String) {
        route.calendarPath = [pageId]
    }

    /// The folder colours, keyed by folder id, for the grid to tint blocks by.
    ///
    /// Computed here from the store's folders rather than looked up per block
    /// in the grid, which draws a hundred blocks a week and should not search a
    /// list for each.
    private var folderColors: [String: Color] {
        var colors: [String: Color] = [:]
        for folder in store.folders {
            if let color = Color(hex: folder.color) { colors[folder.id] = color }
        }
        return colors
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

    // MARK: - Title and toolbar

    private var title: String {
        guard let first = days.first, let last = days.last else { return String(localized: "Calendar") }
        if effectiveSpan == .day {
            return first.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        let sameMonth = calendar.isDate(first, equalTo: last, toGranularity: .month)
        let start = first.formatted(.dateTime.month(.abbreviated).day())
        let end =
            sameMonth
            ? last.formatted(.dateTime.day())
            : last.formatted(.dateTime.month(.abbreviated).day())
        return "\(start) – \(end)"
    }

    /// Under the title: where to go, and how much to show.
    @ViewBuilder
    private var titleMenu: some View {
        Button {
            goToToday()
        } label: {
            Label("Go to Today", systemImage: "sun.max")
        }
        .disabled(showsToday)
        Button {
            isDatePickerPresented = true
        } label: {
            Label("Go to Date…", systemImage: "calendar")
        }
        Divider()
        Picker("Show", selection: spanBinding) {
            ForEach(CalendarSpan.allCases) { option in
                Text(option.label).tag(option)
            }
        }
        .pickerStyle(.inline)
    }

    /// One button. Paging is the swipe, or the rotor for anyone who cannot
    /// swipe; the chevrons that used to flank the title left "Sep 14 – 20"
    /// truncating on an inline bar, and the one thing worth a tap of its own
    /// is the way back to today.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button("Today") { goToToday() }
                .disabled(showsToday)
        }
    }

    /// A month at a time, for jumping further than a swipe wants to.
    private var datePickerSheet: some View {
        NavigationStack {
            DatePicker(
                "Go to",
                selection: Binding(
                    get: { anchor },
                    set: { chosen in
                        steppedForward = chosen > anchor
                        anchor = chosen
                    }),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
            .padding(.horizontal)
            .navigationTitle("Go to Date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isDatePickerPresented = false }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
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
