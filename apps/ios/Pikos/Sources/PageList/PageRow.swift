import PikosCore
import SwiftUI

/// The completion checkbox.
///
/// Its own view, placed beside the row's navigation link rather than inside it:
/// a Button inside a NavigationLink's label does not reliably receive the tap.
struct CompletionToggle: View {
    let isDone: Bool
    let onToggle: (Bool) -> Void

    var body: some View {
        Button {
            onToggle(!isDone)
        } label: {
            Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                .imageScale(.large)
                .foregroundStyle(isDone ? Color.accentColor : Color.secondary)
        }
        .buttonStyle(.plain)
        // A 17pt glyph is well under the 44pt minimum touch target, and this one
        // sits next to a navigation tap it must not steal.
        .contentShape(Rectangle())
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel(isDone ? "Mark as not done" : "Mark as done")
        .accessibilityAddTraits(isDone ? .isSelected : [])
    }
}

/// One page in the list, without its checkbox — see `CompletionToggle`.
struct PageRow: View {
    let page: PageSummary

    private var isDone: Bool { page.status == "done" }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(page.title.isEmpty ? "Untitled" : page.title)
                    .font(.body)
                    .strikethrough(isDone, color: .secondary)
                    .foregroundStyle(isDone ? Color.secondary : Color.primary)
                    .lineLimit(2)

                if let subtitle = page.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if let scheduled = page.scheduledStart {
                    ScheduleLabel(iso: scheduled)
                }
            }

            Spacer(minLength: 0)

            if !page.tags.isEmpty {
                Text(page.tags.first ?? "")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A page's schedule, formatted in the reader's locale.
///
/// The date arrives as a local wall-clock string with no zone, which is how
/// Pikos stores it — see the note on dates in the FFI. It is parsed with a
/// fixed-format parser and rendered with the user's own formatter, so the
/// storage format never leaks into what they read.
struct ScheduleLabel: View {
    let iso: String

    var body: some View {
        Text(formatted)
            .font(.caption)
            .foregroundStyle(isOverdue ? Color.red : Color.secondary)
    }

    private var isAllDay: Bool { !iso.contains("T") }

    private var date: Date? {
        let formatter = DateFormatter()
        // Fixed locale and no timezone conversion: the stored value is a wall
        // clock, and interpreting it in the user's zone is exactly right —
        // 09:00 means 09:00 wherever they are.
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = isAllDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.date(from: iso)
    }

    private var formatted: String {
        guard let date else { return iso }
        return date.formatted(
            isAllDay
                ? Date.FormatStyle(date: .abbreviated, time: .omitted)
                : Date.FormatStyle(date: .abbreviated, time: .shortened))
    }

    private var isOverdue: Bool {
        guard let date else { return false }
        return date < Date() && !Calendar.current.isDateInToday(date)
    }
}
