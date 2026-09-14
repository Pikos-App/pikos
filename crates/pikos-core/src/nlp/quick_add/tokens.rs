//! Everything read out of the input before the date engine sees it.
//!
//! Two jobs, in order.
//!
//! **Rewriting** turns phrasings the date engine cannot resolve into ones it
//! can: "tonight" into "today at 8pm", "last monday" into a concrete date,
//! "on the 24th" into "Mar 24 2026". Each rewrite exists because the engine
//! either cannot parse the phrase at all, or parses it into the wrong half of
//! the calendar — it is invoked forward-dating, so "last monday" would come
//! back as next Monday without help.
//!
//! **Extraction** pulls out the inline markers — `#tag`, `~folder`, `!urgent`,
//! "for 2h", "10 times" — removing each from the text as it goes, so whatever
//! survives is the title.

use std::sync::OnceLock;

use chrono::{NaiveDateTime, Timelike};

use super::recurrence::{weekday_from_word, Window};
use super::text::{
    add_days, add_months, compile, days_in_month, format_month_day_year, group, replace_all_with,
    start_of_day, with_day_at_midnight,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Urgent,
    High,
    Medium,
    Low,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Urgent => "urgent",
            Priority::High => "high",
            Priority::Medium => "medium",
            Priority::Low => "low",
        }
    }
}

/// Times of day the productivity defaults map casual periods onto. The date
/// engine gives "morning" a meridiem but no certain hour, so quick-add's
/// timed-versus-all-day branch would skip it; rewriting to a clock time is
/// what makes "tomorrow morning" a 9am event.
const CASUAL_TIMES: [(&str, &str, u32); 4] = [
    ("morning", "9am", 9),
    ("afternoon", "3pm", 15),
    ("evening", "6pm", 18),
    ("night", "8pm", 20),
];

const PREFIX_DAY: &str = "(?:today|tomorrow|this|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)";

