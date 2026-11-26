import Foundation

/// The user's choices about how Pikos looks and behaves.
///
/// Stored in the App Group's `UserDefaults`, not the app's own: the widget and
/// the share extension are separate processes, and they must agree with the app
/// (a Today widget starting the week on Sunday while the app starts it on Monday).
// `@unchecked` because `UserDefaults` is documented thread-safe and this type adds no
// state beyond the reference; without it `shared` can't be a static under strict concurrency.
public struct Preferences: @unchecked Sendable {
    /// How Pikos follows, or ignores, the system appearance.
    public enum Theme: String, CaseIterable, Sendable {
        case system, light, dark

        public var label: String {
            switch self {
            case .system: return "System"
            case .light: return "Light"
            case .dark: return "Dark"
            }
        }
    }

    /// How tightly list rows pack.
    public enum ListDensity: String, CaseIterable, Sendable {
        case compact, cozy, spacious

        public var label: String {
            switch self {
            case .compact: return "Compact"
            case .cozy: return "Cozy"
            case .spacious: return "Spacious"
            }
        }

        /// Extra vertical padding per row, above the row's own layout.
        public var rowPadding: Double {
            switch self {
            case .compact: return 0
            case .cozy: return 2
            case .spacious: return 6
            }
        }
    }

    /// How tall an hour renders in the calendar.
    public enum CalendarDensity: String, CaseIterable, Sendable {
        case compact, normal, spacious

        public var label: String {
            switch self {
            case .compact: return "Compact"
            case .normal: return "Normal"
            case .spacious: return "Spacious"
            }
        }

        /// Points per hour.
        ///
        /// Changes how many hours fit on screen, not how legible a short event is:
        /// a block shorter than `Metrics.minBlockHeight` is floored at every
        /// density, so the choice trades overview against the gap between a
        /// block's drawn height and its true length.
        public var hourHeight: Double {
            switch self {
            case .compact: return 48
            case .normal: return 64
            case .spacious: return 88
            }
        }
    }

    /// Which day a week starts on, as `Calendar.firstWeekday` numbers it:
    /// 1 is Sunday, 2 is Monday.
    ///
    /// Not the desktop's 0/1 scale, which differs by one and would be mixed up silently.
    public enum WeekStart: Int, CaseIterable, Sendable {
        case sunday = 1
        case monday = 2

        public var label: String {
            switch self {
            case .sunday: return "Sunday"
            case .monday: return "Monday"
            }
        }
    }

    /// The literal strings are persisted: renaming one silently resets that setting.
    private enum Key {
        static let theme = "pikos.theme"
        static let listDensity = "pikos.listDensity"
        static let calendarDensity = "pikos.calendarDensity"
        static let weekStart = "pikos.weekStart"
        static let defaultFolderID = "pikos.defaultFolderId"
        static let remindersEnabled = "pikos.remindersEnabled"
        static let defaultReminderMinutes = "pikos.defaultReminderMinutes"
        /// Followed by the view's id.
        static let listSortPrefix = "pikos.listSort."
    }

    /// The lead a page with no reminder of its own gets, in minutes before its
    /// start. Separate from the desktop's setting because delivery is per device.
    public static let defaultReminderMinutesFallback: Int64 = 10

    /// The leads the settings screen offers. `-1` is the data layer's "never"
    /// sentinel: "no default reminder" only silences pages that never asked,
    /// where the reminders toggle silences everything.
    public static let reminderLeadChoices: [Int64] = [-1, 0, 5, 10, 15, 30, 60, 1440]

    public let store: UserDefaults

    public init(store: UserDefaults) {
        self.store = store
    }

    /// The App Group's defaults, or the standard ones if it is not available.
    ///
    /// Unlike the database, a missing App Group is survivable: preferences that
    /// miss the widget degrade it, where a database it can't see empties it.
    /// `WorkspaceLocation.databaseURL()` is the one place that fails loudly.
    public static let shared = Preferences(
        store: UserDefaults(suiteName: WorkspaceLocation.appGroupIdentifier) ?? .standard)

