//! A page body too big for a record travels as a file beside it, as an image does.
//!
//! CloudKit refuses a record over about 1 MB, files excepted, and a body is one field of one
//! record, so a long enough page would never send and would be retried forever. Over
//! [`INLINE_MAX`] the body is written to a file the transport attaches, and the arriving side reads
//! it back into the field before anything else sees the record. Chunked storage replaces this
//! with chunk records under a format bump.

use std::path::PathBuf;

use pikos_replica::codec::{self, FieldMap};
use pikos_replica::merge::Value;
use pikos_replica::{Entity, Hlc, RecordName};

use crate::error::{AppError, AppResult};

/// Below CloudKit's 1 MB record cap with room for the record's other fields and encryption.
pub(crate) const INLINE_MAX: usize = 700_000;

fn content_key() -> String {
    codec::column_key("content", 0)
}

fn set_aside_path(name: &RecordName, clock: Hlc) -> PathBuf {
    std::env::temp_dir().join("pikos-outbox").join(format!(
        "{}-{}-{clock}.json",
        name.entity.prefix(),
        name.key
    ))
}

/// Moves a body over [`INLINE_MAX`] out of `fields` into a file named in its place.
pub(crate) fn set_aside(name: &RecordName, clock: Hlc, fields: &mut FieldMap) -> AppResult<()> {
    let oversize = name.entity == Entity::Body
        && matches!(fields.get(&content_key()), Some(Value::Text(body)) if body.len() > INLINE_MAX);
    if !oversize {
        return Ok(());
    }

    let Some(Value::Text(body)) = fields.remove(&content_key()) else {
        return Ok(());
    };
    let path = set_aside_path(name, clock);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, body)?;
    fields.insert(
        codec::FILE.to_owned(),
        Value::Text(path.to_string_lossy().into_owned()),
    );
    Ok(())
}

/// Puts a body that arrived as a file back into its field. A file that can't be read fails the
/// apply, so the transport fetches the record again: applying it without its body would empty
/// the page.
pub(crate) fn take_back(name: &RecordName, mut fields: FieldMap) -> AppResult<FieldMap> {
    if name.entity != Entity::Body {
        return Ok(fields);
    }
    let Some(Value::Text(path)) = fields.remove(codec::FILE) else {
        return Ok(fields);
    };

    let body = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Internal(format!("{name}'s body file: {e}")))?;
    fields.insert(content_key(), Value::Text(body));
    Ok(fields)
}

/// The set-aside copy is no longer needed once the transport has stored the record.
pub(crate) fn sent(name: &RecordName, clock: Hlc) {
    let _ = std::fs::remove_file(set_aside_path(name, clock));
}

#[cfg(test)]
#[path = "oversize_tests.rs"]
mod tests;
