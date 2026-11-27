import Foundation

/// The user's choices about how Pikos looks and behaves.
///
/// In the App Group's `UserDefaults` rather than the app's own, for the same reason as the
/// database: the widget is a separate process, and a widget that starts the week on Sunday while
/// the app starts it on Monday is a bug nobody can trace. `WorkspaceLocation.appGroupIdentifier`
/// is the one string both reach for.
///
/// Keys are namespaced and spelled once: renaming one silently drops the preference it holds.
///
/// `@unchecked` because the compiler cannot see that `UserDefaults` is thread-safe, as Apple
/// documents; without it `shared` is not expressible as a static under strict concurrency.
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

        /// Points per hour. What the setting changes is how many hours fit on screen, not how legible
        /// a short event is: a block shorter than `Metrics.minBlockHeight` is floored at every one of
        /// these, so the choice trades overview against the gap between a block's drawn height and
        /// its true length.
        public var hourHeight: Double {
            switch self {
            case .compact: return 48
            case .normal: return 64
            case .spacious: return 88
            }
        }
    }

    /// Which day a week starts on, as `Calendar.firstWeekday` numbers it: 1 is Sunday, 2 is Monday.
    ///
    /// Stored as that number rather than the desktop's 0/1 so it reaches `Calendar` without a
    /// conversion. The two scales differ by one, which is the kind of pair that gets mixed up.
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

    private enum Key {
        static let theme = "pikos.theme"
        static let listDensity = "pikos.listDensity"
        static let calendarDensity = "pikos.calendarDensity"
        static let calendarEarlyHoursEnd = "pikos.calendarEarlyHoursEnd"
        static let calendarLateHoursStart = "pikos.calendarLateHoursStart"
        static let calendarEarlyHoursFolded = "pikos.calendarEarlyHoursFolded"
        static let calendarLateHoursFolded = "pikos.calendarLateHoursFolded"
        static let weekStart = "pikos.weekStart"
        static let defaultFolderID = "pikos.defaultFolderId"
        static let remindersEnabled = "pikos.remindersEnabled"
        static let defaultReminderMinutes = "pikos.defaultReminderMinutes"
        /// Followed by the view's id: one order per folder, as the desktop
        /// keeps it.
        static let listSortPrefix = "pikos.listSort."
    }

    /// The lead a page with no reminder of its own gets, in minutes before its start. The desktop's
    /// default is ten too, but the two are separate settings because delivery is per device.
    public static let defaultReminderMinutesFallback: Int64 = 10

    /// The leads the settings screen offers. `-1` is the data layer's "never"
    /// sentinel, so "no default reminder" is a real value here rather than the
    /// toggle above it being off — the toggle silences everything, this only
    /// the pages that never asked.
    public static let reminderLeadChoices: [Int64] = [-1, 0, 5, 10, 15, 30, 60, 1440]

    /// Where these are written. Injectable so a test can point at a throwaway suite instead of the
    /// device's real one.
    public let store: UserDefaults

    public init(store: UserDefaults) {
        self.store = store
    }

    /// The App Group's defaults, or the standard ones if it is not available. Unlike the database,
    /// a missing group is survivable here: preferences that miss the widget degrade, where a
    /// database it cannot see shows nothing. `WorkspaceLocation.databaseURL()` stays the one place
    /// that fails loudly about provisioning.
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

    /// The calendar's early and late hours and whether each is folded into a band. The desktop's
    /// defaults: midnight to 6 AM and 10 PM to midnight, both folded. Kept per device, as the
    /// desktop keeps its own.
    public var calendarCollapse: CalendarGeometry.Collapse {
        get {
            CalendarGeometry.Collapse(
                topHour: integer(Key.calendarEarlyHoursEnd, default: 6),
                bottomHour: integer(Key.calendarLateHoursStart, default: 22),
                topCollapsed: bool(Key.calendarEarlyHoursFolded, default: true),
                bottomCollapsed: bool(Key.calendarLateHoursFolded, default: true))
        }
        set {
            store.set(newValue.topHour, forKey: Key.calendarEarlyHoursEnd)
            store.set(newValue.bottomHour, forKey: Key.calendarLateHoursStart)
            store.set(newValue.topCollapsed, forKey: Key.calendarEarlyHoursFolded)
            store.set(newValue.bottomCollapsed, forKey: Key.calendarLateHoursFolded)
        }
    }

    /// Defaults to the device's own idea of the week, which is right for most people.
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
    /// Stored as the folder's id, which can outlive the folder. Every reader copes with an id naming
    /// nothing (see `WorkspaceStore.defaultFolder`), since clearing it on delete would couple the
    /// settings screen to the folder-delete path.
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

    /// Whether the phone plans local notifications for reminders at all. On by default: a reminder
    /// the user typed and never heard is the worse surprise. The OS permission still gates delivery.
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
    /// Per view, like the desktop. The fallback is the caller's to decide, because whether the view
    /// is a calendar's folder is a fact the workspace holds and this file does not.
    public func listSort(for viewId: String, fallback: PageSort.Mode = .manual) -> PageSort.Mode {
        guard let raw = store.string(forKey: Key.listSortPrefix + viewId),
            let mode = PageSort.Mode(rawValue: raw)
        else { return fallback }
        return mode
    }

    public mutating func setListSort(_ mode: PageSort.Mode, for viewId: String) {
        store.set(mode.rawValue, forKey: Key.listSortPrefix + viewId)
    }

    /// Forget every stored preference, returning each to its default. Sweeps the keys named above
    /// rather than the whole suite, which also holds anything else the App Group has put there.
    public func resetAll() {
        for key in [
            Key.theme, Key.listDensity, Key.calendarDensity, Key.weekStart, Key.defaultFolderID,
            Key.remindersEnabled, Key.defaultReminderMinutes, Key.calendarEarlyHoursEnd,
            Key.calendarLateHoursStart, Key.calendarEarlyHoursFolded, Key.calendarLateHoursFolded,
        ] {
            store.removeObject(forKey: key)
        }
        // The per-view orders, whatever views exist.
        for key in store.dictionaryRepresentation().keys where key.hasPrefix(Key.listSortPrefix) {
            store.removeObject(forKey: key)
        }
    }

    /// Read a raw-representable preference, falling back when the stored string names nothing: a
    /// build that renames a case leaves the old spelling in everyone's defaults.
    private func integer(_ key: String, default fallback: Int) -> Int {
        store.object(forKey: key) == nil ? fallback : store.integer(forKey: key)
    }

    private func bool(_ key: String, default fallback: Bool) -> Bool {
        store.object(forKey: key) == nil ? fallback : store.bool(forKey: key)
    }

    private func read<T: RawRepresentable>(_ key: String, default fallback: T) -> T
    where T.RawValue == String {
        guard let raw = store.string(forKey: key), let value = T(rawValue: raw) else {
            return fallback
        }
        return value
    }
}
