use super::{decode, encode, DecodeError, FieldMap, Record};
use crate::merge::{FieldState, RowState, Value};
use crate::{Entity, Hlc, RecordName, FORMAT_VERSION};

const SHAPE: &[(&str, usize)] = &[("title", 1), ("status", 2)];

fn record() -> Record {
    Record {
        name: RecordName::live(Entity::Page, "p1"),
        row: RowState {
            born: Hlc::new(1, 0),
            fields: vec![
                FieldState {
                    values: vec![Value::Text("Groceries".into())],
                    clock: Hlc::new(5, 2),
                },
                FieldState {
                    values: vec![Value::Text("not_started".into()), Value::Null],
                    clock: Hlc::new(3, 0),
                },
            ],
            tomb: None,
        },
    }
}

#[test]
fn a_record_round_trips_through_its_field_map() {
    let original = record();

    let map = encode(&original, SHAPE);
    let decoded = decode(original.name.clone(), &map, SHAPE).unwrap();

    assert_eq!(decoded, original);
    assert!(!map.contains_key("status.1"), "a NULL column is left out");
    assert!(!map.contains_key("tomb"));
}

#[test]
fn a_tombstone_round_trips() {
    let mut original = record();
    original.row.tomb = Some(Hlc::new(9, 0));

    let map = encode(&original, SHAPE);

    assert_eq!(
        decode(original.name.clone(), &map, SHAPE).unwrap(),
        original
    );
}

#[test]
fn a_record_from_a_newer_pikos_is_refused_by_name() {
    let mut map = encode(&record(), SHAPE);
    map.insert("fmt".into(), Value::Integer(i64::from(FORMAT_VERSION) + 1));

    assert_eq!(
        decode(record().name, &map, SHAPE),
        Err(DecodeError::NewerFormat(FORMAT_VERSION + 1))
    );
}

#[test]
fn a_record_missing_a_clock_is_malformed() {
    let mut map: FieldMap = encode(&record(), SHAPE);
    map.remove("status@");

    assert!(matches!(
        decode(record().name, &map, SHAPE),
        Err(DecodeError::Malformed(_))
    ));
}
