import XCTest

@testable import PikosSupport

/// The preference store's edges: what happens when a stored value is not what this build expects
/// (a case renamed since it was written, a preference never set), since each has a wrong answer
/// that looks like working code.
final class PreferencesTests: XCTestCase {
    private let suiteName = "app.pikos.tests.preferences"
    private var suite: UserDefaults!
    private var preferences: Preferences!

    override func setUp() {
        super.setUp()
        // A throwaway suite, so a run never touches the device's real defaults.
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
        // On, and ten minutes: the desktop's defaults.
        XCTAssertTrue(preferences.remindersEnabled)
        XCTAssertEqual(preferences.defaultReminderMinutes, 10)
    }

    /// A stored `false` read back as the default `true` would ring a reminder the user switched off.
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

    /// Renaming an enum case leaves the old spelling in every user's defaults.
    func testAValueThisBuildDoesNotRecogniseReadsAsTheDefault() {
        suite.set("neon", forKey: "pikos.theme")
        suite.set("roomy", forKey: "pikos.listDensity")
        XCTAssertEqual(preferences.theme, .system)
        XCTAssertEqual(preferences.listDensity, .cozy)
    }

    /// Unset is not set-to-something: once chosen, the choice wins even when it matches the region.
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

    /// `removePersistentDomain` is the obvious implementation and would wipe a neighbour's state.
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

    func testDensitiesAreStoredByName() {
        XCTAssertEqual(Preferences.ListDensity.cozy.rawValue, "cozy")
        XCTAssertEqual(Preferences.CalendarDensity.spacious.rawValue, "spacious")
    }

    func testWeekStartUsesFoundationsNumbering() {
        XCTAssertEqual(Preferences.WeekStart.sunday.rawValue, 1)
        XCTAssertEqual(Preferences.WeekStart.monday.rawValue, 2)

        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = Preferences.WeekStart.monday.rawValue
        XCTAssertEqual(calendar.firstWeekday, 2, "hands to Calendar without conversion")
    }

    func testEachDensityIsDistinctAndOrdered() {
        let heights = Preferences.CalendarDensity.allCases.map(\.hourHeight)
        XCTAssertEqual(heights, heights.sorted(), "compact through spacious should increase")
        XCTAssertEqual(Set(heights).count, heights.count)

        let padding = Preferences.ListDensity.allCases.map(\.rowPadding)
        XCTAssertEqual(padding, padding.sorted())
        XCTAssertEqual(Set(padding).count, padding.count)
    }

    func testEveryChoiceIsLabelled() {
        for theme in Preferences.Theme.allCases { XCTAssertFalse(theme.label.isEmpty) }
        for density in Preferences.ListDensity.allCases { XCTAssertFalse(density.label.isEmpty) }
        for density in Preferences.CalendarDensity.allCases {
            XCTAssertFalse(density.label.isEmpty)
        }
        for start in Preferences.WeekStart.allCases { XCTAssertFalse(start.label.isEmpty) }
    }

    func testListSortIsPerViewWithTheCallersFallback() {
        XCTAssertEqual(preferences.listSort(for: "inbox"), .manual)
        XCTAssertEqual(preferences.listSort(for: "calendar-folder", fallback: .date), .date)
        preferences.setListSort(.priority, for: "inbox")
        XCTAssertEqual(preferences.listSort(for: "inbox"), .priority)
        XCTAssertEqual(preferences.listSort(for: "work"), .manual, "another view is untouched")
    }

    // qa: CLOUD-71:2
    func testACalendarFolderSortIsKeptInThisDevicesOwnDefaultsNotTheWorkspace() {
        preferences.setListSort(.title, for: "calendar-folder")
        XCTAssertEqual(suite.string(forKey: "pikos.listSort.calendar-folder"), "title")
    }

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
