import PikosCore
import PikosSupport
import SwiftUI

/// The desktop's reminder dropdown, as a chip in the page header's byline.
///
/// Shown only on a scheduled page, since a reminder leads from a start. A timed page offers
/// the desktop's leads and an all-day page the day-before anchor. Tapping a lead the page has
/// takes it off. Stays editable on a page a calendar owns: reminders are the reader's.
struct ReminderChip: View {
    let pageId: String
    let isAllDay: Bool

    @Environment(WorkspaceStore.self) private var store
    @Environment(SettingsStore.self) private var settings
    @State private var reminders = PageReminders([])

    var body: some View {
        Menu {
            if !settings.remindersEnabled {
                Text("Reminders are off in Settings")
            }
            Button {
                Task {
                    reminders = reminders.isNever
                        ? await store.clearReminders(pageId: pageId)
                        : await store.setNeverRemind(pageId: pageId)
                }
            } label: {
                Label("None", systemImage: reminders.isNever ? "checkmark" : "bell.slash")
            }
            Divider()
            ForEach(PageReminders.choices(allDay: isAllDay), id: \.self) { choice in
                Button {
                    Task { reminders = await store.toggleReminder(pageId: pageId, minutes: choice) }
                } label: {
                    Label(
                        Self.label(choice),
                        systemImage: reminders.isOn(
                            choice, allDay: isAllDay, defaultMinutes: settings.defaultReminderMinutes)
                            ? "checkmark" : "bell")
                }
            }
            if reminders.hasOwn || reminders.isNever {
                Divider()
                Button(isAllDay ? "Clear" : "Reset to Default") {
                    Task { reminders = await store.clearReminders(pageId: pageId) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                Text(summary).lineLimit(1)
            }
            .foregroundStyle(.textTertiary)
            .touchTarget()
        }
        .accessibilityLabel("Reminders: \(summary)")
        .task(id: pageId) { reminders = await store.reminders(pageId: pageId) }
    }

    private var effective: [Int64] {
        reminders.effective(allDay: isAllDay, defaultMinutes: settings.defaultReminderMinutes)
    }

    private var symbol: String {
        if reminders.isNever { return "bell.slash" }
        return reminders.hasOwn ? "bell.fill" : "bell"
    }

    private var summary: String {
        if reminders.isNever { return String(localized: "No reminder") }
        guard let first = effective.first else { return String(localized: "Remind") }
        let lead = Self.shortLabel(first)
        return effective.count == 1 ? lead : "\(lead) +\(effective.count - 1)"
    }

    /// Short enough to sit in the byline beside the date.
    static func shortLabel(_ minutes: Int64) -> String {
        switch minutes {
        case PageReminders.dayBefore: return String(localized: "Day before")
        case 0: return String(localized: "At start")
        case let days where days > 0 && days % 1440 == 0: return days == 1440 ? String(localized: "1 day") : String(localized: "\(days / 1440) days")
        case let hours where hours > 0 && hours % 60 == 0: return String(localized: "\(hours / 60) hr")
        default: return String(localized: "\(minutes) min")
        }
    }

    /// The desktop's labels for each choice.
    static func label(_ minutes: Int64) -> String {
        switch minutes {
        case PageReminders.dayBefore: return String(localized: "Day before at 9:00")
        case 0: return String(localized: "At time of event")
        case 1440: return String(localized: "1 day before")
        case 60: return String(localized: "1 hour before")
        case let hours where hours > 0 && hours % 60 == 0:
            return String(localized: "\(hours / 60) hours before")
        default: return String(localized: "\(minutes) min before")
        }
    }
}
