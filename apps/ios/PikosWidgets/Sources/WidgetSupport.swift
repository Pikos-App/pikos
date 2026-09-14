import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// What every widget in the bundle shares: how it opens the workspace, how it
/// draws a page, and how it names a time.
///
/// One file rather than a copy per widget, for the reason the app's
/// `PageRow` is one view: five widgets each drawing their own row is how the
/// ring ends up a different size on the lock screen than on the home screen,
/// and a reader who has learned one is wrong-footed by the next.

// MARK: - Opening the workspace

enum WidgetWorkspace {
    /// The workspace, read-only, or a thrown error naming why not.
    ///
    /// `openExisting` never creates a database and never migrates. A widget
    /// that woke before the app has ever run must show nothing, not leave an
    /// empty workspace behind for the app to find.
    static func open() async throws -> ReadOnlyWorkspace {
        let url = try WorkspaceLocation.databaseURL()
        return try await ReadOnlyWorkspace.openExisting(path: url.path)
    }
}

/// A completion handler WidgetKit gave us, carried into a `Task`.
///
/// `TimelineProvider` hands over plain closures, and under strict concurrency a
/// plain closure cannot be captured by the `@Sendable` closure a `Task` runs.
/// The handler is only ever called once, from the task that owns this box, so
/// the sharing the checker objects to never happens — hence `@unchecked`. A
/// box rather than an `async` provider because `StaticConfiguration` has no
/// async variant of this protocol to adopt.
struct Completion<Value>: @unchecked Sendable {
    let call: (Value) -> Void
}

// MARK: - Time

enum WidgetClock {
    /// Now, as the wall-clock string the workspace compares schedules
    /// against: `2026-09-14T15:04`. Built from Gregorian components like the
    /// storage key in `DayLabel.today`, for the same reason — this is
    /// compared to stored strings, not shown.
    static func now(_ date: Date = Date(), calendar: Calendar = .current) -> String {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let parts = gregorian.dateComponents([.hour, .minute], from: date)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        return "\(DayLabel.today(calendar, now: date))T\(time)"
    }

    /// The `YYYY-MM-DD` key `days` days from today.
    static func day(offset days: Int, from date: Date = Date(), calendar: Calendar = .current)
        -> String
    {
        let target = calendar.date(byAdding: .day, value: days, to: date) ?? date
        return DayLabel.today(calendar, now: target)
    }

    /// The next hour boundary — when an item can become overdue — for the
    /// widgets whose content changes with the clock rather than with a write.
    static func nextHour(after date: Date = .now) -> Date {
        Calendar.current.nextDate(
            after: date, matching: DateComponents(minute: 0), matchingPolicy: .nextTime)
            ?? date.addingTimeInterval(3600)
    }
}

/// A page's time of day as an instant, or nil for an all-day page.
///
/// The stored value is a wall clock, resolved in the reader's own zone by
/// `StorageTimestamp` — the same reading the app's list makes, so a widget
/// and the list never disagree by an hour.
func timeOfDay(_ page: PageSummary) -> Date? {
    guard let start = page.scheduledStart, start.contains("T") else { return nil }
    return StorageTimestamp.wallClock(start)
}

/// The instant a page is scheduled for, all-day pages landing on noon.
func scheduledInstant(_ page: PageSummary) -> Date? {
    page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) }
}

// MARK: - Drawing a page

/// The same tint the app's list gives the ring, so the widget and the list
/// agree about which row is the urgent one. Spelled here rather than shared:
/// the app's `PagePriority` lives in the app target, and four colours are
/// cheaper than a third package target.
func ringColor(priority: Int64) -> Color {
    switch priority {
    case 1: return .red
    case 2: return .orange
    case 3: return .yellow
    case 4: return .blue
    default: return .secondary
    }
}

/// A page's title, never blank.
func displayTitle(_ page: PageSummary) -> String {
    page.title.isEmpty ? String(localized: "Untitled") : page.title
}

/// One page: a ring that finishes it and a title that opens it.
///
/// The ring is a real button, so a task can be ticked from the home screen
/// without the app ever coming to the front — the thing a widget is for. The
/// title opens its page where there is room to aim; on the small size it
/// falls through to the widget's own link, since three rows in a two-inch
/// square are not something a thumb can pick between — but the ring is a
/// target of its own even there.
struct WidgetPageRow: View {
    let page: PageSummary
    /// Whether the title is its own link to the page.
    var linksToPage = true
    /// What to say beside the title, if anything: a time, a day.
    var detail: String? = nil
    var lineLimit = 1

    var body: some View {
        let isDone = page.status == "done"
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Button(intent: CompletePageIntent(pageId: page.id, done: !isDone)) {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .font(.caption2)
                    // `Brand.accent` rather than `Color.accentColor`: the
                    // widget is its own process with no asset catalog, so
                    // the app's accent is not here to inherit.
                    .foregroundStyle(isDone ? Brand.accent : ringColor(priority: page.priority))
                    // Drawn dimmed while the tap is being written, so the
                    // moment between the touch and the reload reads as
                    // "working" rather than "ignored".
                    .invalidatableContent()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isDone ? "Reopen" : "Mark as done")

            let title = HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let detail {
                    Text(detail)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(displayTitle(page))
                    .font(.caption)
                    .strikethrough(isDone, color: .secondary)
                    .foregroundStyle(isDone ? Color.secondary : Color.primary)
                    .lineLimit(lineLimit)
            }
            if linksToPage, let url = URL(string: "pikos://page/\(page.id)") {
                Link(destination: url) { title }
            } else {
                title
            }
            Spacer(minLength: 0)
        }
    }
}

/// A widget's heading: a name and, when there is one, a count.
struct WidgetHeader: View {
    let title: LocalizedStringKey
    var systemImage: String? = nil
    var count: Int? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(title)
            Spacer()
            if let count, count > 0 {
                Text("\(count)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption.weight(.semibold))
    }
}

/// The sentence a widget shows instead of rows.
///
/// A broken widget and an empty one look identical otherwise, and the usual
/// cause of the first is an App Group that is not configured — so a failure
/// is said, not swallowed.
struct WidgetNote: View {
    let text: LocalizedStringKey

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}

/// The time a page is due, as the short day-and-time the app's rows use.
///
/// `today` is passed rather than read so a timeline entry rendered after
/// midnight does not disagree with itself about which day is "Today".
func dueLabel(_ page: PageSummary, today: String) -> String? {
    guard let start = page.scheduledStart, let day = CalendarGeometry.day(of: start) else {
        return nil
    }
    let dayLabel = DayLabel.relative(day, today: today)
    guard let time = timeOfDay(page) else { return dayLabel }
    let clock = time.formatted(date: .omitted, time: .shortened)
    return day == today ? clock : "\(dayLabel) \(clock)"
}
