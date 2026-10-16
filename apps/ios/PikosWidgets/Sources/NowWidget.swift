import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// The day as it stands right now: what's happening, how long until the next thing, and what to do
/// with the time in between.
///
/// Calendar and tasks in one place, which no list widget does: during a meeting it counts down to
/// the end, in a gap it says how long the gap is and offers the page `NowPlan` picks, with a
/// button that opens it with the focus timer running. The large size is a lean day calendar:
/// pages by hour that complete in place, and empty hours that open quick add at that hour.
///
/// It keeps Next Up's kind, so a Next Up widget already on a home screen becomes this one.
struct NowWidget: Widget {
    static let kind = "app.pikos.widget.next"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: NowProvider()) { entry in
            NowWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Now")
        .description("What's happening, what's next, and what to do in between. Large shows your day by the hour.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Timeline

struct NowEntry: TimelineEntry {
    let date: Date
    let plan: NowPlan
    let pages: [PageSummary]
    let failure: String?

    static let placeholder = NowEntry(date: .now, plan: NowPlan(items: [], now: .now), pages: [], failure: nil)

    func page(_ id: String?) -> PageSummary? {
        id.flatMap { id in pages.first { $0.id == id } }
    }

    /// Today's timed pages, in time order.
    var timed: [PageSummary] {
        pages.filter { timeOfDay($0) != nil }.sorted { ($0.scheduledStart ?? "") < ($1.scheduledStart ?? "") }
    }

    var untimed: [PageSummary] {
        pages.filter { timeOfDay($0) == nil }
    }
}

/// Today's open pages and the plan they make at an instant. Shared with the Start focus control.
enum NowSource {
    static func pages() async throws -> [PageSummary] {
        try await WidgetWorkspace.open().listToday().filter { $0.status != "done" }
    }

    static func plan(_ pages: [PageSummary], at now: Date) -> NowPlan {
        NowPlan(items: pages.map(item), now: now)
    }

    private static func item(_ page: PageSummary) -> NowPlan.Item {
        let start = timeOfDay(page)
        let end = start == nil ? nil : page.scheduledEnd.flatMap { StorageTimestamp.wallClock($0) }
        return NowPlan.Item(id: page.id, start: start, end: end, priority: Int(page.priority))
    }
}

struct NowProvider: TimelineProvider {
    /// More than a day holds, and few enough that WidgetKit accepts the timeline.
    private static let maxEntries = 24

    func placeholder(in context: Context) -> NowEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (NowEntry) -> Void) {
        let done = Completion(call: completion)
        Task { done.call(await timeline().entries.first ?? .placeholder) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowEntry>) -> Void) {
        let done = Completion(call: completion)
        Task { done.call(await timeline()) }
    }

    /// One entry now and one at every start and end still ahead today, so the widget moves from
    /// "free" to "now" to "free" on time without waking. The hourly refresh catches a new day.
    private func timeline() async -> Timeline<NowEntry> {
        let now = Date.now
        do {
            let pages = try await NowSource.pages()
            let first = NowSource.plan(pages, at: now)
            let instants = [now] + first.changes.prefix(Self.maxEntries - 1)
            let entries = instants.map { at in
                NowEntry(date: at, plan: NowSource.plan(pages, at: at), pages: pages, failure: nil)
            }
            return Timeline(entries: entries, policy: .after(WidgetClock.nextHour()))
        } catch {
            let entry = NowEntry(
                date: now, plan: NowPlan(items: [], now: now), pages: [], failure: error.localizedDescription)
            return Timeline(entries: [entry], policy: .after(WidgetClock.nextHour()))
        }
    }
}

// MARK: - Links

enum NowLink {
    static func focus(_ page: PageSummary) -> URL? {
        URL(string: "pikos://page/\(page.id)?focus=1")
    }

    /// Quick add holding "today at 3pm", in the English the quick-add parser reads.
    static func add(atHour hour: Int?) -> URL? {
        var components = URLComponents(string: "pikos://quick-add")
        let words: String
        if let hour {
            let clock = hour % 12 == 0 ? 12 : hour % 12
            words = "today at \(clock)\(hour < 12 ? "am" : "pm") "
        } else {
            words = "today "
        }
        components?.queryItems = [URLQueryItem(name: "text", value: words)]
        return components?.url
    }
}

// MARK: - Views

struct NowWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NowEntry

    var body: some View {
        switch family {
        case .accessoryInline:
            NowInline(entry: entry)
        case .accessoryRectangular:
            NowHeadline(entry: entry, compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .widgetURL(URL(string: "pikos://today"))
        case .systemLarge:
            NowDay(entry: entry)
        case .systemMedium:
            HStack(alignment: .top, spacing: 12) {
                NowHeadline(entry: entry, compact: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
                NowNext(entry: entry, limit: 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .widgetURL(URL(string: "pikos://today"))
        default:
            NowHeadline(entry: entry, compact: false)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .widgetURL(URL(string: "pikos://today"))
        }
    }
}

/// The one-glance answer: in a page and until when, or free and for how long, and what to do.
private struct NowHeadline: View {
    let entry: NowEntry
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if entry.failure != nil {
                WidgetNote(text: "Can't read your notes")
            } else if let current = entry.page(entry.plan.current?.id), let end = entry.plan.current?.end {
                label("Now", systemImage: "circle.fill")
                Text(displayTitle(current))
                    .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                    .lineLimit(2)
                Text("ends in \(end, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                free
            }
            if !compact { Spacer(minLength: 0) }
        }
    }

    @ViewBuilder private var free: some View {
        if let until = entry.plan.freeUntil, let next = entry.page(entry.plan.next?.id) {
            label("Free for \(Text(until, style: .relative))", systemImage: "circle")
            if !compact {
                Text("then \(displayTitle(next)) at \(until, style: .time)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        } else {
            label(entry.pages.isEmpty ? "Nothing left today" : "Free for the rest of the day", systemImage: "circle")
        }
        if let suggestion = entry.plan.suggestion, let page = entry.page(suggestion.id) {
            suggested(page, reason: suggestion.reason)
        }
    }

    private func suggested(_ page: PageSummary, reason: NowPlan.Reason) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            WidgetPageRow(page: page, linksToPage: !compact, lineLimit: compact ? 1 : 2)
            if !compact {
                HStack(spacing: 6) {
                    Text(reasonText(reason, page: page))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let focus = NowLink.focus(page) {
                        Link(destination: focus) {
                            Label("Focus", systemImage: "timer")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Brand.accent)
                        }
                        .accessibilityLabel("Start focus on \(displayTitle(page))")
                    }
                }
            }
        }
        .padding(.top, compact ? 0 : 4)
    }

    private func reasonText(_ reason: NowPlan.Reason, page: PageSummary) -> String {
        switch reason {
        case .topPriority: String(localized: "Highest priority today")
        case .overdue:
            timeOfDay(page).map { String(localized: "Due \($0.formatted(date: .omitted, time: .shortened))") }
                ?? String(localized: "Overdue")
        case .firstInList: String(localized: "First on today's list")
        }
    }

    private func label(_ text: LocalizedStringKey, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Brand.accent)
            .labelStyle(.titleOnly)
    }
}

/// What's coming, for the medium size's right half.
private struct NowNext: View {
    let entry: NowEntry
    let limit: Int

    private var ahead: [PageSummary] {
        entry.timed.filter { (timeOfDay($0) ?? .distantPast) > entry.date }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Next")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if ahead.isEmpty {
                WidgetNote(text: "Nothing else timed")
            } else {
                ForEach(ahead.prefix(limit), id: \.id) { page in
                    WidgetPageRow(page: page, detail: timeOfDay(page)?.formatted(date: .omitted, time: .shortened))
                }
            }
            Spacer(minLength: 0)
        }
    }
}

