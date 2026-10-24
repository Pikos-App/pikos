//! Filesystem watcher that live-refreshes the app when another process (the
//! CLI, or a second instance) writes to the workspace DB. Emits the
//! "workspace:external-change" event; the frontend ignores the echo of the
//! app's own writes (see shared/lib/externalChange.ts) and reloads otherwise.

use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

const EXTERNAL_CHANGE_EVENT: &str = "workspace:external-change";
const DEBOUNCE: Duration = Duration::from_millis(250);

/// The background sync loop writes through the same workspace file this watcher
/// observes — even a no-change poll stamps `sync_calendar.last_synced_at` — so
/// without a gate every poll would emit an external-change and reload the frontend.
/// The sync driver brackets each pass with [`suppress_begin`]/[`suppress_end`] (it
/// emits its own signal when a pass actually changed page data). A pass of any
/// length is covered for its full duration, plus a short trailing window for writes
/// flushing just after. Inside the bracket the change counter tells another
/// process's write from the pass's own, so a CLI write landing mid-pass still emits.
static SUPPRESS_DEPTH: AtomicU32 = AtomicU32::new(0);
/// Trailing debounce deadline armed by [`suppress_end`]; covers writes still
/// flushing just after the bracket closes.
static SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

/// Open the suppression bracket (pass start). Balanced by [`suppress_end`].
pub fn suppress_begin() {
    SUPPRESS_DEPTH.fetch_add(1, Ordering::Relaxed);
}

/// Close the bracket (pass end), arming a short trailing window first so no echo
/// leaks in the gap before the depth drops.
pub fn suppress_end(tail: Duration) {
    SUPPRESS_UNTIL_MS.store(now_ms() + tail.as_millis() as u64, Ordering::Relaxed);
    SUPPRESS_DEPTH.fetch_sub(1, Ordering::Relaxed);
}

/// Covers the watcher's debounce tail after a bracket's last write (the bracket itself is what
/// suppresses the writes inside it).
pub const TRAILING_COVER: Duration = Duration::from_secs(2);

/// The bracket around the app's own background checkpoints, which write the database file as
/// any commit does.
pub const OWN_CHECKPOINTS: pikos_db::CheckpointHooks = pikos_db::CheckpointHooks {
    before: suppress_begin,
    after: end_own_checkpoint,
};

fn end_own_checkpoint() {
    suppress_end(TRAILING_COVER);
}

