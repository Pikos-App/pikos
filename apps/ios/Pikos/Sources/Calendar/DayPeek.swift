import PikosCore
import PikosSupport
import SwiftUI
import UniformTypeIdentifiers

/// The rest of today, under the list: the desktop's calendar panel, kept on screen at a third of
/// its size so a page and an hour are always in reach of each other.
///
/// It shows the next few hours from now. Lifting a page grows it to six so there is room to aim,
/// and dropping on an hour is the desktop's drag-to-schedule with no picker in between. With
/// nothing left today it shrinks to one line rather than disappearing, so the list never jumps.
///
/// Today and Upcoming already are the schedule, so over them it rests out of sight and rises only
/// while a page is lifted. It stays mounted at no height rather than being added on lift: the
/// drag session never finds a drop target that appears after the drag began.
struct DayPeek: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Route.self) private var route
    @Environment(PageDragSession.self) private var drag
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var entries: [CalendarEntry] = []
    @State private var dropCount = 0
    @State private var headerHeight: CGFloat = 32

    private static let restingHours = 3
    static let droppingHours = 6
    private static let hourHeight: CGFloat = 40
    private static let gutter: CGFloat = 50
    private static let gridTopInset: CGFloat = 8
    private static let trayShape = UnevenRoundedRectangle(
        topLeadingRadius: 18, topTrailingRadius: 18, style: .continuous)

    var body: some View {
        TimelineView(.everyMinute) { context in
            content(now: context.date)
        }
        // On the outermost view: a target inside the timeline, or one that only exists once a page
        // is lifted, is never found by the drag session.
        .onDrop(
            of: [.text],
            delegate: PeekDropDelegate(
                drag: drag, hourHeight: Self.hourHeight,
                gridTop: { headerHeight + Self.gridTopInset },
                firstHour: { Self.firstHour(now: Date(), hours: Self.droppingHours) },
                onDrop: dropPage))
        .onPreferenceChange(PeekHeaderHeight.self) { headerHeight = $0 }
        .task(id: "\(WallClockDay.string(from: Date()))#\(store.dataVersion)") {
            let today = Date()
            let weekOut = Calendar.current.date(byAdding: .day, value: 7, to: today) ?? today
            entries = await store.calendarRange(
                from: WallClockDay.string(from: today), to: WallClockDay.string(from: weekOut))
        }
        .sensoryFeedback(.selection, trigger: drag.hoverMinute) { _, new in new != nil }
        .sensoryFeedback(.success, trigger: dropCount)
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let day = Timeline(entries: entries, now: now)
        let isDropping = drag.page != nil
        let hours = isDropping ? Self.droppingHours : Self.restingHours
        let firstHour = Self.firstHour(now: now, hours: hours)
        let isShown = isDropping || !store.scope.isDateGrouped

        VStack(spacing: 0) {
            if isShown {
                VStack(spacing: 0) {
                    header(day: day, isDropping: isDropping)
                    if day.remaining.isEmpty && !isDropping {
                        emptyStrip(day: day)
                    } else {
                        grid(day: day, firstHour: firstHour, hours: hours)
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            Color.clear.frame(height: ShellBar.clearance)
        }
        // A tray set into the page, in the desktop sidebar's tone, so it reads as a separate
        // surface without a second heading saying what day it is.
        .background {
            if isShown {
                Self.trayShape
                    .fill(.surfaceTertiary)
                    .overlay(Self.trayShape.stroke(.borderSecondary, lineWidth: 1))
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.32), value: isDropping)
    }

    // MARK: - Header

    private func header(day: Timeline, isDropping: Bool) -> some View {
        Button {
            route.showWeek(on: Date())
        } label: {
            HStack(spacing: 6) {
                // Not the date: the list's own header already says which day it is.
                Text("Up next")
                    .sectionLabelStyle()
                Spacer(minLength: 8)
                if isDropping {
                    Text("Drop on an hour")
                        .font(.pkUISm)
                        .foregroundStyle(.textAction)
                        .transition(.opacity)
                } else {
                    Text(day.summary)
                        .font(.pkUISm)
                        .foregroundStyle(.textTertiary)
                        .lineLimit(1)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.textDisabled)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: PeekHeaderHeight.self, value: proxy.size.height)
            })
        .accessibilityLabel(day.summary.isEmpty ? String(localized: "Up next today") : String(localized: "Up next today, \(day.summary)"))
        .accessibilityHint("Opens the calendar")
        .accessibilityIdentifier("Day peek")
    }

    private func emptyStrip(day: Timeline) -> some View {
        HStack(spacing: 8) {
            Text(day.hasAnythingToday ? "Nothing else today" : "Nothing scheduled today")
                .font(.pkBodySm)
                .foregroundStyle(.textSecondary)
            if let next = day.next {
                Text("Next: \(next)")
                    .font(.pkBodySm)
                    .foregroundStyle(.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    // MARK: - The hours

    private func grid(day: Timeline, firstHour: Int, hours: Int) -> some View {
        let height = CGFloat(hours) * Self.hourHeight
        return GeometryReader { geometry in
            let columnWidth = geometry.size.width - Self.gutter - 12
            ZStack(alignment: .topLeading) {
                hourRules(firstHour: firstHour, hours: hours)
                blocks(day: day, firstHour: firstHour, height: height, columnWidth: columnWidth)
                nowLine(day: day, firstHour: firstHour, height: height)
                dropGhost(firstHour: firstHour, columnWidth: columnWidth)
            }
            .padding(.top, Self.gridTopInset)
            .contentShape(Rectangle())
            .onTapGesture { route.showWeek(on: Date()) }
        }
        .frame(height: height + Self.gridTopInset)
        .clipped()
    }

    private func hourRules(firstHour: Int, hours: Int) -> some View {
        ForEach(0..<hours, id: \.self) { index in
            let y = CGFloat(index) * Self.hourHeight
            ZStack(alignment: .topLeading) {
                Rectangle()
                    .fill(.borderSecondary)
                    .frame(height: 1 / displayScale)
                    .padding(.leading, Self.gutter)
                    .offset(y: y)
                Text(Self.hourLabel(firstHour + index))
                    .font(.pkUISm)
                    .foregroundStyle(.textTertiary)
                    .monospacedDigit()
                    .frame(width: Self.gutter - 10, alignment: .trailing)
                    .offset(y: y - 7)
            }
        }
        .accessibilityHidden(true)
    }

    private func blocks(day: Timeline, firstHour: Int, height: CGFloat, columnWidth: CGFloat)
        -> some View
    {
        let metrics = CalendarGeometry.Metrics(hourHeight: Self.hourHeight, minBlockHeight: 20)
        let origin = CGFloat(firstHour) * Self.hourHeight
        let layout = day.layout
        let colors = CalendarPalette.folderColors(store.folders)

        return ForEach(day.timed, id: \.key) { entry in
            if let placed = CalendarGeometry.placement(
                start: entry.scheduledStart, end: entry.scheduledEnd, on: day.today, metrics: metrics),
                placed.top - origin + placed.height > 0, placed.top - origin < height
            {
                let depth = Int(layout[entry.key]?.cascadeDepth ?? 0)
                let inset = CalendarGeometry.cascadeInset(depth: depth, columnWidth: columnWidth)
                CalendarBlockView(
                    title: entry.title,
                    time: CalendarPalette.timeLabel(start: entry.scheduledStart, end: entry.scheduledEnd),
                    tint: CalendarPalette.tint(folderId: entry.folderId, colors: colors),
                    isDone: entry.status == "done",
                    height: placed.height,
                    showsCheckbox: !entry.isRecurring || entry.isSyncedOrigin || !entry.isVirtual,
                    isRecurring: entry.isRecurring,
                    onToggle: {
                        guard !entry.isRecurring else { return }
                        Task { await store.setStatus(pageId: entry.pageId, done: entry.status != "done") }
                    }
                )
                .frame(width: max(columnWidth - inset, 1), height: placed.height)
                .onTapGesture { route.open(page: entry.pageId) }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .position(
                    x: Self.gutter + inset + max(columnWidth - inset, 1) / 2,
                    y: placed.top - origin + placed.height / 2)
            }
        }
    }

    @ViewBuilder
    private func nowLine(day: Timeline, firstHour: Int, height: CGFloat) -> some View {
        let y = CGFloat(day.nowMinute - firstHour * 60) / 60 * Self.hourHeight
        if y >= 0, y <= height {
            ZStack(alignment: .leading) {
                Rectangle().fill(.interactivePrimary).frame(height: 1)
                Circle().fill(.interactivePrimary).frame(width: 7, height: 7).offset(x: -3.5)
            }
            .padding(.leading, Self.gutter)
            .offset(y: y - 0.5)
            .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func dropGhost(firstHour: Int, columnWidth: CGFloat) -> some View {
        if let minute = drag.hoverMinute, let page = drag.page {
            let y = CGFloat(minute - firstHour * 60) / 60 * Self.hourHeight
            let dropped = CalendarGeometry.dropSchedule(
                day: WallClockDay.string(from: Date()), minute: minute,
                previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
            let length = dropped.end.flatMap(CalendarGeometry.minutesIntoDay).map { $0 - minute } ?? 30
            let height = max(26, CGFloat(length) / 60 * Self.hourHeight)
            HStack(spacing: 6) {
                Text(page.title.isEmpty ? String(localized: "Untitled") : page.title)
                    .font(.system(.caption, weight: .semibold))
                    .foregroundStyle(.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(Self.timeLabel(minute))
                    .font(.system(.caption, weight: .semibold))
                    .foregroundStyle(.textAction)
                    .monospacedDigit()
            }
            .padding(.horizontal, 8)
            .frame(width: columnWidth, height: height, alignment: .top)
            .padding(.top, 5)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous).fill(.surfaceElevated)
                RoundedRectangle(cornerRadius: 5, style: .continuous).fill(.surfaceSelected)
            }
            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(.interactivePrimary, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
            .offset(x: Self.gutter, y: y)
            .animation(reduceMotion ? nil : .snappy(duration: 0.14), value: minute)
            .allowsHitTesting(false)
        }
    }

    private func dropPage(_ page: PageFacts, minute: Int) {
        let dropped = CalendarGeometry.dropSchedule(
            day: WallClockDay.string(from: Date()), minute: minute,
            previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
        dropCount += 1
        Task {
            await store.schedule(
                pageId: page.id, title: page.title, start: dropped.start, end: dropped.end,
                previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
        }
    }

    // MARK: - Labels

    /// The window starts at the current hour, pulled back so it never runs past midnight.
    static func firstHour(now: Date, hours: Int) -> Int {
        let hour = Calendar.current.component(.hour, from: now)
        return min(max(0, hour), 24 - hours)
    }

    static func hourLabel(_ hour: Int) -> String {
        let midnight = Calendar.current.startOfDay(for: .now)
        guard let date = Calendar.current.date(byAdding: .hour, value: hour, to: midnight) else {
            return ""
        }
        return date.formatted(.dateTime.hour())
    }

    static func timeLabel(_ minute: Int) -> String {
        let midnight = Calendar.current.startOfDay(for: .now)
        guard let date = Calendar.current.date(byAdding: .minute, value: minute, to: midnight) else {
            return ""
        }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

/// Today's part of a week of entries, read once per minute.
private struct Timeline {
    let today: String
    let nowMinute: Int
    let timed: [CalendarEntry]
    let remaining: [CalendarEntry]
    let hasAnythingToday: Bool
    let layout: [String: TimedBlock]
    let summary: String
    let next: String?

    @MainActor
    init(entries: [CalendarEntry], now: Date) {
        today = WallClockDay.string(from: now)
        nowMinute = CalendarGeometry.minutesIntoDay(WallClockDay.instant(from: now)) ?? 0

        let today = self.today
        let nowMinute = self.nowMinute
        timed = entries.filter {
            !CalendarGeometry.isAllDay($0.scheduledStart)
                && CalendarGeometry.placement(
                    start: $0.scheduledStart, end: $0.scheduledEnd, on: today,
                    metrics: CalendarGeometry.Metrics()) != nil
        }
        hasAnythingToday =
            !timed.isEmpty || entries.contains { CalendarGeometry.day(of: $0.scheduledStart) == today }
        remaining = timed.filter { entry in
            guard entry.status != "done" else { return false }
            let end =
                entry.scheduledEnd.flatMap { CalendarGeometry.day(of: $0) == today ? $0 : nil }
                .flatMap(CalendarGeometry.minutesIntoDay)
                ?? (CalendarGeometry.minutesIntoDay(entry.scheduledStart) ?? 0) + 15
            return end > nowMinute
        }

        let pages = timed.map {
            LayoutPage(
                id: $0.key, createdAt: $0.createdAt,
                scheduledStart: $0.scheduledStart, scheduledEnd: $0.scheduledEnd)
        }
        let blocks = pages.isEmpty ? [] : layoutTimedDay(pages: pages, day: today)
        layout = Dictionary(blocks.map { ($0.pageId, $0) }, uniquingKeysWith: { first, _ in first })

        let upcoming = remaining.sorted { $0.scheduledStart < $1.scheduledStart }
        if let first = upcoming.first, let start = CalendarGeometry.minutesIntoDay(first.scheduledStart),
            start > nowMinute
        {
            summary = upcoming.count == 1
                ? String(localized: "Free until \(DayPeek.timeLabel(start))")
                : String(localized: "\(upcoming.count) more · next at \(DayPeek.timeLabel(start))")
        } else if !upcoming.isEmpty {
            summary = upcoming.count == 1
                ? String(localized: "1 in progress")
                : String(localized: "\(upcoming.count) more today")
        } else {
            summary = ""
        }

        let future = entries
            .filter { ($0.scheduledStart.prefix(10)) > today && $0.status != "done" }
            .sorted { $0.scheduledStart < $1.scheduledStart }
        next = future.first.map { entry in
            let title = entry.title.isEmpty ? String(localized: "Untitled") : entry.title
            guard let date = StorageTimestamp.wallClock(entry.scheduledStart) else { return title }
            let calendar = Calendar.current
            let dayText =
                calendar.isDateInTomorrow(date)
                ? String(localized: "tomorrow")
                : date.formatted(.dateTime.weekday(.abbreviated))
            if CalendarGeometry.isAllDay(entry.scheduledStart) { return "\(title), \(dayText)" }
            return "\(title), \(dayText) \(date.formatted(date: .omitted, time: .shortened))"
        }
    }
}

private struct PeekHeaderHeight: PreferenceKey {
    static let defaultValue: CGFloat = 32
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct PeekDropDelegate: DropDelegate {
    let drag: PageDragSession
    let hourHeight: CGFloat
    /// Where the hours start inside the peek, read at the moment of each update.
    let gridTop: () -> CGFloat
    let firstHour: () -> Int
    let onDrop: (PageFacts, Int) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        return drag.candidate != nil && info.hasItemsConforming(to: [.text])
    }

    func dropEntered(info: DropInfo) {
        update(info)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        drag.beat()
        update(info)
        return DropProposal(operation: drag.hoverMinute == nil ? .forbidden : .move)
    }

    func dropExited(info: DropInfo) {
        drag.hoverMinute = nil
    }

    /// Only a page this app lifted is scheduled: the carried text has to name the page the session holds.
    func performDrop(info: DropInfo) -> Bool {
        guard let page = drag.page, let minute = drag.hoverMinute,
            let provider = info.itemProviders(for: [.text]).first
        else { return false }
        drag.end()
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            let text = (object as? NSString).map(String.init) ?? ""
            Task { @MainActor in
                guard text == PageDragSession.prefix + page.id else { return }
                onDrop(page, minute)
            }
        }
        return true
    }

    /// Over the header or below the last hour is not a time, so it clears the hover.
    private func update(_ info: DropInfo) {
        let y = info.location.y - gridTop()
        let hours = CGFloat(DayPeek.droppingHours)
        guard y >= 0, y < hours * hourHeight else {
            if drag.hoverMinute != nil { drag.hoverMinute = nil }
            return
        }
        let minute = CalendarGeometry.dropMinute(atY: y, firstHour: firstHour(), hourHeight: hourHeight)
        if drag.hoverMinute != minute { drag.hoverMinute = minute }
    }
}
