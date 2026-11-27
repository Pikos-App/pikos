import PikosCore
import PikosSupport
import SwiftUI

/// The week pane.
/// Owns one question, which days are on screen, and asks the workspace for what to draw.
struct CalendarScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(SettingsStore.self) private var settings
    @Environment(\.shellLayout) private var layout

    @State private var entries: [CalendarEntry] = []
    /// False until the first range has arrived. Only that first wait shows a spinner; later ones
    /// keep the grid up while the next range loads, so paging does not flash blank.
    @State private var hasLoaded = false
    @State private var now = WallClockDay.instant(from: Date())
    @State private var moving: Moving?
    @State private var scopeQuestion: ScopeQuestion?
    @State private var actions = PageActionState()
    @State private var isJumping = false
    @State private var steppedForward = true
    /// What the week strip's dots are drawn from: the week around the day on screen, fetched only
    /// in day view.
    @State private var weekEntries: [CalendarEntry] = []

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    /// Moves the current-time line without a timer: a calendar left open is mostly in the
    /// background, so the clock is re-read on return to the foreground, where a ticking timer
    /// would spend battery all day to fix a line nobody sees.
    @Environment(\.scenePhase) private var scenePhase

    private var anchor: Date {
        get { route.calendarAnchor }
        nonmutating set { route.calendarAnchor = newValue }
    }

    private var span: CalendarSpan? {
        get { route.calendarSpan }
        nonmutating set { route.calendarSpan = newValue }
    }

    private var effectiveSpan: CalendarSpan {
        guard let span, CalendarSpan.offered(in: layout).contains(span) else {
            return .default(in: layout)
        }
        return span
    }
    /// The reader's calendar with their week-start preference applied. All date arithmetic here
    /// goes through it: `Calendar.current` ignores the setting, so the grid and the setting
    /// disagreed on the first weekday.
    private var calendar: Calendar { settings.calendar }

    private var days: [Date] { effectiveSpan.days(anchoredOn: anchor, calendar: calendar) }
    private var dayStrings: [String] { days.map(WallClockDay.string(from:)) }

    /// The week the strip shows, in day view. Empty in other spans, where the header does the job.
    private var stripDayStrings: [String] {
        guard effectiveSpan == .day else { return [] }
        return CalendarSpan.week.days(anchoredOn: anchor, calendar: calendar).map(
            WallClockDay.string(from:))
    }

    private var reloadKey: String {
        dayStrings.joined(separator: ",") + "|" + (stripDayStrings.first ?? "")
            + "#\(store.dataVersion)"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack(alignment: .top) {
                calendarBody
                if isJumping { jumpLayer }
            }
        }
        // The grid's gutter, columns and hour rows are fixed geometry: past this size the hour labels
        // broke a letter to a line and the week strip's dates became ellipses.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .pkQuick, value: dayStrings.first)
        // The swipe below is a gesture VoiceOver does not pass through; these put the same two
        // moves on the rotor.
        .accessibilityAction(named: "Next \(effectiveSpan.label.lowercased())") { step(by: 1) }
        .accessibilityAction(named: "Previous \(effectiveSpan.label.lowercased())") { step(by: -1) }
        // A horizontal swipe pages the range; a vertical one still scrolls the hours, because
        // the grid's scroll view fails a mostly sideways pan and this one ignores a mostly
        // vertical one.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    let dx = value.translation.width
                    let dy = value.translation.height
                    guard !isJumping, abs(dx) > 60, abs(dx) > abs(dy) * 1.5 else { return }
                    step(by: dx < 0 ? 1 : -1)
                }
        )
        .background(.surfacePrimary)
        .sheet(item: $moving) { MoveOccurrenceSheet(entry: $0.entry) }
        .confirmationDialog(
            scopeQuestion?.title ?? "", isPresented: hasScopeQuestion,
            titleVisibility: .visible, presenting: scopeQuestion
        ) { question in
            Button(question.justThisOne) { Task { await resolve(question, scope: .one) } }
            Button(question.everything) { Task { await resolve(question, scope: .all) } }
            Button("Cancel", role: .cancel) { scopeQuestion = nil }
        } message: { question in
            Text(question.message)
        }
        .pageActionSheets($actions)
        .animation(reduceMotion ? nil : .pkQuick, value: isJumping)
        .onChange(of: route.weekFocus) { _, focus in
            guard let focus else { return }
            steppedForward = focus > anchor
            anchor = focus
            route.weekFocus = nil
        }
        // Keyed on the range and the workspace version: the range cancels the query for the week
        // being left rather than racing it, and the version refreshes a page completed in the
        // editor, since the calendar's data is not `store.pages`.
        .task(id: reloadKey) {
            now = WallClockDay.instant(from: Date())
            entries = await store.calendarRange(
                from: dayStrings.first ?? "", to: dayStrings.last ?? "")
            hasLoaded = true
            // The strip's week loads after the day: the day is what the reader waits for.
            if let first = stripDayStrings.first, let last = stripDayStrings.last {
                weekEntries = await store.calendarRange(from: first, to: last)
            } else {
                weekEntries = []
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { now = WallClockDay.instant(from: Date()) }
        }
        .onChange(of: route.pane) { _, pane in
            if pane == .week { now = WallClockDay.instant(from: Date()) }
        }
        #if DEBUG
            .onAppear {
                if let requested = ProcessInfo.processInfo.environment["PIKOS_DEMO_SPAN"] {
                    span = CalendarSpan(rawValue: requested)
                }
            }
        #endif
    }

    /// Over the calendar rather than above it, the way the view switcher drops over the list, so
    /// opening it does not shove the days down.
    private var jumpLayer: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                Color.black.opacity(colorScheme == .dark ? 0.5 : 0.16)
                    .ignoresSafeArea(edges: .bottom)
                    .onTapGesture { isJumping = false }
                    .accessibilityHidden(true)
                // Scrolls where the month is taller than the pane, as on a phone on its side.
                ViewThatFits(in: .vertical) {
                    jumpPanel
                    ScrollView { jumpPanel }
                }
                .frame(maxHeight: geometry.size.height - ShellBar.clearance)
                .fixedSize(horizontal: false, vertical: true)
                .background(.surfaceElevated)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(.borderSecondary, lineWidth: 1))
                .shadow(color: .black.opacity(0.14), radius: 24, y: 10)
                .padding(.horizontal, 10)
                .padding(.top, 6)
                .accessibilityAddTraits(.isModal)
            }
        }
        .transition(.opacity)
    }

    @ViewBuilder
    private var calendarBody: some View {
        VStack(spacing: 0) {
            if effectiveSpan == .day, !stripDayStrings.isEmpty {
                WeekStrip(
                    days: stripDayStrings,
                    selected: dayStrings.first ?? "",
                    today: WallClockDay.string(from: Date()),
                    bars: weekBars
                ) { day in
                    guard let chosen = DayLabel.date(from: day, in: calendar) else { return }
                    steppedForward = chosen > anchor
                    anchor = chosen
                }
            }
            if !hasLoaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if effectiveSpan == .month {
                MonthGrid(
                    days: dayStrings,
                    month: String(WallClockDay.string(from: anchor).prefix(7)),
                    today: WallClockDay.string(from: Date()),
                    entries: entries,
                    folderColors: folderColors,
                    calendar: calendar
                ) { day in
                    guard let chosen = DayLabel.date(from: day, in: calendar) else { return }
                    steppedForward = chosen > anchor
                    anchor = chosen
                    span = .day
                }
                .id(dayStrings.first ?? "")
                .transition(
                    reduceMotion ? .opacity : .push(from: steppedForward ? .trailing : .leading))
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
                    onComplete: { entry in Task { await act(.complete, on: entry) } },
                    onSkip: { entry in Task { await act(.skip, on: entry) } },
                    onMove: { entry in moving = Moving(entry: entry) },
                    onCreate: { day, minute, minutes in create(on: day, at: minute, minutes: minutes) },
                    onDrop: { page, day, minute in drop(page, on: day, at: minute) },
                    onDropAllDay: { page, day in dropAllDay(page, on: day) }
                )
                .contentMargins(.bottom, ShellBar.clearance, for: .scrollContent)
                // A new identity per range lets the grid slide rather than redraw in place. A
                // dissolve under Reduce Motion.
                .id(dayStrings.first ?? "")
                .transition(
                    reduceMotion ? .opacity : .push(from: steppedForward ? .trailing : .leading))
            }
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
        route.calendarTopHour = nil
    }

    private var weekBars: [String: [Color]] {
        MonthLayout.byDay(weekEntries, days: stripDayStrings, start: \.scheduledStart, end: \.scheduledEnd)
            .mapValues { entries in
                entries.map { CalendarPalette.tint(folderId: $0.folderId, colors: folderColors) }
            }
    }

    private func drop(_ page: PageFacts, on day: String, at minute: Int) {
        let dropped = CalendarGeometry.dropSchedule(
            day: day, minute: minute, previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
        Task {
            await store.schedule(
                pageId: page.id, title: page.title, start: dropped.start, end: dropped.end,
                previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
        }
    }

    private func dropAllDay(_ page: PageFacts, on day: String) {
        let dropped = CalendarGeometry.dropAllDay(
            day: day, previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
        Task {
            await store.schedule(
                pageId: page.id, title: page.title, start: dropped.start, end: dropped.end,
                previousStart: page.scheduledStart, previousEnd: page.scheduledEnd,
                saying: DayLabel.relative(day, today: DayLabel.today()))
        }
    }

    /// A long press on empty grid: quick add, already set to that slot.
    private func create(on day: String, at minute: Int, minutes: Int?) {
        let iso = CalendarGeometry.wallClock(day: day, minute: minute)
        guard let date = StorageTimestamp.wallClock(iso) else { return }
        route.presentQuickAdd(at: date, minutes: minutes, from: store)
    }

    /// A virtual occurrence opens its head page: editing one occurrence on its own would have to
    /// materialise a row first, which is a feature and not a side effect of tapping.
    private func openPage(_ pageId: String) {
        route.open(page: pageId)
    }

    private var folderColors: [String: Color] {
        CalendarPalette.folderColors(store.folders)
    }

    // MARK: - Acting on one occurrence

    /// The occurrence whose move sheet is open. A wrapper because `sheet(item:)` needs
    /// `Identifiable` and the generated records are not; `key` is distinct per drawn occurrence,
    /// which `page_id` is not.
    private struct Moving: Identifiable {
        let entry: CalendarEntry
        var id: String { entry.key }
    }

    // MARK: - The scope question

    /// What is being done to an occurrence, when there is a backlog behind it.
    private enum Verb {
        case complete
        case skip
    }

    private enum Scope {
        case one
        case all
    }

    /// A gesture that landed on a series which has fallen behind. Held rather than acted on,
    /// because ticking last Monday's standup with three earlier Mondays open is ambiguous.
    private struct ScopeQuestion: Identifiable {
        let id = UUID()
        let entry: CalendarEntry
        let verb: Verb
        /// Open days before today, oldest first, not counting this one.
        let backlog: [String]

        var total: Int { backlog.count + 1 }

        var title: String {
            verb == .complete ? "Mark complete" : "Skip occurrence"
        }

        /// The earlier days, named. Three at most: eleven dates in a sheet's message go unread.
        var message: String {
            let shown = backlog.prefix(3).map { DayLabel.short($0) }.joined(separator: ", ")
            let rest = backlog.count - min(backlog.count, 3)
            let days = backlog.count == 1 ? "day is" : "days are"
            let list = rest > 0 ? "\(shown), and \(rest) more" : shown
            return "\(backlog.count) earlier \(days) still open: \(list)."
        }

        // An action sheet's buttons are bare labels, so the counts do the work the desktop's
        // helper line under each choice does.
        var justThisOne: String {
            verb == .complete ? "Complete just this one" : "Skip just this one"
        }

        var everything: String {
            verb == .complete ? "Complete all \(total) days" : "Skip all \(total) days"
        }
    }

    private var hasScopeQuestion: Binding<Bool> {
        Binding(get: { scopeQuestion != nil }, set: { if !$0 { scopeQuestion = nil } })
    }

    /// Ask first, but only when there is a backlog behind the occurrence. The prompt
    /// disambiguates rather than confirms, so a tick that is not behind commits straight away.
    private func act(_ verb: Verb, on entry: CalendarEntry) async {
        let backlog = await store.backlog(behind: entry)
        if backlog.isEmpty {
            return await commit(verb, on: entry, backlog: [])
        }
        scopeQuestion = ScopeQuestion(entry: entry, verb: verb, backlog: backlog)
    }

    private func resolve(_ question: ScopeQuestion, scope: Scope) async {
        scopeQuestion = nil
        await commit(
            question.verb, on: question.entry, backlog: scope == .all ? question.backlog : [])
    }

    private func commit(_ verb: Verb, on entry: CalendarEntry, backlog: [String]) async {
        let title = entry.title.isEmpty ? "Untitled" : entry.title
        switch verb {
        case .complete:
            _ = await store.completeOccurrences(entry, andBacklog: backlog)
        case .skip:
            _ = await store.skipOccurrences(entry, andBacklog: backlog, title: title)
        }
    }

    // MARK: - Header

    private var header: some View {
        PaneHeader {
            Button {
                isJumping.toggle()
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.pkScreenTitle)
                            .foregroundStyle(.textPrimary)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.textTertiary)
                            .rotationEffect(.degrees(isJumping ? 180 : 0))
                    }
                    Text(subline)
                        .font(.pkUISm)
                        .foregroundStyle(.textTertiary)
                        .lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Visible days, \(title)")
            .accessibilityValue(isJumping ? "Expanded" : "Collapsed")
        } trailing: {
            HeaderIconButton(systemImage: "chevron.left", label: "Previous") { step(by: -1) }
            HeaderIconButton(systemImage: "chevron.right", label: "Next") { step(by: 1) }
            Button("Today") { goToToday() }
                .font(.pkUI)
                .foregroundStyle(showsToday ? Color.textDisabled : Color.textAction)
                .disabled(showsToday)
                .frame(minWidth: 52, minHeight: 44)
                .padding(.trailing, 4)
        }
    }

    private var title: String {
        guard let first = days.first, let last = days.last else { return String(localized: "Calendar") }
        if effectiveSpan == .day {
            return first.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        if effectiveSpan == .month {
            return anchor.formatted(.dateTime.month(.wide))
        }
        let sameMonth = calendar.isDate(first, equalTo: last, toGranularity: .month)
        let start = first.formatted(.dateTime.month(.abbreviated).day())
        let end =
            sameMonth
            ? last.formatted(.dateTime.day())
            : last.formatted(.dateTime.month(.abbreviated).day())
        return "\(start) – \(end)"
    }

    private var subline: String {
        let year = (days.first ?? anchor).formatted(.dateTime.year())
        return "\(year) · \(effectiveSpan.label)"
    }

    private var jumpPanel: some View {
        VStack(spacing: 8) {
            Picker("Show", selection: spanBinding) {
                ForEach(CalendarSpan.offered(in: layout)) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
            DatePicker(
                "Go to",
                selection: Binding(
                    get: { anchor },
                    set: { chosen in
                        steppedForward = chosen > anchor
                        anchor = chosen
                        isJumping = false
                    }),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    /// True when today is already on screen. Disabled rather than hidden so the toolbar does not
    /// reflow as the user pages.
    private var showsToday: Bool {
        dayStrings.contains(WallClockDay.string(from: Date()))
    }

    private var spanBinding: Binding<CalendarSpan> {
        Binding(
            get: { effectiveSpan },
            set: {
                span = $0
                isJumping = false
            })
    }
}