fn suppressed() -> bool {
    SUPPRESS_DEPTH.load(Ordering::Relaxed) > 0
        || now_ms() < SUPPRESS_UNTIL_MS.load(Ordering::Relaxed)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Another process's changes as the change counter last showed them.
#[derive(PartialEq)]
struct OutsideChanges {
    epoch: String,
    count: i64,
}

impl OutsideChanges {
    /// None when the counter can't be read, which [`moved_since`] counts as a change: a
    /// spurious reload beats a missed one.
    fn read(pool: &SqlitePool) -> Option<Self> {
        let state = tauri::async_runtime::block_on(pikos_db::changes::change_state(pool)).ok()?;
        Some(Self {
            epoch: state.epoch,
            count: state.seq - state.own_changes,
        })
    }
}

fn moved_since(seen: &mut Option<OutsideChanges>, pool: &SqlitePool) -> bool {
    let now = OutsideChanges::read(pool);
    let moved = now.is_none() || *seen != now;
    *seen = now;
    moved
}

/// Spawn a background watcher on the workspace file's directory. Best-effort:
/// any setup failure is logged and the app simply runs without live-refresh.
pub fn start(app: AppHandle, db_path: String, pool: SqlitePool) {
    std::thread::spawn(move || {
        let watched = watch(&db_path, &pool, || {
            let _ = app.emit(EXTERNAL_CHANGE_EVENT, ());
        });
        if let Err(e) = watched {
            log::warn!("db watcher disabled: {e}");
        }
    });
}

fn watch(db_path: &str, pool: &SqlitePool, mut emit: impl FnMut()) -> notify::Result<()> {
    let path = Path::new(db_path);
    let dir = match path.parent() {
        Some(d) => d.to_path_buf(),
        None => return Ok(()),
    };
    // Base filename (e.g. "default.sqlite"); the -wal/-shm siblings share this
    // prefix and are what actually change on each commit under WAL.
    let prefix = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let (tx, rx) = channel::<notify::Result<Event>>();
    // The watcher must stay alive for the lifetime of this loop.
    let mut watcher = RecommendedWatcher::new(tx, Config::default())?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;

    let mut seen = OutsideChanges::read(pool);
    pump(&rx, &prefix, DEBOUNCE, || {
        let outside_wrote = moved_since(&mut seen, pool);
        if suppressed() && !outside_wrote {
            return;
        }

        emit();
    });
    Ok(())
}

/// Event-classification + debounce pump. Extracted so tests can drive it with
/// a real notify watcher (or synthetic events) and an arbitrary emit closure,
/// without needing a Tauri AppHandle.
fn pump<F: FnMut()>(
    rx: &Receiver<notify::Result<Event>>,
    prefix: &str,
    debounce: Duration,
    mut emit: F,
) {
    loop {
        match rx.recv() {
            Ok(Ok(event)) => {
                if !is_relevant(&event, prefix) {
                    continue;
                }
                // Coalesce the burst of events a single commit produces into one emit.
                loop {
                    match rx.recv_timeout(debounce) {
                        Ok(_) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                emit();
            }
            Ok(Err(_)) => continue,
            Err(_) => return, // sender dropped — watcher gone
        }
    }
}

fn is_relevant(event: &Event, prefix: &str) -> bool {
    if !matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|p| {
        p.file_name()
            .map(|n| n.to_string_lossy().starts_with(prefix))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn tempdir_for(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("pikos-watch-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn synthetic(kind: EventKind, paths: Vec<PathBuf>) -> notify::Result<Event> {
        Ok(Event {
            kind,
            paths,
            attrs: Default::default(),
        })
    }

    /// Drive the pump on a worker thread; return the join handle + a count of
    /// emits via the supplied Arc<Mutex<u32>>.
    fn spawn_pump(
        rx: Receiver<notify::Result<Event>>,
        prefix: String,
        debounce: Duration,
    ) -> (thread::JoinHandle<()>, Arc<Mutex<u32>>) {
        let count = Arc::new(Mutex::new(0u32));
        let c = count.clone();
        let h = thread::spawn(move || {
            pump(&rx, &prefix, debounce, || {
                *c.lock().unwrap() += 1;
            });
        });
        (h, count)
    }

    fn drain(tx: Sender<notify::Result<Event>>) {
        drop(tx);
    }

    #[tokio::test]
    async fn the_apps_own_background_checkpoint_is_not_an_outside_change() {
        let dir = tempdir_for("checkpoint");
        let path = dir.join("workspace.sqlite");
        let pool = crate::db::open_pool(path.to_str().unwrap()).await.unwrap();
        sqlx::query("CREATE TABLE notes (body TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        for _ in 0..200 {
            sqlx::query("INSERT INTO notes VALUES (randomblob(1000))")
                .execute(&pool)
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(500)).await;

        let outside = watch_counting(&path, &pool);

        let crate::db::Checkpoints::Background(hooks) = crate::db::APP_CHECKPOINTS else {
            panic!("the app checkpoints in the background");
        };
        pikos_db::checkpoint_once(&pool, hooks).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;

        assert_eq!(*outside.lock().unwrap(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Serialises the tests that open and close the suppression bracket, which is process-wide.
    static BRACKET: Mutex<()> = Mutex::new(());

    const OUTSIDE_WRITER_DB: &str = "PIKOS_WATCH_OUTSIDE_WRITER_DB";
    const OUTSIDE_TITLE: &str = "Added from the CLI";

    /// The other process: opens the workspace and adds a page the way the CLI does. Run by
    /// [`write_from_another_process`], so it has a writer identity of its own.
    #[test]
    #[ignore = "run as a separate process by the outside-writer tests"]
    fn outside_writer_process() {
        let Ok(path) = std::env::var(OUTSIDE_WRITER_DB) else {
            return;
        };

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let pool = pikos_db::open_pool(&path).await.unwrap();
            pikos_db::create_page_impl(&pool, new_page(OUTSIDE_TITLE))
                .await
                .unwrap();
            pool.close().await;
        });
    }

    fn new_page(title: &str) -> pikos_db::NewPage {
        pikos_db::NewPage {
            id: None,
            folder_id: None,
            title: title.into(),
            subtitle: None,
            content: "{}".into(),
            status: "not_started".into(),
            priority: 0,
            tags: vec![],
            scheduled_start: None,
            scheduled_end: None,
            completed_at: None,
            parent_id: None,
            last_opened_at: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn write_from_another_process(rt: &tokio::runtime::Runtime, db: &Path, pool: &SqlitePool) {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::watch::tests::outside_writer_process",
                "--ignored",
                "--quiet",
            ])
            .env(OUTSIDE_WRITER_DB, db)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        let added: i64 = rt
            .block_on(
                sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE title = ?")
                    .bind(OUTSIDE_TITLE)
                    .fetch_one(pool),
            )
            .unwrap();
        assert_eq!(added, 1, "the other process wrote its page");
    }

    fn watch_counting(db: &Path, pool: &SqlitePool) -> Arc<Mutex<u32>> {
        let count = Arc::new(Mutex::new(0u32));
        let counted = count.clone();
        let db = db.to_str().unwrap().to_owned();
        let pool = pool.clone();
        thread::spawn(move || {
            watch(&db, &pool, || *counted.lock().unwrap() += 1).unwrap();
        });
        thread::sleep(Duration::from_millis(200));
        count
    }

    fn wait_for_emit(count: &Mutex<u32>) -> u32 {
        for _ in 0..50 {
            let emitted = *count.lock().unwrap();
            if emitted > 0 {
                return emitted;
            }

            thread::sleep(Duration::from_millis(100));
        }

        0
    }

    fn open_settled_workspace(name: &str) -> (tokio::runtime::Runtime, PathBuf, SqlitePool) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let path = tempdir_for(name).join("workspace.sqlite");
        let pool = rt
            .block_on(crate::db::open_pool(path.to_str().unwrap()))
            .unwrap();
        thread::sleep(Duration::from_millis(500));
        (rt, path, pool)
    }

    #[test]
    fn a_page_another_process_adds_reaches_the_app() {
        let _bracket = BRACKET.lock().unwrap_or_else(|e| e.into_inner());
        let (rt, path, pool) = open_settled_workspace("outside");
        let emitted = watch_counting(&path, &pool);

        write_from_another_process(&rt, &path, &pool);

        assert!(wait_for_emit(&emitted) >= 1);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    // qa: CLI-18
    #[test]
    fn a_page_another_process_adds_during_a_sync_pass_reaches_the_app() {
        let _bracket = BRACKET.lock().unwrap_or_else(|e| e.into_inner());
        let (rt, path, pool) = open_settled_workspace("mid-pass");
        let emitted = watch_counting(&path, &pool);

        suppress_begin();
        rt.block_on(pikos_db::create_page_impl(
            &pool,
            new_page("Added by the pass"),
        ))
        .unwrap();
        thread::sleep(Duration::from_millis(1000));
        let from_the_pass = *emitted.lock().unwrap();

        write_from_another_process(&rt, &path, &pool);
        let with_the_outside_write = wait_for_emit(&emitted);
        suppress_end(Duration::ZERO);

        assert_eq!(from_the_pass, 0, "the pass's own writes stay quiet");
        assert!(with_the_outside_write >= 1);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn is_relevant_matches_db_file_and_wal_sibling() {
        let dir = tempdir_for("rel");
        let db = dir.join("default.sqlite");
        let wal = dir.join("default.sqlite-wal");
        let other = dir.join("workspaces.json");

        assert!(is_relevant(
            &Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![db.clone()],
                attrs: Default::default(),
            },
            "default.sqlite",
        ));
        assert!(is_relevant(
            &Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![wal.clone()],
                attrs: Default::default(),
            },
            "default.sqlite",
        ));
        assert!(!is_relevant(
            &Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![other.clone()],
                attrs: Default::default(),
            },
            "default.sqlite",
        ));
    }

    #[test]
    fn is_relevant_ignores_access_only_kinds() {
        let dir = tempdir_for("kind");
        let db = dir.join("default.sqlite");
        assert!(!is_relevant(
            &Event {
                kind: EventKind::Access(notify::event::AccessKind::Read),
                paths: vec![db],
                attrs: Default::default(),
            },
            "default.sqlite",
        ));
    }

    #[test]
    fn pump_debounces_burst_into_single_emit() {
        let (tx, rx) = channel::<notify::Result<Event>>();
        let (h, count) = spawn_pump(rx, "default.sqlite".into(), Duration::from_millis(50));

        let db = PathBuf::from("/tmp/whatever/default.sqlite");
        // Burst of 5 modify events on the db file.
        for _ in 0..5 {
            tx.send(synthetic(
                EventKind::Modify(notify::event::ModifyKind::Any),
                vec![db.clone()],
            ))
            .unwrap();
        }
        // Wait past the debounce window so the pump emits.
        thread::sleep(Duration::from_millis(200));
        drain(tx);
        h.join().unwrap();

        assert_eq!(
            *count.lock().unwrap(),
            1,
            "burst should coalesce to one emit"
        );
    }

    #[test]
    fn pump_ignores_non_db_paths() {
        let (tx, rx) = channel::<notify::Result<Event>>();
        let (h, count) = spawn_pump(rx, "default.sqlite".into(), Duration::from_millis(50));

        let unrelated = PathBuf::from("/tmp/whatever/workspaces.json");
        tx.send(synthetic(
            EventKind::Modify(notify::event::ModifyKind::Any),
            vec![unrelated],
        ))
        .unwrap();
        thread::sleep(Duration::from_millis(200));
        drain(tx);
        h.join().unwrap();

        assert_eq!(*count.lock().unwrap(), 0);
    }

    /// End-to-end against a real notify watcher: write to the workspace file
    /// and confirm an emit happens; touch an unrelated file and confirm no
    /// extra emit. This is the closest auto-verifiable proxy for the GUI
    /// live-refresh smoke test (which requires a Tauri AppHandle).
    #[test]
    fn real_notify_watcher_fires_on_db_writes_only() {
        let dir = tempdir_for("e2e");
        let db = dir.join("default.sqlite");
        let other = dir.join("readme.txt");
        // Seed both files.
        fs::write(&db, b"seed").unwrap();
        fs::write(&other, b"seed").unwrap();

        let (tx, rx) = channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(tx, Config::default()).expect("create watcher");
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .expect("watch dir");

        let (h, count) = spawn_pump(rx, "default.sqlite".into(), Duration::from_millis(150));

        // Let the watcher settle, then touch the db file.
        thread::sleep(Duration::from_millis(50));
        fs::write(&db, b"changed").unwrap();
        thread::sleep(Duration::from_millis(400));
        let after_db = *count.lock().unwrap();
        assert!(
            after_db >= 1,
            "expected at least one emit after touching the db file (got {after_db})",
        );

        // Touch unrelated file; emit count must not move.
        fs::write(&other, b"changed").unwrap();
        thread::sleep(Duration::from_millis(400));
        let after_other = *count.lock().unwrap();
        assert_eq!(
            after_other, after_db,
            "unrelated file touch should not produce an emit",
        );

        drop(watcher);
        h.join().unwrap();
    }

    /// Mirrors production's `suppressed()` gate in the emit closure; see
    /// `SUPPRESS_DEPTH` for the suppression contract.
    #[test]
    fn bracketed_pass_suppresses_regardless_of_duration_then_releases() {
        let _bracket = BRACKET.lock().unwrap_or_else(|e| e.into_inner());
        SUPPRESS_DEPTH.store(0, Ordering::Relaxed);
        SUPPRESS_UNTIL_MS.store(0, Ordering::Relaxed);

        let (tx, rx) = channel::<notify::Result<Event>>();
        let count = Arc::new(Mutex::new(0u32));
        let c = count.clone();
        let h = thread::spawn(move || {
            pump(&rx, "default.sqlite", Duration::from_millis(50), || {
                if suppressed() {
                    return;
                }
                *c.lock().unwrap() += 1;
            });
        });
        let db = PathBuf::from("/tmp/whatever/default.sqlite");

        // Inside the bracket with zero time-based cover, depth alone suppresses —
        // pass length is irrelevant.
        suppress_begin();
        tx.send(synthetic(
            EventKind::Modify(notify::event::ModifyKind::Any),
            vec![db.clone()],
        ))
        .unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            *count.lock().unwrap(),
            0,
            "write inside the bracket is suppressed"
        );

        suppress_end(Duration::from_millis(40));
        thread::sleep(Duration::from_millis(100));
        tx.send(synthetic(
            EventKind::Modify(notify::event::ModifyKind::Any),
            vec![db.clone()],
        ))
        .unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            *count.lock().unwrap(),
            1,
            "post-release external write reloads"
        );

        drain(tx);
        h.join().unwrap();
    }
}
