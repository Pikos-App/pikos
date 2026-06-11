use super::*;
use chrono::TimeZone;

fn settings_with_quiet(start: &str, end: &str) -> NotificationSettings {
    NotificationSettings {
        enabled: true,
        default_minutes_before: 10,
        overdue_alerts: true,
        summary_time: "07:00".to_string(),
        quiet_hours_enabled: true,
        quiet_hours_start: start.to_string(),
        quiet_hours_end: end.to_string(),
    }
}

fn local_at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<chrono::Local> {
    chrono::Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
}

// ─── classify_sqlx ───────────────────────────────────────────────────

#[test]
fn classify_sqlx_returns_stable_label_without_message() {
    // Variants we'll realistically see in the scheduler. The point is
    // to confirm the label is content-free — no Display formatting, no
    // user-provided strings can leak through this helper.
    assert_eq!(classify_sqlx(&sqlx::Error::RowNotFound), "row_not_found");
    assert_eq!(classify_sqlx(&sqlx::Error::PoolTimedOut), "pool_timed_out");
    assert_eq!(classify_sqlx(&sqlx::Error::PoolClosed), "pool_closed");
    assert_eq!(classify_sqlx(&sqlx::Error::WorkerCrashed), "worker_crashed");
}

// ─── is_quiet_hours ──────────────────────────────────────────────────

#[test]
fn quiet_hours_disabled_always_false() {
    let mut s = settings_with_quiet("22:00", "08:00");
    s.quiet_hours_enabled = false;
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 23, 0)));
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 3, 0)));
}

#[test]
fn quiet_hours_overnight_window() {
    // 22:00 → 08:00 wraps midnight
    let s = settings_with_quiet("22:00", "08:00");
    assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 22, 0))); // start inclusive
    assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 23, 30)));
    assert!(is_quiet_hours(&s, &local_at(2026, 4, 19, 2, 0)));
    assert!(is_quiet_hours(&s, &local_at(2026, 4, 19, 7, 59)));
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 19, 8, 0))); // end exclusive
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 12, 0)));
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 21, 59)));
}

#[test]
fn quiet_hours_daytime_window() {
    // 13:00 → 15:00 same-day (e.g. afternoon focus block)
    let s = settings_with_quiet("13:00", "15:00");
    assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 13, 0)));
    assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 14, 30)));
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 15, 0)));
    assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 12, 59)));
}

// ─── should_fire_daily_summary ───────────────────────────────────────

#[test]
fn summary_blocked_when_overdue_alerts_off() {
    let mut s = settings_with_quiet("22:00", "08:00");
    s.overdue_alerts = false;
    let rt = SchedulerRuntime::default();
    assert!(!should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 8, 0)
    ));
}

#[test]
fn summary_blocked_during_quiet_hours() {
    let s = settings_with_quiet("22:00", "08:00");
    let rt = SchedulerRuntime::default();
    assert!(!should_fire_daily_summary(
        &rt,
        &s,
        true,
        &local_at(2026, 4, 18, 23, 0)
    ));
}

#[test]
fn summary_fires_after_quiet_hours_end_when_summary_time_passed() {
    // Summary 07:00, quiet 22:00-08:00: at 08:00 both conditions met.
    let s = settings_with_quiet("22:00", "08:00");
    let rt = SchedulerRuntime::default();
    assert!(should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 8, 0)
    ));
}

#[test]
fn summary_fires_at_configured_time_when_quiet_hours_off() {
    let mut s = settings_with_quiet("22:00", "08:00");
    s.quiet_hours_enabled = false;
    s.summary_time = "09:30".to_string();
    let rt = SchedulerRuntime::default();
    assert!(should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 9, 30)
    ));
    assert!(!should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 9, 29)
    ));
}

#[test]
fn summary_deferred_when_summary_time_inside_daytime_quiet_hours() {
    // Summary 14:00, quiet 13:00-15:00 (daytime focus block).
    // At 14:00 now_quiet=true → don't fire.
    // At 15:00 now_quiet=false, summary_time passed → fire.
    let mut s = settings_with_quiet("13:00", "15:00");
    s.summary_time = "14:00".to_string();
    let rt = SchedulerRuntime::default();
    assert!(!should_fire_daily_summary(
        &rt,
        &s,
        true, // caller determines now_quiet
        &local_at(2026, 4, 18, 14, 0)
    ));
    assert!(should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 15, 0)
    ));
}

#[test]
fn summary_deferred_when_summary_time_inside_late_quiet_hours() {
    // Summary 09:00, quiet 22:00-10:00 (late-wake user).
    // At 09:00 now_quiet=true → don't fire. At 10:00 → fire.
    let mut s = settings_with_quiet("22:00", "10:00");
    s.summary_time = "09:00".to_string();
    let rt = SchedulerRuntime::default();
    assert!(!should_fire_daily_summary(
        &rt,
        &s,
        true,
        &local_at(2026, 4, 18, 9, 0)
    ));
    assert!(should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 10, 0)
    ));
}

#[test]
fn summary_does_not_refire_same_day() {
    let s = settings_with_quiet("22:00", "08:00");
    let today = local_at(2026, 4, 18, 9, 0).date_naive();
    let rt = SchedulerRuntime {
        last_summary_date: Some(today),
    };
    assert!(!should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 9, 0)
    ));
}

#[test]
fn summary_fires_next_day_after_previous() {
    let s = settings_with_quiet("22:00", "08:00");
    let yesterday = local_at(2026, 4, 17, 8, 0).date_naive();
    let rt = SchedulerRuntime {
        last_summary_date: Some(yesterday),
    };
    assert!(should_fire_daily_summary(
        &rt,
        &s,
        false,
        &local_at(2026, 4, 18, 8, 0)
    ));
}

// ─── format helpers ──────────────────────────────────────────────────

#[test]
fn lead_time_boundaries() {
    assert_eq!(format_lead_time(0), "now");
    assert_eq!(format_lead_time(5), "in 5 min");
    assert_eq!(format_lead_time(59), "in 59 min");
    assert_eq!(format_lead_time(60), "in 1 hour");
    assert_eq!(format_lead_time(120), "in 2 hours");
    assert_eq!(format_lead_time(180), "in 3 hours");
}

#[test]
fn time_from_iso_valid() {
    assert_eq!(format_time_from_iso("2026-04-18T09:30:00"), "9:30am");
    assert_eq!(format_time_from_iso("2026-04-18T14:05:00"), "2:05pm");
}

#[test]
fn time_from_iso_invalid() {
    assert_eq!(format_time_from_iso("2026-04-18"), ""); // all-day string
    assert_eq!(format_time_from_iso("garbage"), "");
}

#[test]
fn summary_title_format() {
    // 2026-04-18 is a Saturday
    let t = format_summary_title(&local_at(2026, 4, 18, 8, 0));
    assert_eq!(t, "Today — Sat, Apr 18");
}

#[test]
fn summary_body_both_counts() {
    assert_eq!(
        format_summary_body(3, 2),
        "3 scheduled · 2 overdue\nOpen Pikos to review."
    );
}

#[test]
fn summary_body_today_only() {
    assert_eq!(
        format_summary_body(3, 0),
        "3 scheduled\nOpen Pikos to review."
    );
}

#[test]
fn summary_body_overdue_only() {
    assert_eq!(
        format_summary_body(0, 2),
        "2 overdue\nOpen Pikos to review."
    );
}

#[test]
fn summary_body_empty() {
    assert_eq!(format_summary_body(0, 0), "Open Pikos to review.");
}
