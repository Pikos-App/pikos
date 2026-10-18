//! The CloudKit schema the sync records need, generated from the manifest and the tables' declared
//! column types.
//!
//! CloudKit's Production environment refuses a record type or field it hasn't been told about, so
//! the schema is loaded into Development with `cktool` and deployed from there. Every field sits in
//! the record's encrypted values, so each one is declared encrypted. The output is checked in at
//! [`SCHEMA_FILE`]; `UPDATE_GOLDEN=1 cargo test -p pikos-db replica` rewrites it.

use sqlx::SqlitePool;

use pikos_replica::codec;
use pikos_replica::Entity;

use super::manifest::ENTITIES;
use crate::error::AppResult;

/// Relative to this crate.
pub const SCHEMA_FILE: &str = "../../apps/apple/PikosSync/cloudkit-schema.ckdb";

/// The field holding a record's real name, which the Swift transport writes beside the codec's keys.
const NAME_FIELD: &str = "record";

/// CloudKit creates this type in every container and won't delete it, so an imported schema has to
/// keep it as it is.
const USERS_TYPE: &str = r#"    RECORD TYPE Users (
        "___createTime" TIMESTAMP,
        "___createdBy"  REFERENCE,
        "___etag"       STRING,
        "___modTime"    TIMESTAMP,
        "___modifiedBy" REFERENCE,
        "___recordID"   REFERENCE,
        roles           LIST<INT64>,
        GRANT WRITE TO "_creator",
        GRANT READ TO "_world"
    );"#;

pub async fn cloudkit_schema(pool: &SqlitePool) -> AppResult<String> {
    let mut types = vec![USERS_TYPE.to_owned()];
    for entity in ENTITIES {
        let declared: Vec<(String, String)> =
            sqlx::query_as("SELECT name, type FROM pragma_table_info(?)")
                .bind(entity.table)
                .fetch_all(pool)
                .await?;
        let declared_type = |column: &str| {
            declared
                .iter()
                .find(|(name, _)| name == column)
                .map(|(_, ty)| cloudkit_type(ty))
                .unwrap_or("STRING")
        };

        let mut fields = header_fields();
        for field in entity.fields {
            fields.push((format!("{}_at", field.name), "STRING"));
            for (i, column) in field.columns.iter().enumerate() {
                fields.push((format!("{}_{i}", field.name), declared_type(column)));
            }
        }
        // A body too big for a record rides a file, as an image does.
        let plain: &[(&str, &str)] = if entity.entity == Entity::Body {
            &[(codec::FILE, "ASSET")]
        } else {
            &[]
        };
        types.push(record_type(entity.entity.prefix(), &fields, plain));
    }
    types.push(record_type(
        Entity::Asset.prefix(),
        &header_fields(),
        &[(codec::FILE, "ASSET")],
    ));
    Ok(format!("DEFINE SCHEMA\n\n{}\n", types.join("\n\n")))
}

/// The codec's own keys and the record's real name, which every record type carries.
fn header_fields() -> Vec<(String, &'static str)> {
    vec![
        ("fmt".to_owned(), "INT64"),
        ("born".to_owned(), "STRING"),
        ("tomb".to_owned(), "STRING"),
        (NAME_FIELD.to_owned(), "STRING"),
    ]
}

/// `plain` fields sit outside the encrypted values: CloudKit encrypts an asset itself and won't
/// take one there.
fn record_type(prefix: &str, encrypted: &[(String, &str)], plain: &[(&str, &str)]) -> String {
    let mut lines = vec![
        r#"        "___createTime" TIMESTAMP"#.to_owned(),
        r#"        "___createdBy"  REFERENCE"#.to_owned(),
        r#"        "___etag"       STRING"#.to_owned(),
        r#"        "___modTime"    TIMESTAMP"#.to_owned(),
        r#"        "___modifiedBy" REFERENCE"#.to_owned(),
        r#"        "___recordID"   REFERENCE QUERYABLE"#.to_owned(),
    ];
    lines.extend(
        encrypted
            .iter()
            .map(|(name, ty)| format!(r#"        "{name}" ENCRYPTED {ty}"#)),
    );
    lines.extend(
        plain
            .iter()
            .map(|(name, ty)| format!(r#"        "{name}" {ty}"#)),
    );
    lines.extend([
        r#"        GRANT WRITE TO "_creator""#.to_owned(),
        r#"        GRANT CREATE TO "_icloud""#.to_owned(),
        r#"        GRANT READ TO "_world""#.to_owned(),
    ]);
    format!(
        "    RECORD TYPE \"{prefix}\" (\n{}\n    );",
        lines.join(",\n")
    )
}

/// SQLite's affinity rules, narrowed to the three value kinds the codec sends.
fn cloudkit_type(declared: &str) -> &'static str {
    let declared = declared.to_ascii_uppercase();
    if declared.contains("INT") || declared.contains("BOOL") {
        "INT64"
    } else if declared.contains("REAL") || declared.contains("FLOA") || declared.contains("DOUB") {
        "DOUBLE"
    } else {
        "STRING"
    }
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
