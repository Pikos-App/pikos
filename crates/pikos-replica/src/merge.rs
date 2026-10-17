//! Merge: how another device's copy of a row and this device's become one.
//!
//! Every field moves under its own clock and the higher clock wins. Two writes stamped with the same
//! clock fall to comparing their values, so every device picks the same one in any order, even two
//! devices running with one copied device id. A row is gone while its tombstone is newer than
//! everything written to it; a strictly later write brings it back.

use std::cmp::Ordering;

use crate::Hlc;

/// A column value as SQLite holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
}

impl Value {
    /// A total order, used only to break a tie between two writes stamped with one clock.
    fn tiebreak(&self, other: &Value) -> Ordering {
        fn rank(v: &Value) -> u8 {
            match v {
                Value::Null => 0,
                Value::Integer(_) => 1,
                Value::Real(_) => 2,
                Value::Text(_) => 3,
            }
        }
        match (self, other) {
            (Value::Integer(a), Value::Integer(b)) => a.cmp(b),
            (Value::Real(a), Value::Real(b)) => a.total_cmp(b),
            (Value::Text(a), Value::Text(b)) => a.as_bytes().cmp(b.as_bytes()),
            _ => rank(self).cmp(&rank(other)),
        }
    }
}

/// One field's columns and the clock they were written at.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldState {
    pub values: Vec<Value>,
    pub clock: Hlc,
}

impl FieldState {
    fn beats(&self, other: &FieldState) -> bool {
        match self.clock.cmp(&other.clock) {
            Ordering::Greater => true,
            Ordering::Less => false,
            Ordering::Equal => {
                let order = self
                    .values
                    .iter()
                    .zip(&other.values)
                    .map(|(a, b)| a.tiebreak(b))
                    .find(|o| o.is_ne())
                    .unwrap_or_else(|| self.values.len().cmp(&other.values.len()));
                order == Ordering::Greater
            }
        }
    }
}

/// Everything sync knows about one row: when it was created, each field in the entity's field
/// order, and the clock of its delete while it's gone.
#[derive(Debug, Clone, PartialEq)]
pub struct RowState {
    pub born: Hlc,
    pub fields: Vec<FieldState>,
    pub tomb: Option<Hlc>,
}

impl RowState {
    /// The newest write to the row, its creation included.
    pub fn newest(&self) -> Hlc {
        self.fields
            .iter()
            .map(|f| f.clock)
            .fold(self.born, Hlc::max)
    }

    pub fn is_live(&self) -> bool {
        self.tomb.is_none_or(|tomb| self.newest() > tomb)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub row: RowState,
    /// Bit `i` set when field `i` takes the other device's value, so this device writes it.
    pub taken: u64,
    /// The row was live here and the merged row is gone, or the other way round.
    pub liveness_changed: bool,
    /// The other device deleted the row and a later write here brought it back. Every other device
    /// removed what hung off it in their cascade, so this device sends it all again.
    pub outlived_tombstone: bool,
}

/// Merges `remote` into `local`, which is None when this device has never had the row.
///
/// Rows of one entity have the same fields; a remote row with fields this device doesn't know is
/// from a newer format and is refused before it gets here.
pub fn merge(local: Option<&RowState>, remote: &RowState) -> Merged {
    let Some(local) = local else {
        return Merged {
            row: remote.clone(),
            taken: (0..remote.fields.len()).fold(0, |mask, i| mask | (1 << i)),
            liveness_changed: remote.is_live(),
            outlived_tombstone: false,
        };
    };

    // A copy that's gone holds no values worth keeping, only when it went: its fields are
    // whatever was there at the delete, or nothing at all on a device that never had the row. Gone
    // is judged against the newer of the two tombstones, since a copy that hasn't heard of a purge
    // yet still died in it if nothing was written to it since.
    let tomb = local.tomb.max(remote.tomb);
    let alive = |row: &RowState| tomb.is_none_or(|tomb| row.newest() > tomb);
    let mut taken = 0u64;
    let all = (0..remote.fields.len()).fold(0, |mask, i| mask | (1 << i));
    let fields = match (alive(local), alive(remote)) {
        (true, false) => local.fields.clone(),
        (false, true) => {
            taken = all;
            remote.fields.clone()
        }
        _ => local
            .fields
            .iter()
            .zip(&remote.fields)
            .enumerate()
            .map(|(i, (mine, theirs))| {
                if theirs.beats(mine) {
                    taken |= 1 << i;
                    theirs.clone()
                } else {
                    mine.clone()
                }
            })
            .collect(),
    };
    let row = RowState {
        born: local.born.max(remote.born),
        fields,
        tomb: local.tomb.max(remote.tomb),
    };

    let outlived_tombstone = remote.tomb.is_some_and(|tomb| local.newest() > tomb)
        && local.is_live()
        && remote.tomb > local.tomb;
    Merged {
        liveness_changed: row.is_live() != local.is_live(),
        row,
        taken,
        outlived_tombstone,
    }
}

#[cfg(test)]
#[path = "merge_tests.rs"]
mod tests;
