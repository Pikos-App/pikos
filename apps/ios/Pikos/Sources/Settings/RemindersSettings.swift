import PikosCore
import PikosSupport
import SwiftUI
import UIKit

/// The two switches a reminder passes through — ours and the system's —
/// and the one lead that applies when a page never asked for its own.
///
/// The system's state is shown here rather than discovered, because a
/// reminder that never arrives looks the same whether it was never
/// planned or never allowed, and only one of those is fixed on this
/// screen. Denied permission gets a link to where it is fixed.
struct RemindersSettings: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(ReminderScheduler.self) private var reminders

    var body: some View {
        @Bindable var settings = settings

        SettingsPage(title: "Reminders") {
            Section {
                Toggle("Remind me", isOn: $settings.remindersEnabled)
                    .tint(.interactiveFill)

                if settings.remindersEnabled {
                    Picker("Default reminder", selection: $settings.defaultReminderMinutes) {
                        ForEach(Preferences.reminderLeadChoices, id: \.self) { minutes in
                            Text(SettingsStore.leadLabel(minutes)).tag(minutes)
                        }
                    }

                    switch reminders.authorization {
                    case .denied:
                        LabeledContent("Notifications") {
                            Text("Off in Settings").foregroundStyle(.statusOverdue)
                        }
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                            Link("Allow notifications for Pikos", destination: url)
                        }
                    case .notDetermined:
                        Button("Allow notifications") {
                            Task { await reminders.requestAuthorization() }
                        }
                    default:
                        // The next one, not a count: "Dentist, today at 2:30 PM"
                        // is a claim the reader can check against their day, and
                        // "7 reminders" is not.
                        if let next = reminders.nextPlanned {
                            LabeledContent("Next") {
                                VStack(alignment: .trailing, spacing: 1) {
                                    Text(next.title.isEmpty ? "Untitled" : next.title)
                                        .lineLimit(1)
                                    Text(
                                        ReminderNotification.body(
                                            scheduledStart: next.fireAt,
                                            fireAt: WallClockDay.instant(from: Date()))
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.textSecondary)
                                }
                            }
                        } else {
                            LabeledContent("Next", value: String(localized: "Nothing in the next two weeks"))
                        }
                    }
                }
            } footer: {
                Text(remindersFooter)
            }
        }
        .task { await reminders.refreshAuthorization() }
    }

    private var remindersFooter: String {
        guard settings.remindersEnabled else {
            return String(localized: "Nothing rings on this phone. Reminders still fire on the desktop.")
        }
        return String(
            localized: "Pages without a reminder of their own use the default. Use a Focus to silence them at night."
        )
    }
}
