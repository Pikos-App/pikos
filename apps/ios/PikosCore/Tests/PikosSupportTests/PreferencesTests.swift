import XCTest

@testable import PikosSupport

/// The preference store's edges, which are the parts that bite.
///
/// Plain reads and writes are `UserDefaults` calls, and testing those tests
/// Foundation. What is worth pinning is what happens when a stored value is
/// *not* what this build expects — a case renamed since the value was written,
/// a preference never set — because each of those has a wrong answer that looks
/// like working code.
final class PreferencesTests: XCTestCase {
    private let suiteName = "app.pikos.tests.preferences"
    private var suite: UserDefaults!
    private var preferences: Preferences!

    override func setUp() {
        super.setUp()
        // A throwaway suite, so a test run never touches the device's real
        // defaults and two tests cannot see each other's writes.
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = UserDefaults(suiteName: suiteName)
        preferences = Preferences(store: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        preferences = nil
        super.tearDown()
    }

    func testUnsetPreferencesReadAsTheirDefaults() {
        XCTAssertEqual(preferences.theme, .system)
        XCTAssertEqual(preferences.listDensity, .cozy)
        XCTAssertEqual(preferences.calendarDensity, .normal)
        XCTAssertNil(preferences.defaultFolderID)
        // On, and ten minutes: the desktop's defaults, so a page created on
        // either device reminds the same way until somebody says otherwise.
        XCTAssertTrue(preferences.remindersEnabled)
        XCTAssertEqual(preferences.defaultReminderMinutes, 10)
    }

    /// "Off" and "never" are both real values that must survive a round trip:
    /// a stored `false` read back as the default `true` would be a reminder
    /// the user switched off ringing anyway.
    func testReminderChoicesSurviveIncludingTheOffAndNeverValues() {
        preferences.remindersEnabled = false
        preferences.defaultReminderMinutes = -1
        XCTAssertFalse(preferences.remindersEnabled)
        XCTAssertEqual(preferences.defaultReminderMinutes, -1)

        preferences.resetAll()
        XCTAssertTrue(preferences.remindersEnabled)
        XCTAssertEqual(preferences.defaultReminderMinutes, 10)
    }

    func testTheOfferedLeadsIncludeNeverAndAreAscending() {
        let choices = Preferences.reminderLeadChoices
        XCTAssertEqual(choices.first, -1)
        XCTAssertEqual(choices, choices.sorted())
        XCTAssertTrue(choices.contains(Preferences.defaultReminderMinutesFallback))
    }

    func testAChoiceSurvivesBeingWritten() {
        preferences.theme = .dark
        preferences.calendarDensity = .spacious
        preferences.defaultFolderID = "folder-1"

        // A second instance over the same suite: what the widget would see.
        let reread = Preferences(store: suite)
        XCTAssertEqual(reread.theme, .dark)
        XCTAssertEqual(reread.calendarDensity, .spacious)
        XCTAssertEqual(reread.defaultFolderID, "folder-1")
    }

    /// The case that produces an unrecognised value is renaming an enum case:
    /// every user who set the preference still has the old spelling in their
    /// defaults. Falling back is the difference between a setting that quietly
    /// reverts and a screen that cannot render.
    func testAValueThisBuildDoesNotRecogniseReadsAsTheDefault() {
        suite.set("neon", forKey: "pikos.theme")
        suite.set("roomy", forKey: "pikos.listDensity")
        XCTAssertEqual(preferences.theme, .system)
        XCTAssertEqual(preferences.listDensity, .cozy)
    }

    /// Unset is not the same as set-to-something. Week start defaults to the
    /// device's own region rather than to a constant, so most people never see
    /// the setting at all — but once they choose, the choice has to win even
    /// when it happens to match the region.
    func testWeekStartFollowsTheDeviceUntilItIsChosen() {
        XCTAssertEqual(
            preferences.weekStart.rawValue, Calendar.current.firstWeekday,
            "unset should follow the device")

        preferences.weekStart = .sunday
        XCTAssertEqual(Preferences(store: suite).weekStart, .sunday)
        preferences.weekStart = .monday
        XCTAssertEqual(Preferences(store: suite).weekStart, .monday)
    }

    func testClearingTheDefaultFolderReturnsToTheInbox() {
        preferences.defaultFolderID = "folder-1"
        preferences.defaultFolderID = nil
        XCTAssertNil(Preferences(store: suite).defaultFolderID)
    }

    /// Sweeps what it owns and nothing else. A settings reset that wiped a
    /// neighbour's state in the same App Group would be a surprise, and the
    /// obvious implementation — `removePersistentDomain` — does exactly that.
    func testResetForgetsOnlyItsOwnKeys() {
        preferences.theme = .dark
        preferences.weekStart = .sunday
        suite.set("not mine", forKey: "somethingElse")

        preferences.resetAll()

        let reread = Preferences(store: suite)
        XCTAssertEqual(reread.theme, .system)
        XCTAssertEqual(reread.weekStart.rawValue, Calendar.current.firstWeekday)
        XCTAssertEqual(suite.string(forKey: "somethingElse"), "not mine")
    }

    /// Stored by name, not by number, so inserting a case between two existing
    /// ones cannot silently reassign everybody's choice.
    func testDensitiesAreStoredByName() {
        XCTAssertEqual(Preferences.ListDensity.cozy.rawValue, "cozy")
        XCTAssertEqual(Preferences.CalendarDensity.spacious.rawValue, "spacious")
    }

    /// Week start uses `Calendar.firstWeekday`'s numbering, where Sunday is 1.
    /// The desktop's 0/1 scale is off by one from it, and both call Monday "the
    /// other one" — which is how a conversion gets dropped without anyone
    /// noticing until a calendar renders shifted by a day.
    func testWeekStartUsesFoundationsNumbering() {
        XCTAssertEqual(Preferences.WeekStart.sunday.rawValue, 1)
        XCTAssertEqual(Preferences.WeekStart.monday.rawValue, 2)

        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = Preferences.WeekStart.monday.rawValue
        XCTAssertEqual(calendar.firstWeekday, 2, "hands to Calendar without conversion")
    }

    /// Three choices that produce two outcomes is a setting that lies. Ordering
    /// matters for the same reason: "Compact" that renders taller than "Normal"
    /// is worse than no setting.
    func testEachDensityIsDistinctAndOrdered() {
        let heights = Preferences.CalendarDensity.allCases.map(\.hourHeight)
        XCTAssertEqual(heights, heights.sorted(), "compact through spacious should increase")
        XCTAssertEqual(Set(heights).count, heights.count)

        let padding = Preferences.ListDensity.allCases.map(\.rowPadding)
        XCTAssertEqual(padding, padding.sorted())
        XCTAssertEqual(Set(padding).count, padding.count)
    }

    /// A missing label shows as an empty picker row, which is invisible rather
    /// than obviously broken.
    func testEveryChoiceIsLabelled() {
        for theme in Preferences.Theme.allCases { XCTAssertFalse(theme.label.isEmpty) }
        for density in Preferences.ListDensity.allCases { XCTAssertFalse(density.label.isEmpty) }
        for density in Preferences.CalendarDensity.allCases {
            XCTAssertFalse(density.label.isEmpty)
        }
        for start in Preferences.WeekStart.allCases { XCTAssertFalse(start.label.isEmpty) }
    }

    // MARK: - Recent searches

    func testRecentSearchesStartEmptyAndRememberNewestFirst() {
        XCTAssertEqual(preferences.recentSearches, [])
        preferences.remember(search: "dentist")
        preferences.remember(search: "tag:work")
        XCTAssertEqual(preferences.recentSearches, ["tag:work", "dentist"])
    }

    /// A repeat moves to the front; it does not appear twice, and a different
    /// capitalisation of the same words is the same memory.
    func testARepeatedSearchMovesToTheFrontOnce() {
        preferences.remember(search: "dentist")
        preferences.remember(search: "budget")
        preferences.remember(search: "Dentist")
        XCTAssertEqual(preferences.recentSearches, ["Dentist", "budget"])
    }

    /// Whitespace is not a search, and neither is the empty string a
    /// keystroke-by-keystroke caller might hand over.
    func testBlankSearchesAreNotRemembered() {
        preferences.remember(search: "   ")
        preferences.remember(search: "")
        XCTAssertEqual(preferences.recentSearches, [])
        preferences.remember(search: "  trip notes  ")
        XCTAssertEqual(preferences.recentSearches, ["trip notes"])
    }

    func testRecentSearchesAreCappedAtTheLimit() {
        for index in 0..<(Preferences.recentSearchLimit + 3) {
            preferences.remember(search: "search \(index)")
        }
        XCTAssertEqual(preferences.recentSearches.count, Preferences.recentSearchLimit)
        XCTAssertEqual(preferences.recentSearches.first, "search \(Preferences.recentSearchLimit + 2)")
    }

    func testClearingAndResettingForgetTheSearches() {
        preferences.remember(search: "dentist")
        preferences.clearRecentSearches()
        XCTAssertEqual(preferences.recentSearches, [])
        preferences.remember(search: "dentist")
        preferences.resetAll()
        XCTAssertEqual(preferences.recentSearches, [])
    }

    // MARK: - List order

    func testListSortIsPerViewWithTheCallersFallback() {
        XCTAssertEqual(preferences.listSort(for: "inbox"), .manual)
        XCTAssertEqual(preferences.listSort(for: "calendar-folder", fallback: .date), .date)
        preferences.setListSort(.priority, for: "inbox")
        XCTAssertEqual(preferences.listSort(for: "inbox"), .priority)
        XCTAssertEqual(preferences.listSort(for: "work"), .manual, "another view is untouched")
    }

    /// A mode this build does not know reads as the fallback, not as a crash
    /// or as manual when the caller wanted date.
    func testAnUnknownStoredSortReadsAsTheFallback() {
        suite.set("by-colour", forKey: "pikos.listSort.inbox")
        XCTAssertEqual(preferences.listSort(for: "inbox", fallback: .date), .date)
    }

    func testResetForgetsEveryViewsSort() {
        preferences.setListSort(.title, for: "inbox")
        preferences.setListSort(.date, for: "work")
        preferences.resetAll()
        XCTAssertEqual(preferences.listSort(for: "inbox"), .manual)
        XCTAssertEqual(preferences.listSort(for: "work"), .manual)
    }
}
