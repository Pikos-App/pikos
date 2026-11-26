import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// What every widget in the bundle shares: how it opens the workspace, how it draws a page, and
/// how it names a time. One file so each widget doesn't draw its own row, which is how the ring
/// ends up a different size on the lock screen than on the home screen.

// MARK: - Opening the workspace

enum WidgetWorkspace {
    /// The workspace, read-only, or a thrown error naming why not. `openExisting` never creates or
    /// migrates: a widget woken before the app has run must show nothing, not leave an empty
    /// workspace behind.
    static func open() async throws -> ReadOnlyWorkspace {
        let url = try WorkspaceLocation.databaseURL()
        return try await ReadOnlyWorkspace.openExisting(path: url.path)
    }
}

/// A completion handler WidgetKit gave us, carried into a `Task`. Under strict concurrency a plain
/// closure can't be captured by the `@Sendable` closure a `Task` runs; the handler is called once,
/// from the task that owns this box, so the sharing the checker objects to never happens. A box,
/// not an async provider, because `StaticConfiguration` has no async variant of this protocol.
struct Completion<Value>: @unchecked Sendable {
    let call: (Value) -> Void
}

// MARK: - Time

enum WidgetClock {
    /// Now, as the wall-clock string the workspace compares schedules against (`2026-09-14T15:04`),
    /// built from Gregorian components like `DayLabel.today` since it is compared, not shown.
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

    /// The next hour boundary, when an item can become overdue, for the widgets that change with the
    /// clock rather than with a write.
    static func nextHour(after date: Date = .now) -> Date {
        Calendar.current.nextDate(
            after: date, matching: DateComponents(minute: 0), matchingPolicy: .nextTime)
            ?? date.addingTimeInterval(3600)
    }
}

/// A page's time of day as an instant, or nil for an all-day page. Resolved by `StorageTimestamp`
/// as the app's list does, so a widget and the list never disagree by an hour.
func timeOfDay(_ page: PageSummary) -> Date? {
    guard let start = page.scheduledStart, start.contains("T") else { return nil }
    return StorageTimestamp.wallClock(start)
}

/// The instant a page is scheduled for, all-day pages landing on noon.
func scheduledInstant(_ page: PageSummary) -> Date? {
    page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) }
}

// MARK: - Drawing a page

/// What every home-screen widget is drawn on, and the app's debug widget gallery with it: the app's
/// own ground rather than the system's blue-gray fill.
enum WidgetGround {
    static var style: Color { Color(PikosToken.surfacePrimary) }
}

/// The widgets' text colours. Named tokens rather than `.primary` and `.secondary`: a hierarchical
/// style inside a `Link` resolves against the link's tint, which turned every time label teal.
enum WidgetInk {
    static var primary: Color { Color(PikosToken.textPrimary) }
    static var secondary: Color { Color(PikosToken.textTertiary) }
    static var action: Color { Color(PikosToken.textAction) }
    static var rule: Color { Color(PikosToken.borderSecondary) }
}

/// The stroke the app's `CompletionToggle` gives the checkbox: red for urgent, amber for high, and
/// neutral otherwise. Spelled here rather than shared: the app's `PagePriority` lives in the app
/// target, and two colours are cheaper than a third package target.
func ringColor(priority: Int64) -> Color {
    switch priority {
    case 1: return Color(PikosToken.statusOverdue)
    case 2: return Color(PikosToken.statusDueSoon)
    default: return WidgetInk.secondary
    }
}

/// The time left until `end`, to the minute. The `.relative` style counts seconds, which wraps a
/// small widget's headline and keeps it moving while nothing has changed.
func minutesLeft(until end: Date) -> Text {
    if #available(iOS 18.0, *) {
        Text(.now, format: .offset(to: end, allowedFields: [.hour, .minute], sign: .never))
    } else {
        Text(end, style: .relative)
    }
}

/// A page's title, never blank.
func displayTitle(_ page: PageSummary) -> String {
    page.title.isEmpty ? String(localized: "Untitled") : page.title
}

/// One page: a ring that finishes it and a title that opens it. The ring is a real button, so a
/// task can be ticked without the app coming to the front. The title links to its page where
/// there is room to aim; on the small size it falls through to the widget's own link.
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
                Image(systemName: isDone ? "checkmark.square.fill" : "square")
                    .font(.caption2)
                    .foregroundStyle(isDone ? WidgetInk.secondary : ringColor(priority: page.priority))
                    // Drawn dimmed while the tap is being written, so the gap reads as working, not ignored.
                    .invalidatableContent()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isDone ? "Reopen" : "Mark as done")

            let title = HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let detail {
                    Text(detail)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(WidgetInk.secondary)
                }
                Text(displayTitle(page))
                    .font(.caption)
                    .strikethrough(isDone, color: WidgetInk.secondary)
                    .foregroundStyle(isDone ? WidgetInk.secondary : WidgetInk.primary)
                    .lineLimit(lineLimit)
                    // A link centres a wrapped label; a row's second line starts under its first.
                    .multilineTextAlignment(.leading)
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

/// The sentence a widget shows instead of rows: a broken widget and an empty one look identical
/// otherwise, and the usual cause is an unconfigured App Group, so a failure is said.
struct WidgetNote: View {
    let text: LocalizedStringKey

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(WidgetInk.secondary)
    }
}

/// The time a page is due, as the short day-and-time the app's rows use. `today` is passed so an
/// entry rendered after midnight doesn't disagree with itself about which day is "Today".
func dueLabel(_ page: PageSummary, today: String) -> String? {
    guard let start = page.scheduledStart, let day = CalendarGeometry.day(of: start) else {
        return nil
    }
    let dayLabel = DayLabel.relative(day, today: today)
    guard let time = timeOfDay(page) else { return dayLabel }
    let clock = ClockTime.string(time)
    return day == today ? clock : "\(dayLabel) \(clock)"
}
