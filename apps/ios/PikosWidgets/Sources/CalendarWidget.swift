import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// Today's coming hours, drawn as the app's calendar draws them: blocks in their folder colours,
/// overlapping ones side by side as the grid lays them out, each with a box that completes it in place.
/// An empty hour opens quick add at that hour.
///
/// It replaced the Now widget, which told the time left and suggested a page; Alex found a picture
/// of the day more use than a sentence about it. The lock-screen sizes keep Now's sentence, since a
/// grid doesn't fit beside the clock.
///
/// It keeps Next Up's kind, so a Next Up or Now widget already on a home screen becomes this one.
struct CalendarWidget: Widget {
    static let kind = "app.pikos.widget.next"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: NowProvider()) { entry in
            NowWidgetView(entry: entry)
                .containerBackground(WidgetGround.style, for: .widget)
        }
        .configurationDisplayName("Calendar")
        .description("Today's coming hours, as your calendar draws them. Tick a page off where it sits.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Timeline

struct NowEntry: TimelineEntry {
    let date: Date
    let plan: NowPlan
    let pages: [PageSummary]
    /// Folder id to its stored palette value, for the blocks' colours.
    var folderColors: [String: String] = [:]
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
            let folders = try await WidgetWorkspace.open().listFolders()
            let colors = Dictionary(
                folders.compactMap { folder in CurrentPaletteColor.of(folder.color).map { (folder.id, $0) } },
                uniquingKeysWith: { first, _ in first })
            let first = NowSource.plan(pages, at: now)
            let instants = [now] + first.changes.prefix(Self.maxEntries - 1)
            let entries = instants.map { at in
                NowEntry(
                    date: at, plan: NowSource.plan(pages, at: at), pages: pages, folderColors: colors, failure: nil)
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
    @Environment(\.widgetFamily) private var widgetFamily
    let entry: NowEntry
    /// See `ListWidgetView.family`.
    var family: WidgetFamily? = nil

    var body: some View {
        switch family ?? widgetFamily {
        case .accessoryInline:
            NowInline(entry: entry)
        case .accessoryRectangular:
            NowHeadline(entry: entry, compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .widgetURL(URL(string: "pikos://today"))
        case .systemLarge:
            CalendarDay(entry: entry, hours: 8, allDayRows: 2)
        case .systemMedium:
            CalendarDay(entry: entry, hours: 3, allDayRows: 1)
        default:
            CalendarDay(entry: entry, hours: 3, allDayRows: 1, isNarrow: true)
        }
    }
}

struct NowAddButton: View {
    let hour: Int?

    var body: some View {
        if let add = NowLink.add(atHour: hour) {
            Link(destination: add) {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Brand.accent)
            }
            .accessibilityLabel("New page today")
        }
    }
}

/// The one-glance answer: in a page and until when, or free and for how long, and what to do.
private struct NowHeadline: View {
    let entry: NowEntry
    let compact: Bool
    /// The small size: "Focus" spelled out left the reason two words wide.
    var focusIsIconOnly = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if entry.failure != nil {
                WidgetNote(text: "Can't read your pages")
            } else if let current = entry.page(entry.plan.current?.id), let end = entry.plan.current?.end {
                label("Now", systemImage: "circle.fill")
                Text(displayTitle(current))
                    .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                    .lineLimit(2)
                Text("ends in \(minutesLeft(until: end))")
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
            label("Free for \(minutesLeft(until: until))", systemImage: "circle")
            if !compact {
                Text("then \(displayTitle(next)) at \(ClockTime.string(until))")
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
                        .foregroundStyle(WidgetInk.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let focus = NowLink.focus(page) {
                        Link(destination: focus) {
                            if focusIsIconOnly {
                                Image(systemName: "timer")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(WidgetInk.action)
                            } else {
                                Label("Focus", systemImage: "timer")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(WidgetInk.action)
                            }
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
            timeOfDay(page).map { String(localized: "Due \(ClockTime.string($0))") }
                ?? String(localized: "Overdue")
        case .firstInList: String(localized: "First on today's list")
        }
    }

    private func label(_ text: LocalizedStringKey, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(WidgetInk.action)
            .labelStyle(.titleOnly)
    }
}

/// What's coming, for the medium size's right half.
private struct NowInline: View {
    let entry: NowEntry

    var body: some View {
        if let current = entry.page(entry.plan.current?.id), let end = entry.plan.current?.end {
            Text("\(displayTitle(current)) · ends \(ClockTime.string(end))")
        } else if let until = entry.plan.freeUntil {
            Text("Free until \(ClockTime.string(until))")
        } else if let page = entry.page(entry.plan.suggestion?.id) {
            Text(displayTitle(page))
        } else {
            Text("Nothing left today")
        }
    }
}
