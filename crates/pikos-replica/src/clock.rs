//! Hybrid logical clock: wall time that never runs backwards and always moves
//! past any clock it has observed.
//!
//! A device whose wall clock runs behind still stamps its next edit after a
//! remote edit it has seen, so the newer edit wins. A device whose clock runs
//! far ahead still wins concurrent edits until real time catches up; no clock
//! scheme prevents that, which is why tombstone expiry uses wall time instead.

use std::fmt;
use std::str::FromStr;

/// Wall time in milliseconds since the Unix epoch, plus a counter that orders
/// events within one millisecond. Field order is comparison order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hlc {
    wall_ms: u64,
    counter: u32,
}

/// 12 hex digits of milliseconds reach the year 10889.
const WALL_DIGITS: usize = 12;
const COUNTER_DIGITS: usize = 8;
const ENCODED_LEN: usize = WALL_DIGITS + COUNTER_DIGITS;
const WALL_MAX: u64 = (1 << (WALL_DIGITS * 4)) - 1;

impl Hlc {
    pub const ZERO: Hlc = Hlc {
        wall_ms: 0,
        counter: 0,
    };

    pub fn new(wall_ms: u64, counter: u32) -> Hlc {
        Hlc {
            wall_ms: wall_ms.min(WALL_MAX),
            counter,
        }
    }

    pub fn wall_ms(self) -> u64 {
        self.wall_ms
    }

    pub fn counter(self) -> u32 {
        self.counter
    }

    /// The clock for a local write made at `now_ms`.
    pub fn next(self, now_ms: u64) -> Hlc {
        let now_ms = now_ms.min(WALL_MAX);
        if now_ms > self.wall_ms {
            return Hlc {
                wall_ms: now_ms,
                counter: 0,
            };
        }
        match self.counter.checked_add(1) {
            Some(counter) => Hlc {
                wall_ms: self.wall_ms,
                counter,
            },
            None => Hlc {
                wall_ms: self.wall_ms + 1,
                counter: 0,
            },
        }
    }

    /// The clock after applying a remote record. The max is enough, because the
    /// next local write goes through [`Hlc::next`], which moves strictly past it.
    pub fn observe(self, remote: Hlc) -> Hlc {
        self.max(remote)
    }
}

/// Fixed-width lowercase hex, so text order is clock order and SQLite can
/// compare and `MAX()` clocks stored as text.
impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:0wall$x}{:0counter$x}",
            self.wall_ms,
            self.counter,
            wall = WALL_DIGITS,
            counter = COUNTER_DIGITS
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseHlcError(String);

impl fmt::Display for ParseHlcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a clock: {:?}", self.0)
    }
}

impl std::error::Error for ParseHlcError {}

impl FromStr for Hlc {
    type Err = ParseHlcError;

    fn from_str(s: &str) -> Result<Hlc, ParseHlcError> {
        let err = || ParseHlcError(s.to_owned());
        let lower_hex = |c: char| c.is_ascii_digit() || ('a'..='f').contains(&c);
        if s.len() != ENCODED_LEN || !s.chars().all(lower_hex) {
            return Err(err());
        }
        let (wall, counter) = s.split_at(WALL_DIGITS);
        Ok(Hlc {
            wall_ms: u64::from_str_radix(wall, 16).map_err(|_| err())?,
            counter: u32::from_str_radix(counter, 16).map_err(|_| err())?,
        })
    }
}

#[cfg(test)]
#[path = "clock_tests.rs"]
mod tests;
