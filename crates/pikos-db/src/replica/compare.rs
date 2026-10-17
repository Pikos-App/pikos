//! Where two copies of a workspace disagree on what sync carries, for checking that devices
//! converged.

use std::collections::BTreeMap;

use serde::Serialize;

use super::manifest;
use super::state::SyncedRow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    First,
    Second,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Difference {
    /// One side holds the record and the other doesn't.
    OnlyIn { record: String, side: Side },
    /// Both hold the record and this field differs, its columns as SQLite's `quote()` writes them.
    Field {
        record: String,
        field: &'static str,
        first: Vec<String>,
        second: Vec<String>,
    },
}

/// Every difference between two copies' synced rows, in record-name order.
pub fn differences(first: Vec<SyncedRow>, second: Vec<SyncedRow>) -> Vec<Difference> {
    let by_name = |rows: Vec<SyncedRow>| -> BTreeMap<String, SyncedRow> {
        rows.into_iter()
            .map(|row| (row.name.to_string(), row))
            .collect()
    };
    let first = by_name(first);
    let mut second = by_name(second);

    let mut found = Vec::new();
    for (record, ours) in first {
        let Some(theirs) = second.remove(&record) else {
            found.push(Difference::OnlyIn {
                record,
                side: Side::First,
            });
            continue;
        };

        let fields = manifest::entity(ours.name.entity).map_or(&[][..], |e| e.fields);
        for (slot, (a, b)) in ours.fields.iter().zip(&theirs.fields).enumerate() {
            if a != b {
                found.push(Difference::Field {
                    record: record.clone(),
                    field: fields.get(slot).map_or("?", |f| f.name),
                    first: a.clone(),
                    second: b.clone(),
                });
            }
        }
    }
    found.extend(second.into_keys().map(|record| Difference::OnlyIn {
        record,
        side: Side::Second,
    }));

    found.sort_by(|a, b| record_of(a).cmp(record_of(b)));
    found
}

fn record_of(difference: &Difference) -> &str {
    match difference {
        Difference::OnlyIn { record, .. } | Difference::Field { record, .. } => record,
    }
}

#[cfg(test)]
#[path = "compare_tests.rs"]
mod tests;
