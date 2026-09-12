//! Single-page predicates.
//!
//! Port of `packages/core/src/utils/page.ts`. Trivial today, but routed through
//! named predicates for the same reason the TypeScript is: a future
//! `PageStatus` variant (an "in progress", say) then has one place to update
//! rather than every list and filter site on two platforms.

/// A page's completion state, as stored in `pages.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageStatus {
    NotStarted,
    Done,
}

impl PageStatus {
    /// Read the stored string form. Unknown values read as `NotStarted`,
    /// matching the TypeScript predicates, which treat anything not exactly
    /// `"done"` as open.
    ///
    /// Deliberately not `FromStr`: that trait implies parsing can fail, and
    /// this cannot — an unrecognised status is a valid open page, not an error.
    pub fn from_stored(s: &str) -> Self {
        if s == "done" {
            PageStatus::Done
        } else {
            PageStatus::NotStarted
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PageStatus::Done => "done",
            PageStatus::NotStarted => "not_started",
        }
    }
}

pub fn is_done(status: PageStatus) -> bool {
    status == PageStatus::Done
}

pub fn is_open(status: PageStatus) -> bool {
    status != PageStatus::Done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_status_reads_as_open() {
        // The TS predicate is `status !== "done"`, so an unrecognised value is
        // open rather than an error. Worth pinning: a status added on one
        // platform and not the other must not make pages vanish from lists.
        assert!(is_open(PageStatus::from_stored("in_progress")));
        assert!(is_open(PageStatus::from_stored("")));
        assert!(is_done(PageStatus::from_stored("done")));
    }

    #[test]
    fn round_trips_known_values() {
        for s in ["done", "not_started"] {
            assert_eq!(PageStatus::from_stored(s).as_str(), s);
        }
    }
}
