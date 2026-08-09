//! Long-label phrasing, pinned against rrule.js `.toText()` output harvested
//! before the dependency was removed — plus the BYSETPOS position rrule.js
//! drops (restored deliberately: "every month on Friday" misstates a
//! BYSETPOS=3 cadence). Regenerating this table requires reinstalling
//! rrule@2.8.1 and calling `.toText()`; treat the strings as the contract.

use pikos_recurrence::rrule_to_label;

fn assert_label(rrule: &str, expected: &str) {
    assert_eq!(rrule_to_label(rrule).as_deref(), Some(expected), "rrule: {rrule}");
}

#[test]
fn matches_the_harvested_totext_table() {
    assert_label("FREQ=DAILY", "every day");
    assert_label("FREQ=DAILY;INTERVAL=2", "every 2 days");
    assert_label("FREQ=WEEKLY", "every week");
    assert_label("FREQ=WEEKLY;INTERVAL=2", "every 2 weeks");
    assert_label("FREQ=WEEKLY;BYDAY=MO", "every week on Monday");
    assert_label("FREQ=WEEKLY;BYDAY=MO,WE,FR", "every week on Monday, Wednesday, Friday");
    assert_label("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "every weekday");
    assert_label("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR", "every 2 weeks on weekdays");
    assert_label("FREQ=WEEKLY;BYDAY=SU,SA", "every week on Saturday, Sunday");
    assert_label("FREQ=WEEKLY;BYDAY=TU;WKST=SU", "every week on Tuesday");
    assert_label("FREQ=MONTHLY", "every month");
    assert_label("FREQ=MONTHLY;BYMONTHDAY=15", "every month on the 15th");
    assert_label("FREQ=MONTHLY;BYMONTHDAY=-1", "every month on the last");
    assert_label("FREQ=MONTHLY;BYMONTHDAY=-2", "every month on the 2nd last");
    assert_label("FREQ=MONTHLY;BYMONTHDAY=1,15", "every month on the 1st and 15th");
    assert_label("FREQ=MONTHLY;BYMONTHDAY=15,-1", "every month on the 15th and last");
    assert_label("FREQ=MONTHLY;BYMONTHDAY=1,2,3", "every month on the 1st, 2nd and 3rd");
    assert_label("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15", "every 3 months on the 15th");
    assert_label("FREQ=MONTHLY;BYDAY=3FR", "every month on the 3rd Friday");
    assert_label("FREQ=MONTHLY;BYDAY=-1FR", "every month on the last Friday");
    assert_label("FREQ=MONTHLY;BYDAY=MO,2WE", "every month on Monday and on the 2nd Wednesday");
    assert_label("FREQ=YEARLY", "every year");
    assert_label("FREQ=YEARLY;INTERVAL=2", "every 2 years");
    assert_label("FREQ=YEARLY;BYMONTH=3", "every March");
    assert_label("FREQ=YEARLY;BYMONTH=6,7", "every June and July");
    assert_label("FREQ=YEARLY;BYMONTH=6,7,8", "every June, July and August");
    assert_label("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", "every March on the 15th");
    assert_label("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "every November on the 4th Thursday");
    assert_label("FREQ=YEARLY;BYMONTH=3;BYDAY=SU", "every March on Sunday");
    assert_label("FREQ=YEARLY;BYDAY=-1SU", "every year on the last Sunday");
    assert_label("FREQ=MONTHLY;BYMONTH=1,7;BYMONTHDAY=10", "every January and July on the 10th");
    assert_label("FREQ=MONTHLY;BYMONTH=1;BYDAY=2MO", "every January on the 2nd Monday");
    assert_label("FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7", "every week in June and July on Monday");
    assert_label("FREQ=DAILY;BYMONTH=3", "every day in March");
    assert_label("FREQ=DAILY;BYDAY=MO,WE", "every day on Monday, Wednesday");
    assert_label("FREQ=DAILY;BYMONTHDAY=15", "every day on the 15th");
    assert_label("FREQ=DAILY;COUNT=1", "every day for 1 time");
    assert_label("FREQ=WEEKLY;BYDAY=MO;COUNT=10", "every week on Monday for 10 times");
    assert_label("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z", "every week on Monday until December 31, 2026");
    assert_label("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231", "every week on Monday until December 31, 2026");
}

#[test]
fn restores_the_bysetpos_position_rrule_js_drops() {
    assert_label("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3", "every month on the 3rd Friday");
    assert_label("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1", "every month on the last Friday");
    assert_label(
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "every month on the last weekday",
    );
    assert_label(
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=1",
        "every month on the 1st day",
    );
    assert_label("FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1", "every month on the 1st Saturday or Sunday");
    assert_label("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1,3", "every month on the 1st or 3rd Friday");
    assert_label(
        "FREQ=MONTHLY;INTERVAL=2;BYDAY=FR;BYSETPOS=3;COUNT=10",
        "every 2 months on the 3rd Friday for 10 times",
    );
    assert_label("FREQ=YEARLY;BYMONTH=3;BYDAY=SU;BYSETPOS=-1", "every March on the last Sunday");
}

#[test]
fn deviates_deliberately_where_totext_was_broken() {
    // rrule.js emitted "every 2 years March".
    assert_label("FREQ=YEARLY;INTERVAL=2;BYMONTH=3", "every 2 years in March");
}

#[test]
fn falls_back_on_unphrasable_shapes() {
    // Out of the engine envelope entirely.
    assert_eq!(rrule_to_label("FREQ=YEARLY;BYWEEKNO=20"), None);
    assert_eq!(rrule_to_label("FREQ=HOURLY"), None);
    assert_eq!(rrule_to_label("INVALID_RRULE"), None);
    // In-envelope but with no honest wording.
    assert_eq!(rrule_to_label("FREQ=MONTHLY;BYSETPOS=1"), None);
    assert_eq!(rrule_to_label("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13"), None);
}
