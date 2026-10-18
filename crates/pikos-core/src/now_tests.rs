use super::*;

const NOW: i64 = 1_800_000_000_000;

fn at(minutes: i64) -> i64 {
    NOW + minutes * 60_000
}

fn timed(id: &str, start: i64, end: Option<i64>, priority: i64) -> NowItem {
    NowItem {
        id: id.into(),
        start: Some(at(start)),
        end: end.map(at),
        priority,
    }
}

fn untimed(id: &str, priority: i64) -> NowItem {
    NowItem {
        id: id.into(),
        start: None,
        end: None,
        priority,
    }
}

fn id_at(items: &[NowItem], at: Option<usize>) -> Option<&str> {
    at.map(|at| items[at].id.as_str())
}

fn suggested(id: &str, reason: Reason) -> Option<Suggestion> {
    Some(Suggestion {
        id: id.into(),
        reason,
    })
}

#[test]
fn a_span_in_progress_is_current_and_hides_the_suggestion() {
    let items = [timed("call", -10, Some(20), 0), untimed("write", 0)];
    let plan = plan(&items, NOW);

    assert_eq!(id_at(&items, plan.current), Some("call"));
    assert_eq!(plan.suggestion, None);
    assert_eq!(plan.free_until, None);
}

#[test]
fn the_gap_before_the_next_page_is_free_time_with_a_suggestion() {
    let items = [timed("standup", 45, Some(60), 0), untimed("write", 0)];
    let plan = plan(&items, NOW);

    assert_eq!(plan.current, None);
    assert_eq!(id_at(&items, plan.next), Some("standup"));
    assert_eq!(plan.free_until, Some(at(45)));
    assert_eq!(plan.suggestion, suggested("write", Reason::FirstInList));
}

#[test]
fn a_page_with_no_end_is_never_in_progress_and_is_due_once_its_time_passes() {
    let items = [timed("pills", -5, None, 0)];
    let plan = plan(&items, NOW);

    assert_eq!(plan.current, None);
    assert_eq!(plan.suggestion, suggested("pills", Reason::Overdue));
}

#[test]
fn priority_outranks_list_order_and_says_so() {
    let items = [untimed("first", 0), untimed("urgent", 1)];
    let plan = plan(&items, NOW);

    assert_eq!(plan.suggestion, suggested("urgent", Reason::TopPriority));
}

#[test]
fn equal_priorities_fall_back_to_list_order() {
    let items = [untimed("a", 2), untimed("b", 2)];
    let plan = plan(&items, NOW);

    assert_eq!(plan.suggestion.map(|s| s.id).as_deref(), Some("a"));
}

#[test]
fn next_is_the_soonest_to_start_whatever_the_list_order() {
    let items = [
        timed("evening", 300, Some(360), 0),
        timed("soon", 30, Some(60), 0),
        timed("noon", 120, Some(150), 0),
    ];
    let plan = plan(&items, NOW);

    assert_eq!(id_at(&items, plan.next), Some("soon"));
    assert_eq!(plan.free_until, Some(at(30)));
}

#[test]
fn a_page_still_ahead_is_not_suggested() {
    let items = [timed("later", 30, Some(60), 0)];
    let plan = plan(&items, NOW);

    assert_eq!(plan.suggestion, None);
    assert_eq!(plan.free_until, Some(at(30)));
}

#[test]
fn overlapping_spans_show_the_one_ending_soonest() {
    let items = [
        timed("long", -30, Some(90), 0),
        timed("short", -5, Some(10), 0),
    ];
    let plan = plan(&items, NOW);

    assert_eq!(id_at(&items, plan.current), Some("short"));
}

#[test]
fn changes_are_every_future_start_and_end_once() {
    let items = [timed("a", -10, Some(20), 0), timed("b", 20, Some(50), 0)];
    let plan = plan(&items, NOW);

    assert_eq!(plan.changes, vec![at(20), at(50)]);
}

#[test]
fn a_repeated_id_names_the_item_that_is_in_progress() {
    let items = [
        timed("standup", 30, Some(45), 0),
        timed("standup", -10, Some(20), 0),
    ];
    let plan = plan(&items, NOW);

    assert_eq!(plan.current, Some(1));
}
