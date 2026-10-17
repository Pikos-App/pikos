//! Timing how long somebody actually sat with a page.
//!
//! Port of the decisions in `useFocusTimer.ts` — the floor below which a session
//! is not worth recording, and the two ways a duration is written out. Graded
//! against it by `tests/focus_parity.rs`.
//!
//! The *timing* is not here and should not be: a running session lives in the
//! UI and is never persisted, because a session the app cannot see the end of is
//! a guess, and a guess inside a total is worse than a missing session. What is
//! here is what happens when one stops.

/// Shortest session worth recording, in seconds.
///
/// Opening a page, tapping play and moving on is not focus time. Without the
/// floor the card fills with one-second rows that inflate the session count
/// while adding nothing to the minutes.
pub const MIN_SESSION_S: i64 = 30;

/// Whether a finished session is recorded, and what the user is told either way.
///
/// Both outcomes get a sentence. Stopping is otherwise near-invisible — the row
/// goes to a panel nobody is looking at — and a silent discard below the floor
/// reads exactly like a silent success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusOutcome {
    Recorded { duration_s: i64, label: String },
    TooShort { label: String },
}

/// What to do with a session of `duration_s` seconds.
pub fn finish_session(duration_s: i64) -> FocusOutcome {
    if duration_s < MIN_SESSION_S {
        return FocusOutcome::TooShort {
            label: format!("Under {MIN_SESSION_S} seconds — not recorded"),
        };
    }
    FocusOutcome::Recorded {
        duration_s,
        label: format!("Focused for {}", session_length(duration_s)),
    }
}

/// Whole units, for the sentence shown when a session ends.
///
/// A session is worth reporting as "24 minutes", never as "24:07" — the seconds
/// are precision nobody asked for once the thing being measured is over.
pub fn session_length(total_seconds: i64) -> String {
    let minutes = (total_seconds as f64 / 60.0).round() as i64;
    if minutes < 60 {
        return format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" });
    }
    let hours = minutes / 60;
    let rest = minutes % 60;
    let hour_part = format!("{hours} hour{}", if hours == 1 { "" } else { "s" });
    if rest == 0 {
        hour_part
    } else {
        format!("{hour_part} {rest} min")
    }
}

/// `M:SS`, or `H:MM:SS` once an hour is up.
///
/// Read at a glance while the session runs, so the caller renders it
/// monospaced — otherwise the digits shuffle sideways on every tick.
pub fn elapsed_label(total_seconds: i64) -> String {
    let s = total_seconds.max(0);
    let hours = s / 3600;
    let minutes = (s % 3600) / 60;
    let seconds = s % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}