    public var theme: Theme {
        get { read(Key.theme, default: .system) }
        set { store.set(newValue.rawValue, forKey: Key.theme) }
    }

    public var listDensity: ListDensity {
        get { read(Key.listDensity, default: .cozy) }
        set { store.set(newValue.rawValue, forKey: Key.listDensity) }
    }

    public var calendarDensity: CalendarDensity {
        get { read(Key.calendarDensity, default: .normal) }
        set { store.set(newValue.rawValue, forKey: Key.calendarDensity) }
    }

    /// Defaults to the device's region setting until the user chooses.
    public var weekStart: WeekStart {
        get {
            guard store.object(forKey: Key.weekStart) != nil else {
                return WeekStart(rawValue: Calendar.current.firstWeekday) ?? .monday
            }
            return WeekStart(rawValue: store.integer(forKey: Key.weekStart)) ?? .monday
        }
        set { store.set(newValue.rawValue, forKey: Key.weekStart) }
    }

    /// Where a new page lands when nothing else says. `nil` is the Inbox.
    ///
    /// The id can outlive the folder, so every reader has to cope with an id
    /// naming nothing (see `WorkspaceStore.defaultFolder`). Clearing it on delete
    /// would couple settings to the folder-delete path for the same outcome.
    public var defaultFolderID: String? {
        get { store.string(forKey: Key.defaultFolderID) }
        set {
            if let newValue {
                store.set(newValue, forKey: Key.defaultFolderID)
            } else {
                store.removeObject(forKey: Key.defaultFolderID)
            }
        }
    }

    /// Whether the phone plans local notifications for reminders at all.
    ///
    /// On by default: a reminder the user typed and never heard is the worse
    /// surprise. The OS permission still gates delivery, so "on" with
    /// permission denied plans nothing.
    public var remindersEnabled: Bool {
        get {
            guard store.object(forKey: Key.remindersEnabled) != nil else { return true }
            return store.bool(forKey: Key.remindersEnabled)
        }
        set { store.set(newValue, forKey: Key.remindersEnabled) }
    }

    /// Minutes before a page's start that a page without its own reminder
    /// rings, or `-1` for never.
    public var defaultReminderMinutes: Int64 {
        get {
            guard store.object(forKey: Key.defaultReminderMinutes) != nil else {
                return Self.defaultReminderMinutesFallback
            }
            return Int64(store.integer(forKey: Key.defaultReminderMinutes))
        }
        set { store.set(Int(newValue), forKey: Key.defaultReminderMinutes) }
    }

    /// How one view's list is ordered, or `fallback` when nobody has chosen.
    ///
    /// Per view, since a folder of notes and a calendar's folder want different
    /// orders. The caller picks `fallback` because only the workspace knows
    /// whether the view is a calendar's folder.
    public func listSort(for viewId: String, fallback: PageSort.Mode = .manual) -> PageSort.Mode {
        guard let raw = store.string(forKey: Key.listSortPrefix + viewId),
            let mode = PageSort.Mode(rawValue: raw)
        else { return fallback }
        return mode
    }

    public mutating func setListSort(_ mode: PageSort.Mode, for viewId: String) {
        store.set(mode.rawValue, forKey: Key.listSortPrefix + viewId)
    }

    /// Forget every stored preference, returning each to its default.
    ///
    /// Sweeps only these keys, not the suite, which holds other App Group state.
    public func resetAll() {
        for key in [
            Key.theme, Key.listDensity, Key.calendarDensity, Key.weekStart, Key.defaultFolderID,
            Key.remindersEnabled, Key.defaultReminderMinutes,
        ] {
            store.removeObject(forKey: key)
        }
        for key in store.dictionaryRepresentation().keys where key.hasPrefix(Key.listSortPrefix) {
            store.removeObject(forKey: key)
        }
    }

    /// Falls back when the stored string names nothing: a build that renames a
    /// case leaves the old spelling in defaults, and that must read as "not set".
    private func read<T: RawRepresentable>(_ key: String, default fallback: T) -> T
    where T.RawValue == String {
        guard let raw = store.string(forKey: key), let value = T(rawValue: raw) else {
            return fallback
        }
        return value
    }
}
