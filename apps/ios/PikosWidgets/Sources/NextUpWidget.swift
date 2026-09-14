import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// The one thing that is next, and how long until it.
///
/// Today lists the day; this answers the narrower question a glance at the
/// home screen usually asks — what is the next thing, and is it soon. The
/// small size is one page and a countdown; the medium adds the two after it.
///
/// Reads with `ReadOnlyWorkspace` like every widget; ticking goes through
/// `CompletePageIntent`, which says why that one write is safe.
struct NextUpWidget: Widget {
    static let kind = "app.pikos.widget.next"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: NextUpProvider()) { entry in
            NextUpView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Next Up")
        .description("The next scheduled page, and how soon it is.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Timeline

struct NextUpEntry: TimelineEntry {
    let date: Date
    /// The page due soonest, if anything is scheduled from now on.
    let next: PageSummary?
    /// The two after it, for the medium size.
    let following: [PageSummary]
    let today: String
    let failure: String?

    static let placeholder = NextUpEntry(
        date: .now, next: nil, following: [], today: DayLabel.today(), failure: nil)
}

struct NextUpProvider: TimelineProvider {
    func placeholder(in context: Context) -> NextUpEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (NextUpEntry) -> Void) {
        let done = Completion(call: completion)
        Task { done.call(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NextUpEntry>) -> Void) {
        let done = Completion(call: completion)
        Task {
            let current = await entry()
            // Refresh when the next page's time arrives, since that is when
            // the answer changes — or at the hour, whichever is sooner, so
            // an all-day page rolls over with the date.
            var refresh = WidgetClock.nextHour()
            if let next = current.next, let at = timeOfDay(next), at > .now, at < refresh {
                refresh = at
            }
            done.call(Timeline(entries: [current], policy: .after(refresh)))
        }
    }

    /// Everything scheduled from today on, sorted by when, and cut to what
    /// has not yet happened.
    ///
    /// A timed page whose time has passed is Today's business (it is in the
    /// Overdue section there); this widget is about what is still ahead. An
    /// all-day page dated today counts as ahead until midnight, which is the
    /// app's own rule for where such a page sits in the list.
    private func entry() async -> NextUpEntry {
        let today = DayLabel.today()
        do {
            let workspace = try await WidgetWorkspace.open()
            let now = WidgetClock.now()
            let pages = try await workspace.listPages(
                query: PageQuery(scheduledAfter: today, hasSchedule: true, openOnly: true))
            let ahead =
                pages
                .filter { page in
                    guard let start = page.scheduledStart else { return false }
                    return start.contains("T") ? start >= now : start >= today
                }
                .sorted { ($0.scheduledStart ?? "") < ($1.scheduledStart ?? "") }
            return NextUpEntry(
                date: .now,
                next: ahead.first,
                following: Array(ahead.dropFirst().prefix(2)),
                today: today,
                failure: nil)
        } catch {
            return NextUpEntry(
                date: .now, next: nil, following: [], today: today,
                failure: error.localizedDescription)
        }
    }
}

// MARK: - View

struct NextUpView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NextUpEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(title: "Next Up", systemImage: "arrow.right.circle")

            if entry.failure != nil {
                WidgetNote(text: "Can't read your notes")
            } else if let next = entry.next {
                headline(next)
                if family == .systemMedium, !entry.following.isEmpty {
                    Divider()
                    ForEach(entry.following, id: \.id) { page in
                        WidgetPageRow(page: page, detail: dueLabel(page, today: entry.today))
                    }
                }
            } else {
                WidgetNote(text: "Nothing scheduled ahead")
            }

            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: entry.next.map { "pikos://page/\($0.id)" } ?? "pikos://today"))
    }

    /// The next page, large, with a countdown that keeps itself current.
    ///
    /// `Text(_:style: .relative)` is redrawn by the system as the minutes
    /// pass, so the widget reads "in 12 min" without a timeline entry per
    /// minute — which WidgetKit would not grant anyway.
    private func headline(_ page: PageSummary) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: "circle")
                    .font(.caption2)
                    .foregroundStyle(ringColor(priority: page.priority))
                Text(displayTitle(page))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(family == .systemSmall ? 3 : 2)
            }
            if let time = timeOfDay(page) {
                if time > entry.date {
                    Text("in \(time, style: .relative)")
                        .font(.caption)
                        .foregroundStyle(Brand.accent)
                } else {
                    Text("now")
                        .font(.caption)
                        .foregroundStyle(Brand.accent)
                }
                Text(time, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if let day = dueLabel(page, today: entry.today) {
                Text(day)
                    .font(.caption)
                    .foregroundStyle(Brand.accent)
            }
        }
    }
}
