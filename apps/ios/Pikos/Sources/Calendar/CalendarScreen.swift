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
    @State private var scopeQuestion: ScopeQuestion?

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
                    onComplete: { entry in Task { await act(.complete, on: entry) } },
                    onSkip: { entry in Task { await act(.skip, on: entry) } },
                    onMove: { entry in moving = Moving(entry: entry) })
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .overlay(alignment: .bottom) { undoBar }
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
        /// Every date, because one gesture can skip a whole backlog and the undo
        /// has to put back exactly what went.
        let dates: [String]
        let title: String
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

    /// A gesture that landed on a series which has fallen behind.
    ///
    /// Held rather than acted on, because the answer is genuinely ambiguous:
    /// ticking last Monday's standup when three earlier Mondays are also open
    /// could mean either. The desktop asks the same question.
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

        /// The earlier days, named. Three at most: a list of eleven dates in a
        /// sheet's message is not something anybody reads.
        var message: String {
            let shown = backlog.prefix(3).map(DayLabel.short(_:)).joined(separator: ", ")
            let rest = backlog.count - min(backlog.count, 3)
            let days = backlog.count == 1 ? "day is" : "days are"
            let list = rest > 0 ? "\(shown), and \(rest) more" : shown
            return "\(backlog.count) earlier \(days) still open: \(list)."
        }

        // The counts do the work the desktop puts in a helper line under each
        // choice — an action sheet's buttons are bare labels, with no room for
        // one.
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

    /// Ask first, but only when there is something to ask about.
    ///
    /// A series that is not behind — or an occurrence today or later, which has
    /// no backlog *behind* it — commits straight away. The prompt is a
    /// disambiguation, not a confirmation, and putting one in front of every
    /// tick would make the common case two taps for no reason.
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
            let skipped = await store.skipOccurrences(entry, andBacklog: backlog)
            guard !skipped.isEmpty else { return }
            undo = SkippedOccurrence(pageId: entry.pageId, dates: skipped, title: title)
        }
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
                Text(
                    undo.dates.count == 1
                        ? "Skipped \(undo.title)"
                        : "Skipped \(undo.dates.count) days of \(undo.title)")
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 12)
                Button("Undo") {
                    Task {
                        await store.unskipOccurrences(pageId: undo.pageId, dates: undo.dates)
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
