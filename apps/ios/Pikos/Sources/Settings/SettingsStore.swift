import Observation
import PikosSupport
import SwiftUI

/// The user's preferences, as something SwiftUI can watch.
///
/// `Preferences` is a value over `UserDefaults` — right for the widget, which
/// reads once and renders, and wrong for the app, where changing the theme has
/// to redraw everything currently on screen. This is the thin observable layer
/// over it: the storage stays in `PikosSupport` where the widget can reach it,
/// and the observation stays here where only the app needs it.
///
/// Every property writes through immediately rather than on a "Done" button.
/// A settings screen that can be dismissed without saving is a screen that can
/// lose a choice, and on a phone it is dismissed by swiping — which nobody
/// reads as discarding anything.
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

    /// How a view's list is ordered.
    ///
    /// `Preferences` is a plain value, so a read through it is not observed;
    /// the version below is what a list watches, bumped on every write so the
    /// rows re-sort the moment the menu is used.
    public func listSort(for viewId: String, fallback: PageSort.Mode = .manual) -> PageSort.Mode {
        _ = sortVersion
        return preferences.listSort(for: viewId, fallback: fallback)
    }

    public func setListSort(_ mode: PageSort.Mode, for viewId: String) {
        preferences.setListSort(mode, for: viewId)
        sortVersion += 1
    }

    private var sortVersion = 0

    /// A lead in words, for the picker and its row.
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

    /// What `theme` means to SwiftUI. `nil` is "follow the system", which is
    /// the absence of an override rather than a third scheme.
    public var colorScheme: ColorScheme? {
        switch theme {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// The reader's calendar with their week start applied.
    ///
    /// Put into the environment at the root so every `DatePicker` and date view
    /// below picks it up, rather than each one remembering to ask. Built from
    /// `Calendar.current` so the identifier, locale and time zone stay the
    /// device's — only the first weekday is ours to change.
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