/// Rewrite the phrasings the date engine cannot resolve on its own.
pub fn rewrite(text: &str, reference: NaiveDateTime) -> String {
    let mut text = text.to_string();

    // "tonight" is today at 8pm, unless 8pm has gone — a late-night quick-add
    // should not schedule into the past.
    static TONIGHT: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let tonight = TONIGHT.get_or_init(|| compile("\\btonight\\b"));
    text = replace_all_with(&text, tonight, |_| {
        if reference.hour() < 20 {
            "today at 8pm".to_string()
        } else {
            "tomorrow at 8pm".to_string()
        }
    });

    // "<day> <period>" — "tomorrow morning", "this evening". For "this" and
    // "today" the hour may already have gone, and only quick-add knows what
    // hour the period means, so it makes that call rather than the engine.
    static PREFIXED_PERIOD: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let prefixed_period = PREFIXED_PERIOD.get_or_init(|| {
        compile(&format!(
            "\\b({PREFIX_DAY})\\s+(morning|afternoon|evening|night)\\b"
        ))
    });
    text = replace_all_with(&text, prefixed_period, |captures| {
        let prefix = group(captures, 1).unwrap_or_default();
        let period = group(captures, 2).unwrap_or_default().to_lowercase();
        let Some((_, clock, hour)) = CASUAL_TIMES.iter().find(|(name, _, _)| *name == period)
        else {
            return captures.get(0).expect("group 0").as_str().to_string();
        };
        let lowered = prefix.to_lowercase();
        if lowered == "this" || lowered == "today" {
            return if reference.hour() < *hour {
                format!("today at {clock}")
            } else {
                format!("tomorrow at {clock}")
            };
        }
        format!("{prefix} at {clock}")
    });

    // "last monday". The engine is invoked forward-dating, which is right for
    // "monday" and "next monday" and exactly wrong here, so the previous
    // occurrence is resolved to a concrete date instead.
    static LAST_WEEKDAY: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let last_weekday = LAST_WEEKDAY.get_or_init(|| {
        compile("\\blast\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b")
    });
    text = replace_all_with(&text, last_weekday, |captures| {
        let whole = captures.get(0).expect("group 0").as_str().to_string();
        let Some(day) = group(captures, 1).and_then(weekday_from_word) else {
            return whole;
        };
        let current = i64::from(chrono::Datelike::weekday(&reference).num_days_from_sunday());
        let mut days_back = current - day.sunday_zero();
        if days_back <= 0 {
            days_back += 7;
        }
        match add_days(reference, -days_back) {
            Some(target) => crate::dates::format_date_only(&target),
            None => whole,
        }
    });

    // Bare day-of-month phrases. The engine reads "May 24" but not "on the
    // 24th" or "Sat 24", so each is resolved to a concrete date and
    // substituted — which also lets the title strip take the connector word
    // with it.
    static ON_THE_NTH: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let on_the_nth = ON_THE_NTH.get_or_init(|| {
        compile("\\b(?:on|by)\\s+(?:the\\s+)?(3[01]|[12]\\d|0?[1-9])(?:st|nd|rd|th)\\b")
    });
    text = replace_all_with(&text, on_the_nth, |captures| {
        let whole = captures.get(0).expect("group 0").as_str().to_string();
        substitute_day_of_month(group(captures, 1), reference).unwrap_or(whole)
    });

    // "<weekday> N" — "Sat 24", "fri 13th". When the weekday and the number
    // disagree the number wins: it is the specific signal and the weekday a
    // loose hint. The lookbehind keeps "every friday 13" out, so a recurrence
    // phrase is not consumed here.
    static WEEKDAY_NTH: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let weekday_nth = WEEKDAY_NTH.get_or_init(|| {
        compile(
            "(?<!\\bevery\\s)\\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\s+(3[01]|[12]\\d|0?[1-9])(?:st|nd|rd|th)?\\b",
        )
    });
    text = replace_all_with(&text, weekday_nth, |captures| {
        let whole = captures.get(0).expect("group 0").as_str().to_string();
        substitute_day_of_month(group(captures, 1), reference).unwrap_or(whole)
    });

    // "May 2 through 10" — the engine reads "through" between two numbers as a
    // time range (2 to 10 am). Rewriting to "to" gets the date span, and
    // leaves cadence uses like "every monday through april 30" alone, because
    // those have a word after "through" rather than a digit.
    static MONTH_THROUGH: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let month_through = MONTH_THROUGH.get_or_init(|| {
        const MONTH: &str = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
        compile(&format!(
            "\\b({MONTH})\\s+(\\d{{1,2}})(st|nd|rd|th)?\\s+(?:through|thru)\\s+((?:{MONTH})\\s+)?(\\d{{1,2}})(st|nd|rd|th)?\\b"
        ))
    });
    text = replace_all_with(&text, month_through, |captures| {
        let first_month = group(captures, 1).unwrap_or_default();
        let first_day = group(captures, 2).unwrap_or_default();
        let second_day = group(captures, 5).unwrap_or_default();
        match group(captures, 4) {
            Some(second_month) => {
                format!("{first_month} {first_day} to {second_month}{second_day}")
            }
            None => format!("{first_month} {first_day} to {second_day}"),
        }
    });

    text
}

/// Resolve a bare day-of-month to a concrete date: this month if it has not
/// gone, else the next month that has such a day. Two months of lookahead is
/// enough to skip a short February.
fn resolve_day_of_month(day: u32, reference: NaiveDateTime) -> Option<NaiveDateTime> {
    for offset in 0..=2 {
        let Some(month) = add_months(reference, offset) else {
            continue;
        };
        if day > days_in_month(month) {
            continue;
        }
        let Some(candidate) = with_day_at_midnight(month, day) else {
            continue;
        };
        if offset > 0 || candidate >= start_of_day(reference) {
            return Some(candidate);
        }
    }
    None
}

fn substitute_day_of_month(digits: Option<&str>, reference: NaiveDateTime) -> Option<String> {
    let day: u32 = digits?.parse().ok()?;
    let target = resolve_day_of_month(day, reference)?;
    Some(format!(" {} ", format_month_day_year(target)))
}

/// What the inline markers carried.
#[derive(Debug, Default)]
pub struct Tokens {
    pub tags: Vec<String>,
    pub folder_query: Option<String>,
    /// `None` when no priority was written; `Some(None)` when `!0` cleared it.
    pub priority: Option<Option<Priority>>,
    pub duration_minutes: Option<i64>,
    pub window: Option<Window>,
    /// Reminder leads in minutes, one per phrase found, in the order found.
    /// Not yet resolved: whether they become rows or go back into the title
    /// depends on the schedule, which is not known until the date engine has
    /// run. See `reminder_placeholder`.
    pub reminder_leads: Vec<i64>,
    /// The phrases those leads came from, as typed and trimmed, so a reminder
    /// on a page with no date can be put back into the title verbatim.
    pub reminder_tokens: Vec<String>,
}

