use super::*;

#[test]
fn serializes_with_kind_and_message() {
    let err = AppError::NotFound("page xyz".into());
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "NotFound");
    assert_eq!(v["message"], "not found: page xyz");
}

#[test]
fn serializes_db_kind() {
    let err = AppError::Db(sqlx::Error::RowNotFound);
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Db");
}

#[test]
fn from_io_error() {
    let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
    let err: AppError = io.into();
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Io");
}

#[test]
fn from_serde_error() {
    let bad: Result<serde_json::Value, _> = serde_json::from_str("not json");
    let err: AppError = bad.unwrap_err().into();
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Serde");
}
