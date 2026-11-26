import Observation
import PikosSupport
import SwiftUI

/// The user's preferences, observable by SwiftUI.
///
/// `Preferences` is a value over `UserDefaults`, right for the widget and not for the app,
/// where a theme change must redraw. Every property writes through immediately: a settings
/// screen is dismissed by swiping, which nobody reads as discarding a choice.
@MainActor
@Observable
public final class SettingsStore {
    private var preferences: Preferences

    public init(preferences: Preferences = .shared) {
        self.preferences = preferences
    }

    public var theme: Preferences.Theme {
        get { preferences.theme }
        set { preferences.theme = newValue }
    }

    public var listDensity: Preferences.ListDensity {
        get { preferences.listDensity }
        set { preferences.listDensity = newValue }
    }

    public var calendarDensity: Preferences.CalendarDensity {
        get { preferences.calendarDensity }
        set { preferences.calendarDensity = newValue }
    }

    public var calendarCollapse: CalendarGeometry.Collapse {
        get { preferences.calendarCollapse }
        set { preferences.calendarCollapse = newValue }
    }

    public var weekStart: Preferences.WeekStart {
        get { preferences.weekStart }
        set { preferences.weekStart = newValue }
    }

    public var defaultFolderID: String? {
        get { preferences.defaultFolderID }
        set { preferences.defaultFolderID = newValue }
    }

    public var remindersEnabled: Bool {
        get { preferences.remindersEnabled }
        set { preferences.remindersEnabled = newValue }
    }

    public var defaultReminderMinutes: Int64 {
        get { preferences.defaultReminderMinutes }
        set { preferences.defaultReminderMinutes = newValue }
    }

    /// A read through the plain-value `Preferences` isn't observed, so lists watch `sortVersion`,
    /// bumped on every write, to re-sort at once.
    public func listSort(for viewId: String, fallback: PageSort.Mode = .manual) -> PageSort.Mode {
        _ = sortVersion
        return preferences.listSort(for: viewId, fallback: fallback)
    }

    public func setListSort(_ mode: PageSort.Mode, for viewId: String) {
        preferences.setListSort(mode, for: viewId)
        sortVersion += 1
    }

    private var sortVersion = 0

    public static func leadLabel(_ minutes: Int64) -> String {
        switch minutes {
        case ..<0: return String(localized: "None")
        case 0: return String(localized: "At the time")
        case 1440: return String(localized: "1 day before")
        case 60: return String(localized: "1 hour before")
        case let hours where hours % 60 == 0:
            return String(localized: "\(hours / 60) hours before")
        default: return String(localized: "\(minutes) minutes before")
        }
    }

    /// `nil` follows the system: the absence of an override, not a third scheme.
    public var colorScheme: ColorScheme? {
        switch theme {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// The reader's calendar with their week start applied, put in the environment at the root.
    /// Built from `Calendar.current` so only the first weekday changes.
    public var calendar: Calendar {
        var calendar = Calendar.current
        calendar.firstWeekday = weekStart.rawValue
        return calendar
    }

    public func resetAll() {
        preferences.resetAll()
        sortVersion += 1
    }
}
