import PikosSupport
import SwiftUI

struct CalendarSettings: View {
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings

        SettingsPage(title: "Calendar") {
            Section {
                Picker("Calendar density", selection: $settings.calendarDensity) {
                    ForEach(Preferences.CalendarDensity.allCases, id: \.self) { density in
                        Text(density.label).tag(density)
                    }
                }
            } footer: {
                Text("Calendar density sets how tall an hour is, so how much of the day fits on screen at once.")
            }

            Section {
                Picker("Week starts on", selection: $settings.weekStart) {
                    ForEach(Preferences.WeekStart.allCases, id: \.self) { start in
                        Text(start.label).tag(start)
                    }
                }
            } footer: {
                Text("Used by every date picker. Defaults to your region.")
            }

            Section {
                Picker("Early hours end", selection: $settings.calendarCollapse.topHour) {
                    ForEach(
                        CalendarGeometry.Collapse.earliestTopHour...CalendarGeometry.Collapse.latestTopHour,
                        id: \.self
                    ) { hour in
                        Text(Self.hourLabel(hour)).tag(hour)
                    }
                }
                Picker("Late hours start", selection: $settings.calendarCollapse.bottomHour) {
                    ForEach(
                        CalendarGeometry.Collapse.earliestBottomHour...CalendarGeometry.Collapse.latestBottomHour,
                        id: \.self
                    ) { hour in
                        Text(Self.hourLabel(hour)).tag(hour)
                    }
                }
            } header: {
                Text("Folded hours").sectionLabelStyle()
            } footer: {
                Text("The hours before and after these fold into a band at the top and foot of the calendar. Tap a band to open or fold it.")
            }
        }
    }

    /// An hour of the day as the calendar labels it, stepped from a real midnight.
    private static func hourLabel(_ hour: Int) -> String {
        let midnight = Calendar.current.startOfDay(for: .now)
        let date = Calendar.current.date(byAdding: .hour, value: hour, to: midnight) ?? midnight
        return date.formatted(.dateTime.hour())
    }
}
