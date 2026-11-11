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
fn serializes_network_kind() {
    let err = AppError::Network("connection refused".into());
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Network");
    assert_eq!(v["message"], "network: connection refused");
}

#[test]
fn from_serde_error() {
    let bad: Result<serde_json::Value, _> = serde_json::from_str("not json");
    let err: AppError = bad.unwrap_err().into();
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Serde");
}

#[derive(Debug)]
struct FakeSqlite(&'static str);

impl std::fmt::Display for FakeSqlite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sqlite error {}", self.0)
    }
}
impl std::error::Error for FakeSqlite {}

impl sqlx::error::DatabaseError for FakeSqlite {
    fn message(&self) -> &str {
        "sqlite error"
    }
    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        Some(self.0.into())
    }
    fn kind(&self) -> sqlx::error::ErrorKind {
        sqlx::error::ErrorKind::Other
    }
    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }
}

fn kind_of_code(code: &'static str) -> &'static str {
    AppError::from(sqlx::Error::Database(Box::new(FakeSqlite(code)))).kind()
}

#[test]
fn a_short_read_is_a_damaged_file() {
    assert_eq!(kind_of_code("522"), "Corrupt");
}

#[test]
fn a_full_disk_and_other_io_errors_stay_storage_errors() {
    assert_eq!(kind_of_code("13"), "Db", "SQLITE_FULL");
    assert_eq!(kind_of_code("778"), "Db", "SQLITE_IOERR_WRITE");
    assert_eq!(kind_of_code("10"), "Db", "SQLITE_IOERR");
}

async fn scratch_file(name: &str) -> (std::path::PathBuf, sqlx::SqlitePool) {
    let dir = std::env::temp_dir().join(format!("pkos_err_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    (dir, pool)
}

#[tokio::test]
async fn a_page_overwritten_on_disk_reads_as_a_damaged_file() {
    let (dir, pool) = scratch_file("w.sqlite").await;
    sqlx::query("CREATE TABLE t (x TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
         INSERT INTO t SELECT printf('%.200d', i) FROM n",
    )
    .execute(&pool)
    .await
    .unwrap();
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;

    let file = dir.join("w.sqlite");
    let mut bytes = std::fs::read(&file).unwrap();
    let page = page_size as usize * 6;
    bytes[page..page + page_size as usize].fill(0xFF);
    std::fs::write(&file, bytes).unwrap();

    let pool =
        sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&file))
            .await
            .unwrap();
    let read = sqlx::query_scalar::<_, i64>("SELECT sum(length(x)) FROM t")
        .fetch_one(&pool)
        .await;
    pool.close().await;

    let err = AppError::from(read.unwrap_err());
    assert_eq!(err.kind(), "Corrupt", "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_file_that_is_not_a_database_reads_as_a_damaged_file() {
    let (dir, pool) = scratch_file("w.sqlite").await;
    pool.close().await;
    let file = dir.join("w.sqlite");
    std::fs::write(&file, vec![0x5A; 8192]).unwrap();

    let reopened = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&file))
        .await;
    let err = match reopened {
        Err(e) => AppError::from(e),
        Ok(pool) => {
            let read = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sqlite_master")
                .fetch_one(&pool)
                .await;
            pool.close().await;
            AppError::from(read.unwrap_err())
        }
    };

    assert_eq!(err.kind(), "Corrupt", "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_constraint_violation_stays_a_storage_error() {
    let (dir, pool) = scratch_file("w.sqlite").await;
    sqlx::query("CREATE TABLE t (x TEXT PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO t VALUES ('a')")
        .execute(&pool)
        .await
        .unwrap();

    let dup = sqlx::query("INSERT INTO t VALUES ('a')")
        .execute(&pool)
        .await;
    pool.close().await;

    assert_eq!(AppError::from(dup.unwrap_err()).kind(), "Db");
    let _ = std::fs::remove_dir_all(&dir);
}