/// The stand-in a reminder phrase leaves in the text while the rest of the
/// pipeline runs.
///
/// Control characters only, so nothing between the stash and the restore can
/// match inside it — a "1d" left in the text would be read as the event's own
/// date by the engine that runs next. The index is encoded in the run length,
/// which is what lets the restore step find each one again.
pub fn reminder_placeholder(index: usize) -> String {
    format!("\u{0}{}\u{0}", "\u{1}".repeat(index + 1))
}

/// Pull the inline markers out, leaving the rest of the text behind.
///
/// `reference` is needed only for "through <date>", which names a boundary
/// rather than a thing to schedule — so it is read *without* forward-dating,
/// or a window that closed last week would be read as one closing next year.
pub fn extract(text: &str, reference: NaiveDateTime) -> (String, Tokens) {
    let mut tokens = Tokens::default();
    let mut text = text.to_string();

    static TAG: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| compile("#([0-9A-Za-z_]+)"));
    text = replace_all_with(&text, tag, |captures| {
        tokens
            .tags
            .push(group(captures, 1).unwrap_or_default().to_string());
        " ".to_string()
    });

    // Last folder wins, mirroring priority.
    static FOLDER: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let folder = FOLDER.get_or_init(|| compile("~([0-9A-Za-z_]+)"));
    text = replace_all_with(&text, folder, |captures| {
        tokens.folder_query = Some(group(captures, 1).unwrap_or_default().to_string());
        " ".to_string()
    });

    static NAMED_PRIORITY: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let named_priority = NAMED_PRIORITY.get_or_init(|| compile("!(urgent|high|medium|low)\\b"));
    text = replace_all_with(&text, named_priority, |captures| {
        tokens.priority = Some(
            match group(captures, 1)
                .unwrap_or_default()
                .to_lowercase()
                .as_str()
            {
                "urgent" => Some(Priority::Urgent),
                "high" => Some(Priority::High),
                "medium" => Some(Priority::Medium),
                _ => Some(Priority::Low),
            },
        );
        " ".to_string()
    });

    // `!0` clears an existing priority, which is why the field is doubly
    // optional: "not mentioned" and "explicitly none" are different edits.
    static NUMERIC_PRIORITY: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let numeric_priority = NUMERIC_PRIORITY.get_or_init(|| compile("!([0-4])\\b"));
    text = replace_all_with(&text, numeric_priority, |captures| {
        tokens.priority = Some(match group(captures, 1).unwrap_or_default() {
            "0" => None,
            "1" => Some(Priority::Urgent),
            "2" => Some(Priority::High),
            "3" => Some(Priority::Medium),
            _ => Some(Priority::Low),
        });
        " ".to_string()
    });

    // Reminders: "remind 30m before", "remind me the day before", "!r1h".
    //
    // Stashed before the duration and long before the date engine, so a lead
    // ("1d before") is never mistaken for the event's own date. The phrase is
    // replaced by a placeholder rather than removed, because whether it turns
    // into a row or goes back into the title is decided only once the
    // schedule is known — see the resolution step in `parse_input`.
    const REMINDER_UNIT: &str = "(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)";
    let mut stash_reminder = |whole: &str, amount: Option<&str>, unit: &str| -> String {
        let per = match unit.to_lowercase().as_str() {
            "d" | "day" | "days" => 1440.0,
            "h" | "hour" | "hours" | "hr" | "hrs" => 60.0,
            "m" | "min" | "mins" | "minute" | "minutes" => 1.0,
            _ => return whole.to_string(),
        };
        // A bare unit means one of it: "remind day before" is a one-day lead,
        // which the resolution step turns into the all-day anchor when it can.
        let count: f64 = amount.and_then(|n| n.parse().ok()).unwrap_or(1.0);
        tokens
            .reminder_leads
            .push(round_half_up(count * per).max(0));
        tokens.reminder_tokens.push(whole.trim().to_string());
        format!(
            " {} ",
            reminder_placeholder(tokens.reminder_tokens.len() - 1)
        )
    };

    // Shorthand: "!r30" (minutes by default), "!r1h", "!r1d".
    static REMINDER_SHORT: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let reminder_short = REMINDER_SHORT
        .get_or_init(|| compile(&format!("!r(\\d+(?:\\.\\d+)?)\\s*{REMINDER_UNIT}?\\b")));
    text = replace_all_with(&text, reminder_short, |captures| {
        let whole = captures.get(0).expect("group 0").as_str();
        stash_reminder(whole, group(captures, 1), group(captures, 2).unwrap_or("m"))
    });

    // Phrase: "remind"/"reminder" + generous filler + a strict unit, with the
    // trailing "before" optional. Filler deliberately excludes "in", so
    // "remind me in 2 days" stays a date for the engine rather than a lead.
    static REMINDER_PHRASE: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let reminder_phrase = REMINDER_PHRASE.get_or_init(|| {
        compile(&format!(
            "\\bremind(?:er)?s?\\b(?:\\s+(?:please|about|one|the|an|us|me|at|a))*\\s*\
             (\\d+(?:\\.\\d+)?)?\\s*{REMINDER_UNIT}\\b\
             (?:\\s+(?:beforehand|before|ahead|prior|early|in\\s+advance)\\b)?"
        ))
    });
    text = replace_all_with(&text, reminder_phrase, |captures| {
        let whole = captures.get(0).expect("group 0").as_str();
        stash_reminder(
            whole,
            group(captures, 1),
            group(captures, 2).unwrap_or_default(),
        )
    });

    static DURATION: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let duration = DURATION.get_or_init(|| {
        compile(
            "\\bfor\\s+(\\d+(?:\\.\\d+)?)\\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\\b",
        )
    });
    text = replace_all_with(&text, duration, |captures| {
        let amount: f64 = group(captures, 1)
            .and_then(|n| n.parse().ok())
            .unwrap_or(0.0);
        let hours = matches!(
            group(captures, 2)
                .unwrap_or_default()
                .to_lowercase()
                .as_str(),
            "h" | "hr" | "hrs" | "hour" | "hours"
        );
        let minutes = if hours { amount * 60.0 } else { amount };
        tokens.duration_minutes = Some(round_half_up(minutes));
        " ".to_string()
    });

    // "10 times"
    static TIMES: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let times = TIMES.get_or_init(|| compile("\\b(\\d+)\\s+times\\b"));
    text = replace_all_with(&text, times, |captures| {
        if let Some(count) = group(captures, 1).and_then(|n| n.parse().ok()) {
            tokens.window = Some(Window::Count(count));
        }
        " ".to_string()
    });

    // "for 2 weeks" — months are approximated at 30 days, which is what the
    // reference does and what the corpus pins.
    static FOR_UNITS: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let for_units = FOR_UNITS
        .get_or_init(|| compile("\\bfor\\s+(\\d+)\\s*(day|days|week|weeks|month|months)\\b"));
    text = replace_all_with(&text, for_units, |captures| {
        let count: u32 = group(captures, 1).and_then(|n| n.parse().ok()).unwrap_or(0);
        let unit = group(captures, 2).unwrap_or_default().to_lowercase();
        let days = if unit.starts_with("day") {
            count
        } else if unit.starts_with("week") {
            count * 7
        } else {
            count * 30
        };
        tokens.window = Some(Window::Days(days));
        " ".to_string()
    });

    // "through march 31" / "until june 1" / "till friday".
    static THROUGH_DATE: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let through_date = THROUGH_DATE
        .get_or_init(|| compile("\\b(?:through|until|till)\\s+([a-z]+\\s*\\d*(?:st|nd|rd|th)?)"));
    text = replace_all_with(&text, through_date, |captures| {
        let whole = captures.get(0).expect("group 0").as_str().to_string();
        let Some(date_text) = group(captures, 1) else {
            return whole;
        };
        match crate::nlp::parse_first_with(date_text, reference, false) {
            Some(matched) => {
                tokens.window = Some(Window::Until(matched.start.at));
                " ".to_string()
            }
            None => whole,
        }
    });

    (text, tokens)
}

