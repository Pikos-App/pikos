import PikosCore
import PikosSupport
import SwiftUI

/// The day columns: an all-day band at the top, an hour grid below.
///
/// Takes entries already resolved for the range — real pages and the occurrences projected from
/// recurrence rules, indistinguishable by the time they get here. Structure comes from the shared
/// Rust; this turns it into points, drawn the way the desktop draws its week.
struct CalendarGrid: View {
    let days: [String]
    let entries: [CalendarEntry]
    let now: String
    /// Points per hour before Dynamic Type is applied — the reader's calendar density setting.
    let hourHeightBase: CGFloat
    let folderColors: [String: Color]
    /// The sheets a block's page menu can open, owned by the screen.
    @Binding var actions: PageActionState
    let onOpen: (String) -> Void
    /// Tick or untick a one-off block, which *is* its page.
    let onToggleDone: (CalendarEntry) -> Void
    /// Finish the occurrence this block is, rather than the one the series owes next.
    let onComplete: (CalendarEntry) -> Void
    let onSkip: (CalendarEntry) -> Void
    let onMove: (CalendarEntry) -> Void
    /// A long press on empty grid: a day and a minute into it, snapped to a slot.
    let onCreate: (String, Int) -> Void
    /// A block held, moved and let go over an hour: the page, the day and the snapped minute.
    let onDrop: (PageFacts, String, Int) -> Void

    /// The press is the one gesture on the grid with no visible target, so it is felt.
    @State private var slotPresses = 0
    @State private var allDayExpanded = false
    @State private var hover: DropHover?
    @State private var drops = 0

    @Environment(\.displayScale) private var displayScale
    @Environment(PageDragSession.self) private var drag

    /// A percentage rather than the height itself, because `@ScaledMetric` takes its base from a
    /// literal and the base is a setting.
    @ScaledMetric(relativeTo: .body) private var typeScale: CGFloat = 100

    private var hourHeight: CGFloat { hourHeightBase * typeScale / 100 }

    private var metrics: CalendarGeometry.Metrics {
        CalendarGeometry.Metrics(hourHeight: hourHeight)
    }

    /// Capped so a fortnight-long holiday does not push the hours off the screen.
    private static let collapsedAllDayRows = 2

    private var hairline: CGFloat { 1 / displayScale }

