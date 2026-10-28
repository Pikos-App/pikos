import AppIntents
import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// What every widget in the bundle shares: how it opens the workspace, how it
/// draws a page, and how it names a time.
///
/// One file rather than a copy per widget, for the reason the app's
/// `PageRow` is one view: widgets each drawing their own row is how the
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

/// One page: a ring that finishes it and a title that opens it.
///
/// The ring is a real button, so a task can be ticked from the home screen
/// without the app ever coming to the front — the thing a widget is for. The
/// title opens its page where there is room to aim; on the small size it
/// falls through to the widget's own link, since three rows in a two-inch
/// square are not something a thumb can pick between — but the ring is a
/// target of its own even there.
struct WidgetPageRow: View {
    /// How big a row is drawn. A list of pages is the whole of the List widget, so its rows are
    /// drawn at reading size, its detail at the right edge and its box a target a thumb can find
    /// beside the title's link; the Now widget packs a headline and the day's hours around its rows.
    enum Size {
        case compact
        case list
    }

    let page: PageSummary
    /// Whether the title is its own link to the page.
    var linksToPage = true
    /// What to say beside the title, if anything: a time, a day.
    var detail: String? = nil
    var lineLimit = 1
    var size = Size.compact

    var body: some View {
        let isList = size == .list
        HStack(alignment: .firstTextBaseline, spacing: isList ? 8 : 5) {
            checkbox(isList: isList)

            let title = HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let detail, !isList {
                    detailText(detail, isList: false)
                }
                titleText(isList: isList)
            }
            if linksToPage, let url = URL(string: "pikos://page/\(page.id)") {
                Link(destination: url) { title }
            } else {
                title
            }
            Spacer(minLength: 0)
            if let detail, isList {
                detailText(detail, isList: true)
            }
        }
    }

    private func checkbox(isList: Bool) -> some View {
        let isDone = page.status == "done"
        return Button(intent: CompletePageIntent(pageId: page.id, done: !isDone)) {
            Image(systemName: isDone ? "checkmark.square.fill" : "square")
                .font(isList ? .body : .caption2)
                .foregroundStyle(isDone ? WidgetInk.secondary : ringColor(priority: page.priority))
                // Drawn dimmed while the tap is being written, so the
                // moment between the touch and the reload reads as
                // "working" rather than "ignored".
                .invalidatableContent()
                .frame(minWidth: isList ? 24 : nil, minHeight: isList ? 24 : nil, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isDone ? "Reopen" : "Mark as done")
    }

    private func titleText(isList: Bool) -> some View {
        let isDone = page.status == "done"
        return Text(displayTitle(page))
            .font(isList ? .subheadline : .caption)
            .strikethrough(isDone, color: WidgetInk.secondary)
            .foregroundStyle(isDone ? WidgetInk.secondary : WidgetInk.primary)
            .lineLimit(lineLimit)
            // A link centres a wrapped label; a row's second line starts under its first.
            .multilineTextAlignment(.leading)
    }

    private func detailText(_ detail: String, isList: Bool) -> some View {
        Text(detail)
            .font((isList ? Font.footnote : .caption2).monospacedDigit())
            .foregroundStyle(WidgetInk.secondary)
            .lineLimit(1)
            .fixedSize()
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
            .foregroundStyle(WidgetInk.secondary)
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
    let clock = ClockTime.string(time)
    return day == today ? clock : "\(dayLabel) \(clock)"
}
