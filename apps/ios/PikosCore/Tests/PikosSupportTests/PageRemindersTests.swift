import PikosSupport
import XCTest

final class PageRemindersTests: XCTestCase {
    func testAPageWithNoRowsShowsTheDefaultLeadAsOn() {
        let reminders = PageReminders([])
        XCTAssertTrue(reminders.isOn(10, allDay: false, defaultMinutes: 10))
        XCTAssertFalse(reminders.isOn(30, allDay: false, defaultMinutes: 10))
        XCTAssertEqual(reminders.effective(allDay: false, defaultMinutes: 10), [10])
    }

    func testThePagesOwnLeadsReplaceTheDefault() {
        let reminders = PageReminders([30, 5])
        XCTAssertEqual(reminders.own, [5, 30])
        XCTAssertFalse(reminders.isOn(10, allDay: false, defaultMinutes: 10))
        XCTAssertEqual(reminders.effective(allDay: false, defaultMinutes: 10), [5, 30])
    }

    func testNeverSilencesTheDefaultToo() {
        let reminders = PageReminders([PageReminders.never])
        XCTAssertTrue(reminders.isNever)
        XCTAssertFalse(reminders.isOn(10, allDay: false, defaultMinutes: 10))
        XCTAssertEqual(reminders.effective(allDay: false, defaultMinutes: 10), [])
    }

    func testTheDefaultNeverStandsInForAnAllDayPage() {
        let reminders = PageReminders([])
        XCTAssertEqual(PageReminders.choices(allDay: true), [PageReminders.dayBefore])
        XCTAssertFalse(reminders.isOn(PageReminders.dayBefore, allDay: true, defaultMinutes: -2))
        XCTAssertEqual(reminders.effective(allDay: true, defaultMinutes: 10), [])
    }

    func testADefaultOfNeverRemindsNothing() {
        XCTAssertEqual(PageReminders([]).effective(allDay: false, defaultMinutes: -1), [])
    }

    func testTappingALeadThePageHasTakesItOff() {
        XCTAssertEqual(PageReminders([10, 30]).toggling(10), .remove(10))
    }

    func testTappingALeadOnANeverPageReplacesTheNever() {
        XCTAssertEqual(PageReminders([PageReminders.never]).toggling(10), .add(10, clearingNever: true))
        XCTAssertEqual(PageReminders([]).toggling(10), .add(10, clearingNever: false))
    }
}
