use super::{cloudkit_schema, SCHEMA_FILE};
use crate::test_pool;

#[tokio::test]
async fn the_checked_in_cloudkit_schema_is_what_the_manifest_generates() {
    let pool = test_pool().await;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SCHEMA_FILE);
    let generated = cloudkit_schema(&pool).await.unwrap();

    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &generated).unwrap();
    }

    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == generated,
        "{SCHEMA_FILE} is stale; regenerate with UPDATE_GOLDEN=1 cargo test -p pikos-db replica"
    );
}
