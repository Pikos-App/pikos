//! Timing how long somebody actually sat with a page: the floor below which a session is not
//! worth recording, and the two ways a duration is written out.
//!
//! The timing itself is not here: a running session lives in the UI and is never persisted,
//! because a session the app cannot see the end of is a guess, and a guess inside a total is
//! worse than a missing session.

/// Shortest session worth recording, in seconds.
///
/// Below it the card fills with one-second rows that inflate the session count without
/// adding minutes.
pub const MIN_SESSION_S: i64 = 30;

/// Whether a finished session is recorded, and what the user is told either way.
///
/// Both outcomes get a sentence: a silent discard below the floor reads like a silent success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusOutcome {
    Recorded { duration_s: i64, label: String },
    TooShort { label: String },
}

pub fn finish_session(duration_s: i64) -> FocusOutcome {
    if duration_s < MIN_SESSION_S {
        return FocusOutcome::TooShort {
            label: format!("Under {MIN_SESSION_S} seconds, not recorded"),
        };
    }
    FocusOutcome::Recorded {
        duration_s,
        label: format!("Focused for {}", session_length(duration_s)),
    }
}

/// Whole units, for the sentence shown when a session ends: "24 minutes", never "24:07".
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
/// The caller renders it monospaced so the digits do not shuffle on every tick.
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
