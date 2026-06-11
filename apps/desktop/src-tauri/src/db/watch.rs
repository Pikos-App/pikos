//! Filesystem watcher that live-refreshes the app when another process (the
//! CLI, or a second instance) writes to the workspace DB. Emits the
//! "workspace:external-change" event; the frontend ignores the echo of the
//! app's own writes (see shared/lib/externalChange.ts) and reloads otherwise.

use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const EXTERNAL_CHANGE_EVENT: &str = "workspace:external-change";
const DEBOUNCE: Duration = Duration::from_millis(250);

/// Spawn a background watcher on the workspace file's directory. Best-effort:
/// any setup failure is logged and the app simply runs without live-refresh.
pub fn start(app: AppHandle, db_path: String) {
    std::thread::spawn(move || {
        if let Err(e) = run(app, &db_path) {
            log::warn!("db watcher disabled: {e}");
        }
    });
}

fn run(app: AppHandle, db_path: &str) -> notify::Result<()> {
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

    pump(&rx, &prefix, DEBOUNCE, || {
        let _ = app.emit(EXTERNAL_CHANGE_EVENT, ());
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
}
