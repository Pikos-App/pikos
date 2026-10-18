use super::*;

fn resized(start: &str, end: Option<&str>, edge: Edge, minute: i32) -> Option<[String; 2]> {
    resize(start, end, edge, minute).map(|(start, end)| [start, end])
}

fn pair(start: &str, end: &str) -> Option<[String; 2]> {
    Some([start.to_owned(), end.to_owned()])
}

#[test]
fn a_dropped_timed_page_keeps_its_length() {
    let dropped = drop_schedule(
        "2026-09-14",
        16 * 60,
        Some("2026-09-10T10:00:00"),
        Some("2026-09-10T11:45:00"),
    );

    assert_eq!(dropped.start, "2026-09-14T16:00:00");
    assert_eq!(dropped.end.as_deref(), Some("2026-09-14T17:45:00"));
}

#[test]
fn a_dropped_undated_or_all_day_page_gets_a_start_and_no_end() {
    let undated = drop_schedule("2026-09-14", 9 * 60 + 15, None, None);
    let all_day = drop_schedule("2026-09-14", 9 * 60, Some("2026-09-10"), Some("2026-09-12"));

    assert_eq!(undated.start, "2026-09-14T09:15:00");
    assert_eq!(undated.end, None);
    assert_eq!(all_day.end, None);
}

#[test]
fn a_late_drop_ends_at_midnight_rather_than_tomorrow() {
    let dropped = drop_schedule(
        "2026-09-14",
        23 * 60 + 30,
        Some("2026-09-10T10:00:00"),
        Some("2026-09-10T12:00:00"),
    );

    assert_eq!(dropped.end.as_deref(), Some("2026-09-14T23:59:00"));
}

#[test]
fn the_bottom_edge_moves_the_end_to_the_nearest_quarter_hour() {
    assert_eq!(
        resized(
            "2026-09-14T09:00:00",
            Some("2026-09-14T10:00:00"),
            Edge::Bottom,
            11 * 60 + 8
        ),
        pair("2026-09-14T09:00:00", "2026-09-14T11:15:00")
    );
}

#[test]
fn the_top_edge_moves_the_start_and_keeps_the_end() {
    assert_eq!(
        resized(
            "2026-09-14T09:00:00",
            Some("2026-09-14T10:00:00"),
            Edge::Top,
            8 * 60 + 20
        ),
        pair("2026-09-14T08:15:00", "2026-09-14T10:00:00")
    );
}

#[test]
fn neither_edge_can_make_a_page_shorter_than_a_quarter_hour() {
    assert_eq!(
        resized(
            "2026-09-14T09:00:00",
            Some("2026-09-14T10:00:00"),
            Edge::Bottom,
            8 * 60
        ),
        pair("2026-09-14T09:00:00", "2026-09-14T09:15:00")
    );
    assert_eq!(
        resized(
            "2026-09-14T09:00:00",
            Some("2026-09-14T10:00:00"),
            Edge::Top,
            11 * 60
        ),
        pair("2026-09-14T09:45:00", "2026-09-14T10:00:00")
    );
}

#[test]
fn a_page_with_no_end_gains_one_from_either_edge() {
    assert_eq!(
        resized("2026-09-14T09:00:00", None, Edge::Bottom, 10 * 60),
        pair("2026-09-14T09:00:00", "2026-09-14T10:00:00")
    );
    assert_eq!(
        resized("2026-09-14T09:00:00", None, Edge::Top, 8 * 60),
        pair("2026-09-14T08:00:00", "2026-09-14T09:00:00")
    );
}

#[test]
fn an_edge_stays_inside_its_day() {
    assert_eq!(
        resized(
            "2026-09-14T22:00:00",
            Some("2026-09-14T23:00:00"),
            Edge::Bottom,
            25 * 60
        ),
        pair("2026-09-14T22:00:00", "2026-09-14T23:59:00")
    );
    assert_eq!(
        resized(
            "2026-09-14T01:00:00",
            Some("2026-09-14T02:00:00"),
            Edge::Top,
            -90
        ),
        pair("2026-09-14T00:00:00", "2026-09-14T02:00:00")
    );
}

#[test]
fn an_all_day_or_overnight_page_is_not_resized_by_an_edge() {
    assert_eq!(
        resized("2026-09-14", Some("2026-09-15"), Edge::Bottom, 600),
        None
    );
    assert_eq!(
        resized(
            "2026-09-14T22:00:00",
            Some("2026-09-15T01:00:00"),
            Edge::Bottom,
            23 * 60
        ),
        None
    );
}

#[test]
fn a_press_that_has_not_moved_is_a_quarter_hour() {
    assert_eq!(
        stretch(15 * 60, f64::from(15 * 60 + 4)),
        (15 * 60, 15 * 60 + 15)
    );
}

#[test]
fn drawing_down_moves_the_end_to_the_nearest_quarter_hour() {
    assert_eq!(
        stretch(15 * 60, f64::from(16 * 60 + 37)),
        (15 * 60, 16 * 60 + 30)
    );
    assert_eq!(
        stretch(15 * 60, f64::from(16 * 60 + 38)),
        (15 * 60, 16 * 60 + 45)
    );
}

#[test]
fn drawing_up_moves_the_start_and_keeps_the_pressed_quarter() {
    assert_eq!(
        stretch(15 * 60, f64::from(14 * 60)),
        (14 * 60, 15 * 60 + 15)
    );
}

#[test]
fn a_stretch_stays_inside_the_day() {
    assert_eq!(stretch(23 * 60, f64::from(25 * 60)), (23 * 60, 24 * 60));
    assert_eq!(stretch(30, -60.0), (0, 45));
}
