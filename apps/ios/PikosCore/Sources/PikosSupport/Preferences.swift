import Foundation

/// The user's choices about how Pikos looks and behaves.
///
/// In the App Group's `UserDefaults` rather than the app's own, for the same
/// reason the database is in the shared container: the widget and the share
/// extension are separate processes, and a Today widget that starts the week on
/// Sunday while the app starts it on Monday is a bug nobody can see the cause
/// of. `WorkspaceLocation.appGroupIdentifier` is the one string both reach for.
///
/// Deliberately *not* a mirror of the desktop's list. That one lives in
/// `localStorage` and covers panel widths, collapsed sections and a
/// three-column calendar — state a phone either does not have or does not let
/// the user choose. What is here is what changes something on this device;
/// `apps/ios/README.md` records what was left out and why.
///
/// Keys are namespaced and spelled once. The literal strings are load-bearing
/// the moment this ships: renaming one silently drops the preference it holds
/// and the user sees a setting reset itself.
/// `@unchecked` because the compiler cannot see that `UserDefaults` is safe to
/// share: Apple documents it as thread-safe, and this type adds no state of its
/// own beyond the reference. Without it, `shared` is not expressible as a
/// static under strict concurrency.
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
        /// Normal is 64, which is what the grid used before this was
        /// adjustable. What the setting changes is how many hours fit on the
        /// screen at once, not how legible a short event is — a block shorter
        /// than `Metrics.minBlockHeight` is floored at every one of these,
        /// including normal, where a 15-minute slot is 16 points and the floor
        /// is 22. So the choice trades overview against the gap between a
        /// block's drawn height and its true length.
        public var hourHeight: Double {
            switch self {
            case .compact: return 48
            case .normal: return 64
            case .spacious: return 88
            }
        }
    }

    /// Which day a week starts on, as `Calendar.firstWeekday` numbers it —
    /// 1 is Sunday, 2 is Monday.
    ///
    /// Stored as that number rather than as the desktop's 0/1 so it can be
    /// handed to `Calendar` without a conversion at every call site. The two
    /// scales differ by one and both call Monday "the other one", which is
    /// exactly the sort of pair that gets mixed up silently.
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
        static let weekStart = "pikos.weekStart"
        static let defaultFolderID = "pikos.defaultFolderId"
        static let remindersEnabled = "pikos.remindersEnabled"
        static let defaultReminderMinutes = "pikos.defaultReminderMinutes"
        static let recentSearches = "pikos.recentSearches"
        /// Followed by the view's id: one order per folder, as the desktop
        /// keeps it.
        static let listSortPrefix = "pikos.listSort."
    }

    /// How many past searches the search screen offers back.
    ///
    /// Eight is what fits above the keyboard without the list itself needing
    /// to scroll, and further back than that a search is one the reader would
    /// retype faster than find.
    public static let recentSearchLimit = 8

    /// The lead a page with no reminder of its own gets, in minutes before its
    /// start. Ten, which is the desktop's default too; the two are separate
    /// settings because delivery is per device, and a phone in a pocket and a
    /// desktop across the room reasonably want different leads.
    public static let defaultReminderMinutesFallback: Int64 = 10

    /// The leads the settings screen offers. `-1` is the data layer's "never"
    /// sentinel, so "no default reminder" is a real value here rather than the
    /// toggle above it being off — the toggle silences everything, this only
    /// the pages that never asked.
    public static let reminderLeadChoices: [Int64] = [-1, 0, 5, 10, 15, 30, 60, 1440]

    /// Where these are written.
    ///
    /// Injectable rather than reached for globally, so a test can point at a
    /// throwaway suite instead of the device's real one — and so the fallback
    /// behaviour below is testable at all rather than asserted in a comment.
    public let store: UserDefaults

    public init(store: UserDefaults) {
        self.store = store
    }

    /// The App Group's defaults, or the standard ones if it is not available.
    ///
    /// Unlike the database, a missing App Group is survivable here: preferences
    /// that do not reach the widget are a degraded experience, where a database
    /// the widget cannot see is a widget showing nothing. So this falls back
    /// rather than throwing, and `WorkspaceLocation.databaseURL()` remains the
    /// one place that fails loudly about provisioning.
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

    /// Defaults to the device's own idea of the week, which is already the
    /// right answer for most people and is what every other app on the phone
    /// does. Only somebody who disagrees with their region setting ever needs
    /// to touch this.
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
    /// Stored as the folder's id, which can outlive the folder. Every reader
    /// has to cope with an id naming nothing — see
    /// `WorkspaceStore.defaultFolder` — because clearing it on delete would
    /// mean the settings screen reaching into the folder-delete path, and a
    /// stale id that resolves to the Inbox is the same outcome with none of
    /// the coupling.
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
    /// surprise. The OS's own permission still gates delivery, so "on" with
    /// permission denied plans nothing — the settings screen says which.
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

    /// The last few searches, newest first.
    ///
    /// Not a preference the reader sets, but it lives beside them for the same
    /// reason they are in the App Group: a search typed in the app is one a
    /// widget or an intent could reasonably offer back, and the phone is the
    /// device on which retyping costs the most.
    public var recentSearches: [String] {
        get { store.stringArray(forKey: Key.recentSearches) ?? [] }
        set { store.set(newValue, forKey: Key.recentSearches) }
    }

    /// Remember a search that was actually run.
    ///
    /// Only a submitted query, never a keystroke: a list of recents that holds
    /// "q", "qu", "qua" is a list nobody reuses. A repeat moves to the front
    /// rather than appearing twice, comparison is case-insensitive so "Dentist"
    /// and "dentist" are one memory, and blank input is not a search.
    public mutating func remember(search raw: String) {
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        var searches = recentSearches.filter {
            $0.compare(query, options: [.caseInsensitive, .diacriticInsensitive]) != .orderedSame
        }
        searches.insert(query, at: 0)
        recentSearches = Array(searches.prefix(Self.recentSearchLimit))
    }

    public mutating func clearRecentSearches() {
        store.removeObject(forKey: Key.recentSearches)
    }

    /// How one view's list is ordered, or `fallback` when nobody has chosen.
    ///
    /// Per view, like the desktop: a folder of reference notes wants its own
    /// arrangement while a calendar's folder is chronology, and one setting
    /// for both would be wrong for one of them. The fallback is the caller's
    /// to decide, because whether the view is a calendar's folder is a fact
    /// the workspace holds and this file does not.
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
    /// Sweeps the keys named above rather than the whole suite: the suite also
    /// holds anything else the App Group has put there, and a settings reset
    /// that wipes a neighbour's state is a surprise. The recent searches go
    /// too — they are not a setting, but "reset" is the one button a person
    /// reaches for to make the app forget things about them.
    public func resetAll() {
        for key in [
            Key.theme, Key.listDensity, Key.calendarDensity, Key.weekStart, Key.defaultFolderID,
            Key.remindersEnabled, Key.defaultReminderMinutes, Key.recentSearches,
        ] {
            store.removeObject(forKey: key)
        }
        // The per-view orders, whatever views exist.
        for key in store.dictionaryRepresentation().keys where key.hasPrefix(Key.listSortPrefix) {
            store.removeObject(forKey: key)
        }
    }

    /// Read a raw-representable preference, falling back when the stored string
    /// names nothing.
    ///
    /// The fallback is not theoretical: a build that renames a case leaves the
    /// old spelling in everyone's defaults, and an unrecognised value must read
    /// as "not set" rather than crash the screen that shows it.
    private func read<T: RawRepresentable>(_ key: String, default fallback: T) -> T
    where T.RawValue == String {
        guard let raw = store.string(forKey: key), let value = T(rawValue: raw) else {
            return fallback
        }
        return value
    }
}
