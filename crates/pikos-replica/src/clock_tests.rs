use super::*;

#[test]
fn next_takes_wall_time_when_it_has_moved_on() {
    assert_eq!(Hlc::new(1_000, 7).next(2_000), Hlc::new(2_000, 0));
}

#[test]
fn next_counts_up_when_wall_time_has_not_moved() {
    assert_eq!(Hlc::new(1_000, 7).next(1_000), Hlc::new(1_000, 8));
}

#[test]
fn next_never_runs_backwards_when_the_wall_clock_does() {
    let before = Hlc::new(5_000, 2);
    let after = before.next(4_000);
    assert!(after > before);
    assert_eq!(after, Hlc::new(5_000, 3));
}

#[test]
fn next_moves_to_the_next_millisecond_when_the_counter_is_full() {
    assert_eq!(Hlc::new(1_000, u32::MAX).next(1_000), Hlc::new(1_001, 0));
}

#[test]
fn a_slow_device_stamps_its_next_edit_after_a_remote_one_it_has_seen() {
    let local = Hlc::new(1_000, 0);
    let remote = Hlc::new(60_000, 4);
    let edit = local.observe(remote).next(1_500);
    assert!(edit > remote);
}

#[test]
fn observing_an_older_clock_changes_nothing() {
    let local = Hlc::new(9_000, 1);
    assert_eq!(local.observe(Hlc::new(8_000, 50)), local);
}

#[test]
fn text_round_trips() {
    for clock in [
        Hlc::ZERO,
        Hlc::new(1_760_000_000_000, 3),
        Hlc::new(WALL_MAX, u32::MAX),
    ] {
        assert_eq!(clock.to_string().parse::<Hlc>(), Ok(clock));
    }
}

#[test]
fn text_order_is_clock_order() {
    let clocks = [
        Hlc::ZERO,
        Hlc::new(0, 1),
        Hlc::new(15, 0),
        Hlc::new(16, 0),
        Hlc::new(1_760_000_000_000, 0),
        Hlc::new(1_760_000_000_000, 0xff),
        Hlc::new(1_760_000_000_001, 0),
    ];
    for pair in clocks.windows(2) {
        assert!(pair[0] < pair[1]);
        assert!(pair[0].to_string() < pair[1].to_string());
    }
}

#[test]
fn text_is_fixed_width() {
    assert_eq!(Hlc::ZERO.to_string(), "00000000000000000000");
    assert_eq!(Hlc::new(255, 16).to_string(), "0000000000ff00000010");
}

#[test]
fn malformed_text_is_refused() {
    for bad in [
        "",
        "0000000000ff0000001",
        "0000000000ff000000100",
        "0000000000FF00000010",
        "0000000000fg00000010",
        "+000000000ff00000010",
    ] {
        assert!(bad.parse::<Hlc>().is_err(), "{bad:?} parsed");
    }
}

#[test]
fn a_wall_time_past_the_encoding_is_held_at_its_limit() {
    let clock = Hlc::new(u64::MAX, 0);
    assert_eq!(clock.wall_ms(), WALL_MAX);
    assert_eq!(clock.to_string().parse::<Hlc>(), Ok(clock));
}
