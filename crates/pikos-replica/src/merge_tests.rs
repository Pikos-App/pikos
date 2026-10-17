use super::{merge, FieldState, RowState, Value};
use crate::Hlc;

fn clock(ms: u64) -> Hlc {
    Hlc::new(ms, 0)
}

fn text(s: &str) -> Vec<Value> {
    vec![Value::Text(s.to_owned())]
}

fn field(values: Vec<Value>, at: u64) -> FieldState {
    FieldState {
        values,
        clock: clock(at),
    }
}

fn row(born: u64, fields: Vec<FieldState>, tomb: Option<u64>) -> RowState {
    RowState {
        born: clock(born),
        fields,
        tomb: tomb.map(clock),
    }
}

fn titled(title: &str, title_at: u64, status: &str, status_at: u64) -> RowState {
    row(
        1,
        vec![field(text(title), title_at), field(text(status), status_at)],
        None,
    )
}

#[test]
fn each_field_takes_the_newer_write() {
    let mac = titled("Groceries, Saturday", 20, "not_started", 1);
    let phone = titled("Groceries", 1, "done", 30);

    let on_mac = merge(Some(&mac), &phone);
    let on_phone = merge(Some(&phone), &mac);

    let expected = titled("Groceries, Saturday", 20, "done", 30);
    assert_eq!(on_mac.row, expected);
    assert_eq!(on_phone.row, expected);
    assert_eq!(on_mac.taken, 0b10, "the Mac takes the phone's status");
    assert_eq!(on_phone.taken, 0b01, "the phone takes the Mac's title");
}

#[test]
fn a_tie_on_the_clock_goes_to_the_same_value_on_every_device() {
    let a = titled("Apples", 10, "done", 1);
    let b = titled("Bananas", 10, "done", 1);

    assert_eq!(merge(Some(&a), &b).row, merge(Some(&b), &a).row);
    assert_eq!(merge(Some(&a), &b).row.fields[0].values, text("Bananas"));
}

#[test]
fn ties_order_nulls_numbers_and_text_the_same_everywhere() {
    let null = row(1, vec![field(vec![Value::Null], 5)], None);
    let number = row(1, vec![field(vec![Value::Integer(3)], 5)], None);
    let words = row(1, vec![field(text("3"), 5)], None);

    for (a, b) in [(&null, &number), (&number, &words), (&null, &words)] {
        assert_eq!(merge(Some(a), b).row, merge(Some(b), a).row);
        assert_eq!(merge(Some(a), b).row, *b);
    }
}

#[test]
fn a_row_this_device_never_had_is_taken_whole() {
    let remote = titled("Groceries", 5, "done", 6);

    let merged = merge(None, &remote);

    assert_eq!(merged.row, remote);
    assert_eq!(merged.taken, 0b11);
    assert!(merged.liveness_changed);
}

#[test]
fn a_purge_beats_the_writes_before_it_in_either_order() {
    let edited = titled("Groceries", 10, "done", 12);
    let purged = RowState {
        tomb: Some(clock(20)),
        ..titled("Groceries", 10, "not_started", 1)
    };

    let here = merge(Some(&edited), &purged);
    let there = merge(Some(&purged), &edited);

    assert!(!here.row.is_live());
    assert!(!there.row.is_live());
    assert_eq!(here.row, there.row);
    assert!(here.liveness_changed);
    assert!(!here.outlived_tombstone);
}

#[test]
fn a_write_after_the_purge_brings_the_row_back_and_is_sent_again() {
    let edited_later = titled("Groceries", 10, "done", 30);
    let purged = RowState {
        tomb: Some(clock(20)),
        ..titled("Groceries", 10, "not_started", 1)
    };

    let here = merge(Some(&edited_later), &purged);
    let there = merge(Some(&purged), &edited_later);

    assert!(here.row.is_live());
    assert!(there.row.is_live());
    assert_eq!(here.row, there.row);
    assert!(
        here.outlived_tombstone,
        "the device holding the later write sends the row and its children again"
    );
    assert!(!here.liveness_changed);
    assert!(there.liveness_changed);
}

#[test]
fn a_deleted_copy_never_lends_its_values_to_a_live_one() {
    let blank = || vec![Value::Null];
    let tombstone = row(5, vec![field(blank(), 18), field(blank(), 18)], Some(20));
    let revived = titled("Groceries", 10, "done", 30);

    let here = merge(Some(&revived), &tombstone);
    let there = merge(Some(&tombstone), &revived);

    assert!(here.row.is_live());
    assert_eq!(
        here.row.fields, revived.fields,
        "the newer title clock on the tombstone doesn't count"
    );
    assert_eq!(there.row, here.row);
    assert_eq!(there.taken, 0b11);
}

#[test]
fn a_tombstone_seen_twice_is_not_outlived_twice() {
    let revived = RowState {
        tomb: Some(clock(20)),
        ..titled("Groceries", 10, "done", 30)
    };
    let purged = RowState {
        tomb: Some(clock(20)),
        ..titled("Groceries", 10, "not_started", 1)
    };

    assert!(!merge(Some(&revived), &purged).outlived_tombstone);
}

#[test]
fn a_set_member_removed_and_added_again_follows_the_latest() {
    let added_again = row(30, vec![], Some(20));
    let removed = row(10, vec![], Some(20));
    let added = row(10, vec![], None);

    assert!(merge(Some(&removed), &added_again).row.is_live());
    assert!(!merge(Some(&added), &removed).row.is_live());
    assert!(merge(Some(&added), &added_again).row.is_live());
}

#[test]
fn merging_is_idempotent_and_order_free() {
    let a = titled("A", 3, "done", 9);
    let b = RowState {
        tomb: Some(clock(5)),
        ..titled("B", 7, "not_started", 2)
    };
    let c = titled("C", 8, "not_started", 1);

    let ab = merge(Some(&a), &b).row;
    let abc = merge(Some(&ab), &c).row;
    let cb = merge(Some(&c), &b).row;
    let cba = merge(Some(&cb), &a).row;

    assert_eq!(abc, cba);
    assert_eq!(merge(Some(&abc), &abc).row, abc);
    assert_eq!(merge(Some(&abc), &abc).taken, 0);
}