/// `Math.round`: halves go up, including negative ones (-0.5 rounds to 0).
/// Rust's `f64::round` sends -0.5 to -1, and durations are never negative, but
/// matching the reference costs nothing and removes the question.
fn round_half_up(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sunday_noon() -> NaiveDateTime {
        "2026-03-15T12:00:00".parse().expect("valid")
    }

    #[test]
    fn tonight_rolls_to_tomorrow_once_the_evening_has_gone() {
        assert_eq!(
            rewrite("dinner tonight", sunday_noon()),
            "dinner today at 8pm"
        );
        let late: NaiveDateTime = "2026-03-21T22:30:00".parse().expect("valid");
        assert_eq!(rewrite("dinner tonight", late), "dinner tomorrow at 8pm");
    }

    #[test]
    fn tonight_at_exactly_eight_has_already_gone() {
        // The boundary is exclusive: at 20:00 on the dot, tonight's 8pm slot
        // is no longer in the future.
        let eight: NaiveDateTime = "2026-03-15T20:00:00".parse().expect("valid");
        assert_eq!(rewrite("dinner tonight", eight), "dinner tomorrow at 8pm");
        let just_before: NaiveDateTime = "2026-03-15T19:59:00".parse().expect("valid");
        assert_eq!(
            rewrite("dinner tonight", just_before),
            "dinner today at 8pm"
        );
    }

    #[test]
    fn this_morning_rolls_to_tomorrow_once_nine_has_gone() {
        let early: NaiveDateTime = "2026-03-16T08:00:00".parse().expect("valid");
        assert_eq!(rewrite("gym this morning", early), "gym today at 9am");
        assert_eq!(
            rewrite("gym this morning", sunday_noon()),
            "gym tomorrow at 9am"
        );
    }

    #[test]
    fn a_weekday_period_keeps_the_weekday() {
        assert_eq!(
            rewrite("standup monday morning", sunday_noon()),
            "standup monday at 9am"
        );
    }

    #[test]
    fn last_weekday_resolves_backwards() {
        // Sunday 2026-03-15; the previous Monday is the 9th.
        assert_eq!(
            rewrite("note last monday", sunday_noon()),
            "note 2026-03-09"
        );
        // The same weekday as the reference means a full week back.
        assert_eq!(
            rewrite("note last sunday", sunday_noon()),
            "note 2026-03-08"
        );
    }

    #[test]
    fn a_day_of_month_resolves_forward_past_a_short_month() {
        // From 15 March, "on the 31st" is this month.
        assert!(rewrite("pay rent on the 31st", sunday_noon()).contains("Mar 31 2026"));
        // From 30 January, the 31st is still January.
        let january: NaiveDateTime = "2026-01-30T12:00:00".parse().expect("valid");
        assert!(rewrite("pay rent on the 31st", january).contains("Jan 31 2026"));
        // From 1 February there is no 31st, so it skips to March.
        let february: NaiveDateTime = "2026-02-01T12:00:00".parse().expect("valid");
        assert!(rewrite("pay rent on the 31st", february).contains("Mar 31 2026"));
    }

    #[test]
    fn a_bare_ordinal_without_a_connector_is_left_alone() {
        // "3rd draft" is not a date, and treating it as one would be worse
        // than missing it.
        let rewritten = rewrite("3rd draft", sunday_noon());
        assert_eq!(rewritten, "3rd draft");
    }

    #[test]
    fn a_recurrence_phrase_is_not_eaten_by_the_weekday_number_rule() {
        let rewritten = rewrite("standup every friday 13", sunday_noon());
        assert!(rewritten.contains("every friday"), "got {rewritten:?}");
    }

    #[test]
    fn inline_markers_come_out_and_leave_the_title() {
        let (rest, tokens) = extract("call bob #work #urgent ~inbox !high for 90m", sunday_noon());
        assert_eq!(tokens.tags, ["work", "urgent"]);
        assert_eq!(tokens.folder_query.as_deref(), Some("inbox"));
        assert_eq!(tokens.priority, Some(Some(Priority::High)));
        assert_eq!(tokens.duration_minutes, Some(90));
        assert!(rest.contains("call bob"), "got {rest:?}");
    }

    #[test]
    fn clearing_a_priority_is_different_from_not_naming_one() {
        let (_, none) = extract("call bob", sunday_noon());
        assert_eq!(none.priority, None);
        let (_, cleared) = extract("call bob !0", sunday_noon());
        assert_eq!(cleared.priority, Some(None));
    }

    #[test]
    fn fractional_hours_round_to_whole_minutes() {
        let (_, tokens) = extract("run for 1.5 hours", sunday_noon());
        assert_eq!(tokens.duration_minutes, Some(90));
        let (_, odd) = extract("run for 1.51 hours", sunday_noon());
        assert_eq!(odd.duration_minutes, Some(91));
    }

    #[test]
    fn a_window_boundary_is_read_without_forward_dating() {
        let (_, tokens) = extract("standup through march 31", sunday_noon());
        assert_eq!(
            tokens.window,
            Some(Window::Until("2026-03-31T12:00:00".parse().expect("valid")))
        );
    }

    #[test]
    fn a_month_window_is_approximated_at_thirty_days() {
        let (_, tokens) = extract("standup for 2 months", sunday_noon());
        assert_eq!(tokens.window, Some(Window::Days(60)));
    }
}