/// The large size: the headline, then the rest of today by the hour.
private struct NowDay: View {
    let entry: NowEntry
    /// The hours a large widget fits at a readable size.
    private static let hours = 7

    private var firstHour: Int {
        let hour = Calendar.current.component(.hour, from: entry.date)
        return min(hour, 24 - Self.hours)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                NowHeadline(entry: entry, compact: true)
                Spacer(minLength: 4)
                if let add = NowLink.add(atHour: nil) {
                    Link(destination: add) {
                        Image(systemName: "plus.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Brand.accent)
                    }
                    .accessibilityLabel("New page today")
                }
            }
            Divider()
            if !entry.untimed.isEmpty {
                ForEach(entry.untimed.prefix(2), id: \.id) { page in
                    WidgetPageRow(page: page)
                }
                if entry.untimed.count > 2 {
                    Text("+\(entry.untimed.count - 2) more today")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Divider()
            }
            ForEach(firstHour..<(firstHour + Self.hours), id: \.self) { hour in
                hourRow(hour)
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "pikos://calendar"))
    }

    private func pages(in hour: Int) -> [PageSummary] {
        entry.timed.filter { page in
            guard let start = timeOfDay(page) else { return false }
            return Calendar.current.component(.hour, from: start) == hour
        }
    }

    @ViewBuilder private func hourRow(_ hour: Int) -> some View {
        let pages = pages(in: hour)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(hourLabel(hour))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
            if pages.isEmpty {
                if let add = NowLink.add(atHour: hour) {
                    Link(destination: add) {
                        Rectangle()
                            .fill(.quaternary)
                            .frame(height: 1)
                            .frame(maxWidth: .infinity, minHeight: 16)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("New page at \(hourLabel(hour))")
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(pages.prefix(2), id: \.id) { page in
                        WidgetPageRow(page: page, detail: minuteLabel(page))
                    }
                }
            }
        }
    }

    private func hourLabel(_ hour: Int) -> String {
        let date = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: entry.date) ?? entry.date
        return date.formatted(.dateTime.hour())
    }

    /// Only a page that doesn't start on the hour needs its time beside it.
    private func minuteLabel(_ page: PageSummary) -> String? {
        guard let start = timeOfDay(page), Calendar.current.component(.minute, from: start) != 0 else { return nil }
        return start.formatted(date: .omitted, time: .shortened)
    }
}

/// One line beside the lock-screen clock.
private struct NowInline: View {
    let entry: NowEntry

    var body: some View {
        if let current = entry.page(entry.plan.current?.id), let end = entry.plan.current?.end {
            Text("\(displayTitle(current)) · ends \(end, style: .time)")
        } else if let until = entry.plan.freeUntil {
            Text("Free until \(until, style: .time)")
        } else if let page = entry.page(entry.plan.suggestion?.id) {
            Text(displayTitle(page))
        } else {
            Text("Nothing left today")
        }
    }
}
