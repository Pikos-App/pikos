//! Records as transports store them: a flat map of named values.
//!
//! CloudKit stores a record as named fields of a few plain types, and a folder transport can write
//! the same map, so the map is the one shape every transport carries. A field's columns are stored
//! one per name, `<field>.<column index>`, with its clock beside them as `<field>@`; an absent
//! column is NULL.

use std::collections::BTreeMap;
use std::fmt;

use crate::merge::{FieldState, RowState, Value};
use crate::{Hlc, RecordName, FORMAT_VERSION};

pub type FieldMap = BTreeMap<String, Value>;

const FORMAT: &str = "fmt";
const BORN: &str = "born";
const TOMB: &str = "tomb";

/// A field's name and how many columns it holds, in the entity's field order.
pub type Shape<'a> = &'a [(&'a str, usize)];

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub name: RecordName,
    pub row: RowState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Written by a newer Pikos than this one. Kept and applied after an update, never dropped.
    NewerFormat(u32),
    Malformed(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::NewerFormat(v) => write!(f, "written by a newer Pikos (format {v})"),
            DecodeError::Malformed(why) => write!(f, "malformed record: {why}"),
        }
    }
}

impl std::error::Error for DecodeError {}

fn column_key(field: &str, column: usize) -> String {
    format!("{field}.{column}")
}

fn clock_key(field: &str) -> String {
    format!("{field}@")
}

pub fn encode(record: &Record, shape: Shape) -> FieldMap {
    let mut map = FieldMap::new();
    map.insert(FORMAT.into(), Value::Integer(i64::from(FORMAT_VERSION)));
    map.insert(BORN.into(), Value::Text(record.row.born.to_string()));
    if let Some(tomb) = record.row.tomb {
        map.insert(TOMB.into(), Value::Text(tomb.to_string()));
    }
    for ((name, _), field) in shape.iter().zip(&record.row.fields) {
        map.insert(clock_key(name), Value::Text(field.clock.to_string()));
        for (i, value) in field.values.iter().enumerate() {
            if *value != Value::Null {
                map.insert(column_key(name, i), value.clone());
            }
        }
    }
    map
}

fn clock(map: &FieldMap, key: &str) -> Result<Option<Hlc>, DecodeError> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::Text(text)) => text
            .parse()
            .map(Some)
            .map_err(|e| DecodeError::Malformed(format!("{key}: {e}"))),
        Some(other) => Err(DecodeError::Malformed(format!("{key}: {other:?}"))),
    }
}

pub fn decode(name: RecordName, map: &FieldMap, shape: Shape) -> Result<Record, DecodeError> {
    let format = match map.get(FORMAT) {
        Some(Value::Integer(v)) => u32::try_from(*v).map_err(|_| malformed("format"))?,
        _ => return Err(malformed("format")),
    };
    if format > FORMAT_VERSION {
        return Err(DecodeError::NewerFormat(format));
    }

    let born = clock(map, BORN)?.ok_or_else(|| malformed(BORN))?;
    let tomb = clock(map, TOMB)?;
    let fields = shape
        .iter()
        .map(|(field, columns)| {
            let clock = clock(map, &clock_key(field))?.ok_or_else(|| malformed(field))?;
            let values = (0..*columns)
                .map(|i| {
                    map.get(&column_key(field, i))
                        .cloned()
                        .unwrap_or(Value::Null)
                })
                .collect();
            Ok(FieldState { values, clock })
        })
        .collect::<Result<_, DecodeError>>()?;

    Ok(Record {
        name,
        row: RowState { born, fields, tomb },
    })
}

fn malformed(what: &str) -> DecodeError {
    DecodeError::Malformed(format!("missing or unreadable {what}"))
}

#[cfg(test)]
#[path = "codec_tests.rs"]
mod tests;
