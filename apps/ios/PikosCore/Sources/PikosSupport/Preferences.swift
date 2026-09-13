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
    }

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

    /// Forget every stored preference, returning each to its default.
    ///
    /// Sweeps the keys named above rather than the whole suite: the suite also
    /// holds anything else the App Group has put there, and a settings reset
    /// that wipes a neighbour's state is a surprise.
    public func resetAll() {
        for key in [
            Key.theme, Key.listDensity, Key.calendarDensity, Key.weekStart, Key.defaultFolderID,
        ] {
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
