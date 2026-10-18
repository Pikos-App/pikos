//! How many reads the app made of its workspace and how many rows they returned. The phone's count
//! check holds a screen's reads to fixed limits: a screen that starts reading every page shows as a
//! count on any device, long before it shows as a timing on a fast one.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub(crate) struct ReadTally {
    calls: AtomicU64,
    rows: AtomicU64,
}

impl ReadTally {
    /// Counts one read that returned `rows` rows, and hands its value back.
    pub(crate) fn noted<T>(&self, value: T, rows: impl FnOnce(&T) -> usize) -> T {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.rows.fetch_add(rows(&value) as u64, Ordering::Relaxed);
        value
    }

    pub(crate) fn count(&self) -> ReadCount {
        ReadCount {
            calls: self.calls.load(Ordering::Relaxed),
            rows: self.rows.load(Ordering::Relaxed),
        }
    }
}

/// Every read since the workspace opened.
#[derive(uniffi::Record, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadCount {
    pub calls: u64,
    pub rows: u64,
}
