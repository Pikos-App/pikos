import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// The week ahead, grouped by day — the app's Upcoming view, on the home
/// screen.
///
/// Starts tomorrow: today has its own widget, and the two side by side
/// should not repeat each other. Medium shows the next few rows with their
/// day beside them; large has room for the day headings the app uses.
struct UpcomingWidget: Widget {
    static let kind = "app.pikos.widget.upcoming"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: UpcomingProvider()) { entry in
            UpcomingView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Upcoming")
        .description("The next seven days, grouped by day.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// MARK: - Timeline

struct UpcomingEntry: TimelineEntry {
    let date: Date
    /// One run per day that holds something, in date order.
    let days: [Day]
    let today: String
    let failure: String?

    struct Day: Identifiable {
        let id: String
        let pages: [PageSummary]
    }

    static let placeholder = UpcomingEntry(
        date: .now, days: [], today: DayLabel.today(), failure: nil)

    var total: Int { days.reduce(0) { $0 + $1.pages.count } }
}

struct UpcomingProvider: TimelineProvider {
    func placeholder(in context: Context) -> UpcomingEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (UpcomingEntry) -> Void) {
        let done = Completion(call: completion)
        Task { done.call(await entry()) }
    }

    func getTimeline(
        in context: Context, completion: @escaping (Timeline<UpcomingEntry>) -> Void
    ) {
        let done = Completion(call: completion)
        Task {
            let current = await entry()
            // The window slides at midnight; the hourly backstop catches
            // that, and a write elsewhere reloads the widget outright.
            done.call(Timeline(entries: [current], policy: .after(WidgetClock.nextHour())))
        }
    }

    /// Tomorrow through the seventh day out, open pages only, grouped by
    /// the day half of their wall-clock start.
    ///
    /// The query's bounds are inclusive strings, and `2026-09-21` sorts
    /// before `2026-09-21T09:00`, so the upper bound is the day *after* the
    /// last one wanted and the exact edge is trimmed here. The list comes
    /// back in the user's sort order and is re-sorted by time, which is what
    /// a week view means by order.
    private func entry() async -> UpcomingEntry {
        let today = DayLabel.today()
        do {
            let workspace = try await WidgetWorkspace.open()
            let first = WidgetClock.day(offset: 1)
            let last = WidgetClock.day(offset: 7)
            let bound = WidgetClock.day(offset: 8)
            let pages = try await workspace.listPages(
                query: PageQuery(
                    scheduledAfter: first, scheduledBefore: bound, hasSchedule: true,
                    openOnly: true))
            var byDay: [String: [PageSummary]] = [:]
            for page in pages {
                guard let start = page.scheduledStart, let day = CalendarGeometry.day(of: start),
                    day >= first, day <= last
                else { continue }
                byDay[day, default: []].append(page)
            }
            let days = byDay.keys.sorted().map { day in
                UpcomingEntry.Day(
                    id: day,
                    pages: byDay[day, default: []].sorted {
                        ($0.scheduledStart ?? "") < ($1.scheduledStart ?? "")
                    })
            }
            return UpcomingEntry(date: .now, days: days, today: today, failure: nil)
        } catch {
            return UpcomingEntry(
                date: .now, days: [], today: today, failure: error.localizedDescription)
        }
    }
}

// MARK: - View

struct UpcomingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UpcomingEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(title: "Upcoming", systemImage: "calendar", count: entry.total)

            if entry.failure != nil {
                WidgetNote(text: "Can't read your notes")
            } else if entry.days.isEmpty {
                WidgetNote(text: "Nothing scheduled this week")
            } else if family == .systemLarge {
                grouped
            } else {
                flat
            }

            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "pikos://upcoming"))
    }

    /// Medium: the next four rows, each saying its day. No headings — four
    /// rows under up to four headings is more heading than row.
    private var flat: some View {
        let rows = entry.days.flatMap(\.pages).prefix(4)
        return ForEach(Array(rows), id: \.id) { page in
            WidgetPageRow(page: page, detail: dueLabel(page, today: entry.today))
        }
    }

    /// Large: the app's own shape, a heading per day, cut to what fits.
    ///
    /// Nine rows and their headings fill the large size at the default text
    /// size; the cut is by row rather than by day so a busy Tuesday cannot
    /// push the rest of the week off the bottom entirely.
    private var grouped: some View {
        var budget = 9
        var shown: [UpcomingEntry.Day] = []
        for day in entry.days where budget > 0 {
            let pages = Array(day.pages.prefix(budget))
            shown.append(UpcomingEntry.Day(id: day.id, pages: pages))
            budget -= pages.count
        }
        return ForEach(shown) { day in
            VStack(alignment: .leading, spacing: 3) {
                Text(DayLabel.relative(day.id, today: entry.today))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                ForEach(day.pages, id: \.id) { page in
                    WidgetPageRow(
                        page: page,
                        detail: timeOfDay(page).map { $0.formatted(date: .omitted, time: .shortened) })
                }
            }
        }
    }
}