    var body: some View {
        VStack(spacing: 0) {
            if days.count > 1 {
                dayHeader
            }
            allDaySection
            Rectangle().fill(.borderSecondary).frame(height: hairline)
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    timedSection
                        .padding(.top, 8)
                }
                .minimizesShellBar()
                .onAppear {
                    proxy.scrollTo(Self.hourAnchor(openingHour), anchor: .top)
                }
            }
        }
        .background(.surfacePrimary)
        .sensoryFeedback(.impact(weight: .medium), trigger: slotPresses)
        .sensoryFeedback(.selection, trigger: hover) { _, new in new != nil }
        .sensoryFeedback(.success, trigger: drops)
    }

    // MARK: - Header

    private var dayHeader: some View {
        HStack(spacing: 0) {
            Spacer().frame(width: Self.gutterWidth, height: 1)
            ForEach(Array(days.enumerated()), id: \.element) { index, day in
                HStack(spacing: 4) {
                    Text(Self.weekdayLabel(day))
                    Text(Self.dayNumber(day)).monospacedDigit()
                }
                .sectionLabelStyle(isToday(day) ? .textAction : .textTertiary)
                .fontWeight(isToday(day) ? .semibold : .medium)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .overlay(alignment: .leading) {
                    if index > 0 { Rectangle().fill(.borderSubtle).frame(width: hairline) }
                }
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Self.accessibleDayLabel(day))
                .accessibilityAddTraits(isToday(day) ? [.isHeader, .isSelected] : .isHeader)
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(.borderSecondary).frame(height: hairline)
        }
    }

    // MARK: - All day

    /// Keyed by page id, not occurrence: the packer relies on every occurrence of a series sharing
    /// one, so a Mon/Wed/Fri series claims three days in one row rather than a solid block.
    private var allDayBars: [AllDayBar] {
        let pages = entries
            .filter { CalendarGeometry.isAllDay($0.scheduledStart) }
            .map {
                LayoutPage(
                    id: $0.pageId, createdAt: $0.createdAt,
                    scheduledStart: $0.scheduledStart, scheduledEnd: $0.scheduledEnd)
            }
        guard !pages.isEmpty else { return [] }
        return layoutAllDay(pages: pages, days: days)
    }

    @ViewBuilder
    private var allDaySection: some View {
        let bars = allDayBars
        if !bars.isEmpty {
            let rowCount = Int(bars.map(\.row).max() ?? 0) + 1
            let shown = allDayExpanded ? rowCount : min(rowCount, Self.collapsedAllDayRows)
            let hidden = rowCount - shown

            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("all-day")
                        .font(.pkUISm)
                        .foregroundStyle(.textTertiary)
                    if hidden > 0 || allDayExpanded {
                        Button(allDayExpanded ? "less" : "+\(hidden)") {
                            withAnimation(.snappy) { allDayExpanded.toggle() }
                        }
                        .font(.pkUISm)
                        .foregroundStyle(.textAction)
                    }
                }
                .frame(width: Self.gutterWidth - 8, alignment: .trailing)
                .padding(.trailing, 8)
                .padding(.top, 4)

                GeometryReader { geometry in
                    let columnWidth = geometry.size.width / CGFloat(max(days.count, 1))
                    ForEach(bars.filter { Int($0.row) < shown }, id: \.self) { bar in
                        allDayBar(bar, columnWidth: columnWidth)
                    }
                }
                .frame(height: CGFloat(shown) * metrics.allDayRowHeight)
            }
            .padding(.vertical, 4)
        }
    }

    private func allDayBar(_ bar: AllDayBar, columnWidth: CGFloat) -> some View {
        let entry = entries.first { $0.pageId == bar.pageId }
        let tint = entry.map(color(for:)) ?? CalendarPalette.unfiled
        let done = entry?.status == "done"
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: bar.continuesLeft ? 0 : 3, bottomLeadingRadius: bar.continuesLeft ? 0 : 3,
            bottomTrailingRadius: bar.continuesRight ? 0 : 4, topTrailingRadius: bar.continuesRight ? 0 : 4)

        return HStack(spacing: 5) {
            if let entry, !entry.isRecurring {
                TaskCheckboxMark(isDone: done, stroke: tint, size: 11)
            }
            Text(entry.map { $0.title.isEmpty ? String(localized: "Untitled") : $0.title } ?? "")
                .font(.system(.caption, weight: .medium))
                .foregroundStyle(.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.leading, bar.continuesLeft ? 4 : 6)
        .padding(.trailing, 4)
        .frame(
            width: max(columnWidth * CGFloat(bar.span) - 3, 1),
            height: metrics.allDayRowHeight - 3)
        .background {
            shape.fill(.surfacePrimary)
            shape.fill(tint.opacity(0.22))
        }
        .overlay(alignment: .leading) {
            if !bar.continuesLeft { Rectangle().fill(tint).frame(width: 2) }
        }
        .clipShape(shape)
        .opacity(done ? 0.5 : 1)
        .offset(
            x: columnWidth * CGFloat(bar.startCol) + 1.5,
            y: CGFloat(bar.row) * metrics.allDayRowHeight)
        .onTapGesture { if let entry { onOpen(entry.pageId) } }
        .accessibilityAddTraits(.isButton)
        .contextMenu { if let entry { occurrenceMenu(entry) } }
        .accessibilityActions { if let entry { occurrenceActions(entry) } }
    }

    // MARK: - Timed

    private var timedSection: some View {
        HStack(alignment: .top, spacing: 0) {
            hourGutter
            GeometryReader { geometry in
                let columnWidth = geometry.size.width / CGFloat(max(days.count, 1))
                ZStack(alignment: .topLeading) {
                    hourLines
                    columnRules(columnWidth: columnWidth)
                    ForEach(Array(days.enumerated()), id: \.element) { index, day in
                        dayColumn(day, index: index, columnWidth: columnWidth)
                    }
                }
            }
            .frame(height: metrics.dayHeight)
        }
    }

    /// Labels straddle their rule, as the desktop's do, rather than sitting under it.
    private var hourGutter: some View {
        ZStack(alignment: .topTrailing) {
            ForEach(1..<24, id: \.self) { hour in
                Text(Self.hourLabel(hour))
                    .font(.pkUISm)
                    .monospacedDigit()
                    .foregroundStyle(.textTertiary)
                    .offset(y: CGFloat(hour) * hourHeight - 7)
            }
        }
        .frame(width: Self.gutterWidth - 8, height: metrics.dayHeight, alignment: .topTrailing)
        .padding(.trailing, 8)
        // Every block already says its own time; twenty-three labels would only be in VoiceOver's way.
        .accessibilityHidden(true)
    }

    private var hourLines: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { _ in
                    Rectangle()
                        .fill(.borderSecondary)
                        .frame(height: hairline)
                        .frame(height: hourHeight, alignment: .top)
                }
            }
            // Scrolled to rather than the rules themselves: an hour's label straddles its rule, so
            // a rule at the very top left the label half under the all-day band.
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { hour in
                    Color.clear
                        .frame(width: 1, height: hourHeight)
                        .id(Self.hourAnchor(hour))
                }
            }
            .padding(.top, -Self.hourLabelClearance)
        }
        .accessibilityHidden(true)
    }

    private func columnRules(columnWidth: CGFloat) -> some View {
        ForEach(1..<max(days.count, 1), id: \.self) { index in
            Rectangle()
                .fill(.borderSubtle)
                .frame(width: hairline, height: metrics.dayHeight)
                .offset(x: columnWidth * CGFloat(index))
        }
        .accessibilityHidden(true)
    }

    /// Keyed by occurrence rather than page: two occurrences of one series can share a day.
    private var timedEntries: [CalendarEntry] {
        entries.filter { !CalendarGeometry.isAllDay($0.scheduledStart) }
    }

    private func dayColumn(_ day: String, index: Int, columnWidth: CGFloat) -> some View {
        let timed = timedEntries
        let pages = timed.map {
            LayoutPage(
                id: $0.key, createdAt: $0.createdAt,
                scheduledStart: $0.scheduledStart, scheduledEnd: $0.scheduledEnd)
        }
        let blocks = pages.isEmpty ? [] : layoutTimedDay(pages: pages, day: day)

        return ZStack(alignment: .topLeading) {
            // The empty grid under the blocks; the blocks take their own presses first.
            Color.clear
                .contentShape(Rectangle())
                .gesture(slotPress { point in
                    slotPresses += 1
                    onCreate(day, CalendarGeometry.slotMinute(atY: point.y, metrics: metrics))
                })
                .accessibilityHidden(true)

            ForEach(blocks, id: \.pageId) { block in
                if let entry = timed.first(where: { $0.key == block.pageId }),
                    let placed = CalendarGeometry.placement(
                        start: entry.scheduledStart, end: entry.scheduledEnd,
                        on: day, metrics: metrics)
                {
                    let inset = CalendarGeometry.cascadeInset(
                        depth: Int(block.cascadeDepth), columnWidth: columnWidth)
                    CalendarBlockView(
                        title: entry.title,
                        // A range does not fit a phone's third of a width; the block's height already shows the end.
                        time: CalendarPalette.timeLabel(
                            start: entry.scheduledStart, end: columnWidth < 150 ? nil : entry.scheduledEnd),
                        tint: color(for: entry),
                        isDone: entry.status == "done",
                        height: placed.height,
                        showsText: columnWidth >= Self.minimumTextWidth,
                        showsCheckbox: !entry.isRecurring || canComplete(entry),
                        isRecurring: entry.isRecurring,
                        squaredTop: block.isContinuationBefore,
                        squaredBottom: block.isContinuationAfter,
                        onToggle: {
                            if entry.isRecurring { onComplete(entry) } else { onToggleDone(entry) }
                        }
                    )
                    .frame(width: max(columnWidth - inset - 3, 1), height: placed.height)
                    .onTapGesture { onOpen(entry.pageId) }
                    .contextMenu { occurrenceMenu(entry) }
                    .modifier(LiftableBlock(page: PageFacts(entry), isEnabled: canLift(entry)))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(accessibleLabel(entry, block: block))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityActions { occurrenceActions(entry) }
                    .position(
                        x: inset + 1.5 + max(columnWidth - inset - 3, 1) / 2,
                        y: placed.top + placed.height / 2)
                }
            }

            if let offset = CalendarGeometry.nowOffset(now: now, on: day, metrics: metrics) {
                nowIndicator.offset(y: offset)
            }

            if let hover, hover.day == day, let page = drag.page {
                dropGhost(page, day: day, minute: hover.minute, width: columnWidth)
            }
        }
        .frame(width: columnWidth, height: metrics.dayHeight, alignment: .topLeading)
        .onDrop(
            of: [.text],
            delegate: GridDropDelegate(
                drag: drag, day: day, hourHeight: hourHeight, hover: $hover,
                onDrop: { page, minute in
                    drops += 1
                    onDrop(page, day, minute)
                }))
        .padding(.leading, columnWidth * CGFloat(index))
    }

    /// Where a carried block would land, drawn as the day under the list draws it.
    private func dropGhost(_ page: PageFacts, day: String, minute: Int, width: CGFloat) -> some View {
        let dropped = CalendarGeometry.dropSchedule(
            day: day, minute: minute, previousStart: page.scheduledStart, previousEnd: page.scheduledEnd)
        let length = dropped.end.flatMap(CalendarGeometry.minutesIntoDay).map { $0 - minute } ?? 30
        return HStack(spacing: 6) {
            Text(page.title.isEmpty ? String(localized: "Untitled") : page.title)
                .foregroundStyle(.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(DayPeek.timeLabel(minute))
                .foregroundStyle(.textAction)
                .monospacedDigit()
        }
        .font(.system(.caption, weight: .semibold))
        .padding(.horizontal, 8)
        .padding(.top, 5)
        .frame(width: max(width - 3, 1), height: max(26, CGFloat(length) / 60 * hourHeight), alignment: .top)
        .background {
            RoundedRectangle(cornerRadius: 5, style: .continuous).fill(.surfaceElevated)
            RoundedRectangle(cornerRadius: 5, style: .continuous).fill(.surfaceSelected)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .strokeBorder(.interactivePrimary, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
        .offset(x: 1.5, y: CGFloat(minute) / 60 * hourHeight)
        .allowsHitTesting(false)
    }

    /// A one-off page can be carried to another hour; a repeating one moves through its menu, and a
    /// calendar's page belongs to the calendar.
    private func canLift(_ entry: CalendarEntry) -> Bool {
        !entry.isRecurring && !entry.scheduleLocked && !entry.isVirtual && entry.status != "done"
    }

    /// A press held on one spot, reported with where it was. Inside a scroll view the scroll still
    /// wins the moment the finger moves: a person dragging past 3pm was scrolling.
    private func slotPress(perform: @escaping (CGPoint) -> Void) -> some Gesture {
        LongPressGesture()
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
            .onEnded { value in
                if case .second(true, let drag?) = value {
                    perform(drag.startLocation)
                }
            }
    }

    /// The desktop's now line: the interactive teal, under the blocks so it never strikes a title.
    private var nowIndicator: some View {
        Rectangle()
            .fill(.interactivePrimary)
            .frame(height: 1)
            .overlay(alignment: .leading) {
                Circle().fill(.interactivePrimary).frame(width: 7, height: 7).offset(x: -3.5)
            }
            .offset(y: -0.5)
            .accessibilityHidden(true)
    }

    // MARK: - What can be done to one block

    /// A one-off block is its page, so it gets the list's whole menu. A repeating block is one
    /// occurrence of many, so its verbs are about this one — and it has no delete, because
    /// deleting a Tuesday of a series means deleting the series, which is how a year of a habit is
    /// lost. Skip is what is wanted there, and it undoes.
    @ViewBuilder
    private func occurrenceMenu(_ entry: CalendarEntry) -> some View {
        Button {
            onOpen(entry.pageId)
        } label: {
            Label("Open", systemImage: "doc.text")
        }

        if entry.isRecurring {
            if entry.status != "done" {
                if canComplete(entry) {
                    Button {
                        onComplete(entry)
                    } label: {
                        Label("Complete this one", systemImage: "checkmark.circle")
                    }
                } else {
                    // Shown and disabled rather than missing: a native series is finished from its
                    // earliest open day, and a verb that silently vanishes reads as a bug.
                    Button {} label: {
                        Label("Complete this one", systemImage: "checkmark.circle")
                        Text("Finish its earlier open day first")
                    }
                    .disabled(true)
                }
                if canMove(entry) {
                    Button {
                        onMove(entry)
                    } label: {
                        Label("Move this one…", systemImage: "calendar.badge.clock")
                    }
                }
                Button {
                    onSkip(entry)
                } label: {
                    Label("Skip this one", systemImage: "calendar.badge.minus")
                }
            }
        } else {
            PageActionsMenu(page: PageFacts(entry), state: $actions)
        }
    }

    /// The long-press verbs as VoiceOver actions, which is where a screen reader expects them.
    @ViewBuilder
    private func occurrenceActions(_ entry: CalendarEntry) -> some View {
        Button("Open") { onOpen(entry.pageId) }
        if entry.isRecurring {
            if entry.status != "done" {
                if canComplete(entry) {
                    Button("Complete this one") { onComplete(entry) }
                }
                if canMove(entry) {
                    Button("Move this one") { onMove(entry) }
                }
                Button("Skip this one") { onSkip(entry) }
            }
        } else {
            Button(entry.status == "done" ? "Reopen" : "Complete") { onToggleDone(entry) }
        }
    }

    private func color(for entry: CalendarEntry) -> Color {
        CalendarPalette.tint(folderId: entry.folderId, colors: folderColors)
    }

    /// The desktop's checkbox rule (`useRecurringActions.showsCheckbox`): an imported occurrence is
    /// resolved on its own day, while a native series funnels to its head, which is a real block.
    private func canComplete(_ entry: CalendarEntry) -> Bool {
        entry.isSyncedOrigin || !entry.isVirtual
    }

    /// Only a projection can be re-timed on its own, and never on an active mirror.
    private func canMove(_ entry: CalendarEntry) -> Bool {
        entry.isVirtual && entry.ruleId != nil && !entry.scheduleLocked
    }

    private func accessibleLabel(_ entry: CalendarEntry, block: TimedBlock) -> String {
        var parts = [entry.title.isEmpty ? String(localized: "Untitled") : entry.title]
        if let time = CalendarPalette.timeLabel(start: entry.scheduledStart, end: entry.scheduledEnd) {
            parts.append(time)
        }
        if block.isContinuationBefore { parts.append(String(localized: "continued from the previous day")) }
        if block.isContinuationAfter { parts.append(String(localized: "continues into the next day")) }
        if entry.isVirtual { parts.append(String(localized: "repeating")) }
        if entry.status == "done" { parts.append(String(localized: "done")) }
        return parts.joined(separator: ", ")
    }

    // MARK: - Constants and labels

    private static let gutterWidth: CGFloat = 52
    private static let hourLabelClearance: CGFloat = 12
    /// Narrower than this a title wraps a letter to a line, so a block shows its colour alone.
    private static let minimumTextWidth: CGFloat = 44
    /// Where the grid opens when today is not on screen, rather than at an empty midnight.
    private static let defaultOpeningHour = 7

    /// With today on screen, the hour before now, so the first thing seen is the line.
    private var openingHour: Int {
        guard let today = CalendarGeometry.day(of: now), days.contains(today),
            let minute = CalendarGeometry.minutesIntoDay(now)
        else { return Self.defaultOpeningHour }
        return max(0, minute / 60 - 1)
    }

    private static func hourAnchor(_ hour: Int) -> String {
        "hour-\(hour)"
    }

    private func isToday(_ day: String) -> Bool {
        CalendarGeometry.day(of: now) == day
    }

    private static func dayNumber(_ day: String) -> String {
        let number = day.suffix(2)
        return number.first == "0" ? String(number.dropFirst()) : String(number)
    }

    private static func weekdayLabel(_ day: String) -> String {
        guard let date = date(from: day) else { return "" }
        return date.formatted(.dateTime.weekday(.abbreviated))
    }

    private static func accessibleDayLabel(_ day: String) -> String {
        guard let date = date(from: day) else { return day }
        return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    /// Stepped from a real midnight: a bare hour component has no date to be an hour of.
    private static func hourLabel(_ hour: Int) -> String {
        let calendar = Calendar.current
        let midnight = calendar.startOfDay(for: .now)
        guard let date = calendar.date(byAdding: .hour, value: hour, to: midnight) else {
            return ""
        }
        return date.formatted(.dateTime.hour())
    }

    private static func date(from day: String) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(
            from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

/// The day and quarter hour a carried block is over.
private struct DropHover: Equatable {
    let day: String
    let minute: Int
}

/// Holding a block opens its menu; moving the finger instead carries it, as a list row is carried.
private struct LiftableBlock: ViewModifier {
    let page: PageFacts
    let isEnabled: Bool

    @Environment(PageDragSession.self) private var drag

    func body(content: Content) -> some View {
        if isEnabled {
            content.onDrag {
                drag.itemProvider(for: page)
            } preview: {
                PageDragPreview(title: page.title)
            }
        } else {
            content
        }
    }
}

/// One day column as a drop target, in its own coordinates, so the scroll offset never enters into it.
private struct GridDropDelegate: DropDelegate {
    let drag: PageDragSession
    let day: String
    let hourHeight: CGFloat
    @Binding var hover: DropHover?
    let onDrop: (PageFacts, Int) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        drag.candidate != nil && info.hasItemsConforming(to: [.text])
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        drag.beat()
        let minute = CalendarGeometry.dropMinute(atY: max(0, info.location.y), firstHour: 0, hourHeight: hourHeight)
        let next = DropHover(day: day, minute: minute)
        if hover != next { hover = next }
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        if hover?.day == day { hover = nil }
    }

    func performDrop(info: DropInfo) -> Bool {
        guard let minute = hover?.minute else { return false }
        hover = nil
        return drag.land(info) { page in onDrop(page, minute) }
    }
}
