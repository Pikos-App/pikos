//! Several devices make random edits through the real writers and sync in random order through a
//! stand-in store; once everything has been delivered, every device holds the same synced state.
//!
//! Two stores, the two shapes a transport takes. The CloudKit stand-in keeps one copy of each record
//! and, like CloudKit refusing a save over a newer server copy, merges what it's sent into what it
//! has; each device fetches what changed since its last fetch. The shared-folder stand-in merges
//! nothing: each device appends to its own log, and the others read every log, seeing new entries
//! only after a listing delay, as a synced folder does. A third run is closer to CloudKit itself:
//! devices start alone, each in a zone of its own, and settle into one through `join` as they
//! relaunch; a save over a newer copy is refused and sent again; and a fetch that fails to apply
//! leaves the saved state behind it. Every device reads one clock the run moves forward by zero to two milliseconds a
//! step, so writes on different devices often share a millisecond and a seed replays exactly. A
//! failure prints its seed; `PIKOS_CONVERGENCE_SEED=<n>` replays one, `PIKOS_CONVERGENCE_SEEDS=<n>`
//! runs more, and `PIKOS_CONVERGENCE_FROM=<n>` starts them somewhere other than 1, as the nightly
//! soak does.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use pikos_replica::codec::{self, FieldMap};
use pikos_replica::merge;
use pikos_replica::RecordName;
use sqlx::SqlitePool;

use super::apply::{apply, shape};
use super::build::{build, pending, save_system_fields, sent};
use super::manifest::entity as entity_map;
use super::{start, state};
use crate::sql_functions::Clock;
use crate::*;

/// xorshift64*: small, seedable, and enough to pick operations.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        (!items.is_empty()).then(|| &items[self.below(items.len())])
    }
}

#[derive(Default)]
struct Cloud {
    records: BTreeMap<String, (RecordName, FieldMap, u64)>,
    seq: u64,
}

impl Cloud {
    fn save(&mut self, name: RecordName, fields: FieldMap) {
        // An image never changes, so the first copy stands.
        let Some(entity) = entity_map(name.entity) else {
            if !self.records.contains_key(&name.to_string()) {
                self.seq += 1;
                self.records
                    .insert(name.to_string(), (name, fields, self.seq));
            }
            return;
        };
        let shape = shape(entity);
        let stored = match self.records.get(&name.to_string()) {
            Some((_, current, _)) => {
                let ours = codec::decode(name.clone(), current, &shape).expect("stored record");
                let theirs = codec::decode(name.clone(), &fields, &shape).expect("sent record");
                let merged = merge::merge(Some(&ours.row), &theirs.row);
                let record = codec::Record {
                    name: name.clone(),
                    row: merged.row,
                };
                codec::encode(&record, &shape)
            }
            None => fields,
        };
        self.seq += 1;
        self.records
            .insert(name.to_string(), (name, stored, self.seq));
    }

    fn everything(&self) -> Vec<(RecordName, FieldMap)> {
        self.records
            .values()
            .map(|(name, fields, _)| (name.clone(), fields.clone()))
            .collect()
    }

    /// What changed since `cursor`, in an order shuffled by `rng`: CloudKit promises none.
    fn changed_since(&self, cursor: u64, rng: &mut Rng) -> (Vec<(RecordName, FieldMap)>, u64) {
        let mut changed: Vec<_> = self
            .records
            .values()
            .filter(|(_, _, seq)| *seq > cursor)
            .collect();
        changed.sort_by_key(|(_, _, seq)| *seq);
        for i in (1..changed.len()).rev() {
            changed.swap(i, rng.below(i + 1));
        }
        let changed = changed
            .into_iter()
            .map(|(name, fields, _)| (name.clone(), fields.clone()))
            .collect();
        (changed, self.seq)
    }
}

/// A folder each device appends its own log to, which nothing on the far side merges or tracks.
#[derive(Default)]
struct Folder {
    /// Each writer's entries, oldest first, with the step from which a listing shows them.
    logs: BTreeMap<usize, Vec<(u64, RecordName, FieldMap)>>,
    step: u64,
}

impl Folder {
    fn append(&mut self, writer: usize, name: RecordName, fields: FieldMap, rng: &mut Rng) {
        let visible_from = self.step + rng.below(4) as u64;
        self.logs
            .entry(writer)
            .or_default()
            .push((visible_from, name, fields));
    }

    /// Entries from the other devices' logs past `cursors`. A log is read in order and stops at the
    /// first entry a listing doesn't show yet.
    fn read(
        &self,
        reader: usize,
        cursors: &mut BTreeMap<usize, u64>,
    ) -> Vec<(RecordName, FieldMap)> {
        let mut read = Vec::new();
        for (writer, log) in &self.logs {
            if *writer == reader {
                continue;
            }
            let cursor = cursors.entry(*writer).or_default();
            for (visible_from, name, fields) in log.iter().skip(*cursor as usize) {
                if *visible_from > self.step {
                    break;
                }
                read.push((name.clone(), fields.clone()));
                *cursor += 1;
            }
        }
        read
    }
}

enum Store {
    Cloud(Cloud),
    Folder(Folder),
}

impl Store {
    fn tick(&mut self, by: u64) {
        if let Store::Folder(folder) = self {
            folder.step += by;
        }
    }

    /// Every record ever delivered: the CloudKit stand-in's current copies, or every log entry,
    /// old versions included.
    fn everything(&self) -> Vec<(RecordName, FieldMap)> {
        match self {
            Store::Cloud(cloud) => cloud.everything(),
            Store::Folder(folder) => folder
                .logs
                .values()
                .flatten()
                .map(|(_, name, fields)| (name.clone(), fields.clone()))
                .collect(),
        }
    }
}

struct Device {
    pool: SqlitePool,
    /// How far this device has read: the CloudKit stand-in's change sequence, or each other
    /// device's log.
    cursors: BTreeMap<usize, u64>,
    index: usize,
}

fn tracing() -> bool {
    std::env::var("PIKOS_CONVERGENCE_TRACE").is_ok()
}

fn trace_records<'a>(
    label: &str,
    device: usize,
    records: impl Iterator<Item = (&'a RecordName, &'a FieldMap)>,
) {
    if !tracing() {
        return;
    }
    for (name, fields) in records {
        eprintln!("  d{device} {label} {name} {fields:?}");
    }
}

impl Device {
    async fn upload(&mut self, store: &mut Store, rng: &mut Rng) {
        let names = pending(&self.pool, 100_000).await.unwrap();
        let built = build(&self.pool, &names).await.unwrap();
        trace_records(
            "sends",
            self.index,
            built.iter().map(|b| (&b.name, &b.fields)),
        );
        let mut acked = Vec::new();
        for record in built {
            // A send can fail part-way; what wasn't acknowledged stays pending.
            if rng.chance(85) {
                match store {
                    Store::Cloud(cloud) => cloud.save(record.name.clone(), record.fields),
                    Store::Folder(folder) => {
                        folder.append(self.index, record.name.clone(), record.fields, rng)
                    }
                }
                acked.push((record.name, record.clock));
            }
        }
        sent(&self.pool, &acked).await.unwrap();
    }

    async fn fetch(&mut self, store: &Store, rng: &mut Rng) {
        let changed = match store {
            Store::Cloud(cloud) => {
                let cursor = self.cursors.entry(usize::MAX).or_default();
                let (changed, seq) = cloud.changed_since(*cursor, rng);
                *cursor = seq;
                changed
            }
            Store::Folder(folder) => folder.read(self.index, &mut self.cursors),
        };
        trace_records("gets", self.index, changed.iter().map(|(n, f)| (n, f)));
        let applied = apply(&self.pool, &changed).await.unwrap();
        if tracing() {
            let pages = ids(&self.pool, "SELECT id FROM pages ORDER BY rowid").await;
            let reminders = ids(
                &self.pool,
                "SELECT id || '>' || page_id FROM page_reminders",
            )
            .await;
            let held = ids(&self.pool, "SELECT name || ' ' || reason FROM replica_pen").await;
            eprintln!(
                "  d{} applied {applied:?}\n    pages {pages:?}\n    reminders {reminders:?}\n    held {held:?}",
                self.index
            );
        }
    }
}

async fn images_folder(pool: &SqlitePool) -> Option<std::path::PathBuf> {
    let dir: Option<String> =
        sqlx::query_scalar("SELECT assets_dir FROM replica_meta WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap();
    dir.map(Into::into)
}

/// A name in the form Pikos gives an image, from the seed so a failure replays.
fn image_name(rng: &mut Rng) -> String {
    let hex = format!("{:016x}{:016x}", rng.next(), rng.next());
    format!(
        "{}-{}-4{}-8{}-{}.png",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

async fn give_images_folder(pool: &SqlitePool) {
    let dir = std::env::temp_dir().join(format!("pkos_converge_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    super::images::set_assets_dir(pool, &dir).await.unwrap();
}

/// Images a device's pages show that aren't in its folder.
async fn missing_images(pool: &SqlitePool) -> Vec<String> {
    let dir = images_folder(pool).await.unwrap();
    crate::assets::asset_paths_in(pool)
        .await
        .unwrap()
        .iter()
        .filter_map(|path| crate::assets::pikos_file_name(path))
        .filter(|name| !dir.join(name).is_file())
        .map(str::to_owned)
        .collect()
}

fn page(title: String) -> NewPage {
    NewPage {
        id: None,
        folder_id: None,
        title,
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

async fn ids(pool: &SqlitePool, sql: &str) -> Vec<String> {
    sqlx::query_scalar(sql).fetch_all(pool).await.unwrap()
}

const TAGS: [&str; 4] = ["errands", "home", "work", "later"];

/// One random edit through a real writer. Writers refuse plenty of what's picked, like restoring a
/// page that isn't trashed; a refusal is an ordinary outcome here.
async fn random_edit(pool: &SqlitePool, rng: &mut Rng, n: usize) {
    let pages = ids(
        pool,
        "SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY rowid",
    )
    .await;
    let trashed = ids(
        pool,
        "SELECT id FROM pages WHERE deleted_at IS NOT NULL ORDER BY rowid",
    )
    .await;
    let folders = ids(
        pool,
        "SELECT id FROM folders WHERE deleted_at IS NULL ORDER BY rowid",
    )
    .await;
    let page_id = rng.pick(&pages).cloned();
    let tags: Vec<String> = TAGS
        .iter()
        .filter(|_| rng.chance(30))
        .map(|t| t.to_string())
        .collect();

    let choice = rng.below(21);
    if tracing() {
        eprintln!("  edit {choice} on {page_id:?}");
    }
    let _ = match (choice, page_id) {
        (0 | 1, _) | (_, None) => create_page_impl(
            pool,
            NewPage {
                folder_id: rng.pick(&folders).cloned(),
                tags,
                ..page(format!("page {n}"))
            },
        )
        .await
        .map(drop),
        (2, Some(id)) => update_page_impl(
            pool,
            id,
            PageUpdate {
                title: Some(format!("title {n}")),
                ..Default::default()
            },
        )
        .await
        .map(drop),
        (3, Some(id)) => {
            let image = match images_folder(pool).await {
                Some(dir) if rng.chance(30) => {
                    let name = image_name(rng);
                    std::fs::write(dir.join(&name), format!("image {n}")).unwrap();
                    format!(r#",{{"type":"image","attrs":{{"src":"assets/{name}"}}}}"#)
                }
                _ => String::new(),
            };
            update_page_impl(
                pool,
                id,
                PageUpdate {
                    content: Some(format!(
                        r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"body {n}"}}]}}{image}]}}"#
                    )),
                    ..Default::default()
                },
            )
            .await
            .map(drop)
        }
        (4, Some(id)) => {
            let status = if rng.chance(50) {
                "done"
            } else {
                "not_started"
            };
            set_pages_status_impl(pool, &[id], status, None)
                .await
                .map(drop)
        }
        (5, Some(id)) => update_page_impl(
            pool,
            id,
            PageUpdate {
                tags: Some(tags),
                ..Default::default()
            },
        )
        .await
        .map(drop),
        (6, Some(id)) => update_page_impl(
            pool,
            id,
            PageUpdate {
                folder_id: Some(match rng.pick(&folders) {
                    Some(f) => serde_json::json!(f),
                    None => serde_json::Value::Null,
                }),
                ..Default::default()
            },
        )
        .await
        .map(drop),
        (7, Some(id)) => soft_delete_page_impl(pool, &id).await,
        (8, _) => match rng.pick(&trashed) {
            Some(id) => restore_page_impl(pool, id).await,
            None => Ok(()),
        },
        (9, Some(id)) => hard_delete_page_impl(pool, &id).await,
        (10, _) => create_folder_impl(
            pool,
            NewFolder {
                name: format!("folder {n}"),
                parent_id: None,
                color: None,
                icon: None,
            },
        )
        .await
        .map(drop),
        (11, _) => {
            let folder = rng.pick(&folders).cloned();
            let trash = rng.chance(50);
            if tracing() {
                eprintln!("  folder {folder:?} trash={trash}");
            }
            match folder {
                Some(f) if trash => soft_delete_folder_impl(pool, f).await,
                Some(f) => delete_folder_impl(pool, f).await,
                None => Ok(()),
            }
        }
        (12, Some(id)) => create_page_reminder(pool, &id, 10).await.map(drop),
        (13, Some(id)) => create_page_schedule_impl(
            pool,
            NewPageSchedule {
                page_id: id,
                scheduled_start: format!("2030-01-{:02}T09:00:00", 1 + rng.below(28)),
                scheduled_end: None,
                timezone: Some("UTC".into()),
                rule_id: None,
                original_date: None,
            },
        )
        .await
        .map(drop),
        (14, Some(id)) => create_focus_session(
            pool,
            &id,
            "2026-10-16T09:00:00",
            "2026-10-16T09:25:00",
            1500,
        )
        .await
        .map(drop),
        (16, Some(id)) => create_recurrence_rule_impl(
            pool,
            NewRecurrenceRule {
                page_id: id,
                rrule: if rng.chance(50) {
                    "FREQ=DAILY"
                } else {
                    "FREQ=WEEKLY"
                }
                .into(),
                rrule_exdates: vec![],
                scheduled_start: "2030-01-01T09:00:00".into(),
                scheduled_end: Some("2030-01-01T09:30:00".into()),
                timezone: "UTC".into(),
            },
        )
        .await
        .map(drop),
        (17, _) => match rng.pick(
            &ids(
                pool,
                "SELECT page_id FROM page_recurrence_rules ORDER BY rowid",
            )
            .await,
        ) {
            Some(page) => complete_recurring_page_impl(
                pool,
                CompleteRecurringInput {
                    page_id: page.clone(),
                    occurrence_date: None,
                    scheduled_start: None,
                    scheduled_end: None,
                    expected_occurrence_date: None,
                },
            )
            .await
            .map(drop),
            None => Ok(()),
        },
        (18, _) => match rng
            .pick(&ids(pool, "SELECT id FROM page_recurrence_rules ORDER BY rowid").await)
        {
            Some(rule) => reschedule_virtual_occurrence_impl(
                pool,
                RescheduleVirtualInput {
                    rule_id: rule.clone(),
                    original_date: format!("2030-01-{:02}", 2 + rng.below(20)),
                    scheduled_start: format!("2030-01-{:02}T11:00:00", 2 + rng.below(20)),
                    scheduled_end: None,
                    timezone: "UTC".into(),
                },
            )
            .await
            .map(drop),
            None => Ok(()),
        },
        (19, _) => match rng
            .pick(&ids(pool, "SELECT id FROM page_recurrence_rules ORDER BY rowid").await)
        {
            Some(rule) => delete_recurrence_rule_impl(pool, rule).await,
            None => Ok(()),
        },
        (20, _) => {
            let ticked: Vec<(String, String)> =
                sqlx::query_as("SELECT page_id, occurrence_date FROM completed_set ORDER BY rowid")
                    .fetch_all(pool)
                    .await
                    .unwrap();
            match rng.pick(&ticked) {
                Some((page, date)) => {
                    uncomplete_recurring_occurrence_impl(
                        pool,
                        UncompleteRecurringInput {
                            page_id: page.clone(),
                            occurrence_date: date.clone(),
                        },
                    )
                    .await
                }
                None => Ok(()),
            }
        }
        (_, Some(id)) => {
            let removed = ids(pool, "SELECT id FROM page_reminders ORDER BY rowid").await;
            match rng.pick(&removed) {
                Some(r) => delete_page_reminder(pool, r).await,
                None => {
                    skip_occurrence_impl(
                        pool,
                        SkipOccurrenceInput {
                            page_id: id,
                            occurrence_date: "2030-01-01".into(),
                        },
                    )
                    .await
                }
            }
        }
    };
}

/// A synced row's values, each field's columns quoted.
type Fields = Vec<Vec<String>>;

async fn synced(pool: &SqlitePool) -> BTreeMap<String, Fields> {
    state::synced_rows(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.name.to_string(), row.fields))
        .collect()
}

/// Derived columns that must match what their owners would compute from the synced ones.
async fn derived_mismatches(pool: &SqlitePool) -> Vec<String> {
    ids(
        pool,
        "SELECT id FROM pages
         WHERE (SELECT group_concat(value, ',') FROM (
                  SELECT value FROM json_each(pages.tags) ORDER BY value))
           IS NOT (SELECT group_concat(name, ',') FROM (
                  SELECT tags.name FROM page_tags JOIN tags ON tags.id = page_tags.tag_id
                  WHERE page_tags.page_id = pages.id ORDER BY tags.name))",
    )
    .await
}

/// Pages whose search entry doesn't match the page, from the index's own check against its table.
async fn search_is_stale(pool: &SqlitePool) -> bool {
    sqlx::query("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)")
        .execute(pool)
        .await
        .is_err()
}

async fn broken_foreign_keys(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_as::<_, (String, i64, String)>("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(table, rowid, parent)| format!("{table} row {rowid} -> {parent}"))
        .collect()
}

/// Pages whose cached schedule differs from what the schedule code works out now. Rebuilt in a
/// transaction that's rolled back.
async fn stale_schedules(pool: &SqlitePool) -> Vec<String> {
    const CACHED: &str = "SELECT id, scheduled_start, scheduled_end FROM pages ORDER BY id";
    type Cached = (String, Option<String>, Option<String>);
    let mut tx = pool.begin().await.unwrap();
    let before: Vec<Cached> = sqlx::query_as(CACHED).fetch_all(&mut *tx).await.unwrap();
    for (page, _, _) in &before {
        crate::schedules::refresh_schedule_denorm_conn(&mut tx, page)
            .await
            .unwrap();
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, page)
            .await
            .unwrap();
    }
    let after: Vec<Cached> = sqlx::query_as(CACHED).fetch_all(&mut *tx).await.unwrap();
    tx.rollback().await.unwrap();

    before
        .into_iter()
        .zip(after)
        .filter(|(was, rebuilt)| was != rebuilt)
        .map(|(was, rebuilt)| format!("{was:?} rebuilt as {rebuilt:?}"))
        .collect()
}

async fn run(mut store: Store, seed: u64, devices: usize, steps: usize) {
    // Shown only when the test fails, so a panic deep in a run still names its seed.
    eprintln!("seed {seed}");
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let world: &'static AtomicU64 = Box::leak(Box::new(AtomicU64::new(1_800_000_000_000)));
    let mut fleet = Vec::new();
    for _ in 0..devices {
        let pool = test_pool_on(Clock::Manual(world)).await;
        give_images_folder(&pool).await;
        // Some devices have work from before sync was turned on, sent in their first upload.
        for n in 0..rng.below(3) {
            random_edit(&pool, &mut rng, 10_000 + n).await;
        }
        start(&pool).await.unwrap();
        let index = fleet.len();
        fleet.push(Device {
            pool,
            cursors: BTreeMap::new(),
            index,
        });
    }

    for n in 0..steps {
        world.fetch_add(rng.below(3) as u64, Ordering::SeqCst);
        store.tick(1);
        let d = rng.below(devices);
        if tracing() {
            eprintln!("step {n} d{d} at {}", world.load(Ordering::SeqCst));
        }
        match rng.below(10) {
            0..=5 => random_edit(&fleet[d].pool, &mut rng, n).await,
            6 | 7 => fleet[d].upload(&mut store, &mut rng).await,
            _ => fleet[d].fetch(&store, &mut rng).await,
        }
    }

    // Quiet: everyone sends everything and fetches everything until nothing is left to send.
    for _ in 0..8 {
        for device in &mut fleet {
            let mut sure = Rng(1);
            for attempt in 0.. {
                if pending(&device.pool, 1).await.unwrap().is_empty() {
                    break;
                }
                assert!(attempt < 50, "seed {seed}: a record never leaves the queue");
                device.upload(&mut store, &mut sure).await;
            }
        }
        store.tick(10);
        for device in &mut fleet {
            device.fetch(&store, &mut rng).await;
        }
    }

    let first = synced(&fleet[0].pool).await;
    for (i, device) in fleet.iter().enumerate().skip(1) {
        let other = synced(&device.pool).await;
        let differing: BTreeMap<&String, (Option<&Fields>, Option<&Fields>)> = first
            .keys()
            .chain(other.keys())
            .filter(|k| first.get(*k) != other.get(*k))
            .map(|k| (k, (first.get(k), other.get(k))))
            .collect();
        assert!(
            differing.is_empty(),
            "seed {seed}: device {i} differs from device 0, as (device 0, device {i}): {differing:#?}"
        );
    }
    let delivered = store.everything();
    for (i, device) in fleet.iter().enumerate() {
        let stale = derived_mismatches(&device.pool).await;
        assert!(
            stale.is_empty(),
            "seed {seed}: stale tag caches on {stale:?}"
        );
        assert!(
            !search_is_stale(&device.pool).await,
            "seed {seed}: device {i}'s search index doesn't match its pages"
        );
        let broken = broken_foreign_keys(&device.pool).await;
        assert!(broken.is_empty(), "seed {seed}: device {i}: {broken:?}");
        let missing = missing_images(&device.pool).await;
        assert!(
            missing.is_empty(),
            "seed {seed}: device {i} lacks images {missing:?}"
        );
        let stale = stale_schedules(&device.pool).await;
        assert!(
            stale.is_empty(),
            "seed {seed}: device {i}'s schedule caches: {stale:#?}"
        );

        let before = synced(&device.pool).await;
        let again = apply(&device.pool, &delivered).await.unwrap();
        assert_eq!(
            again.changed, 0,
            "seed {seed}: re-applying everything delivered changed device {i}"
        );
        assert_eq!(
            synced(&device.pool).await,
            before,
            "seed {seed}: device {i}"
        );
        let queued = pending(&device.pool, 10).await.unwrap();
        assert!(
            queued.is_empty(),
            "seed {seed}: re-applying queued {queued:?} to send on device {i}"
        );
    }
}

/// CloudKit as the transport meets it: zones a device makes for itself and may later leave, a
/// change tag on every record so a save over a newer copy is refused, and changes fetched per
/// zone since a device's last fetch.
#[derive(Default)]
struct CloudKit {
    zones: BTreeMap<String, Zone>,
}

/// A record as the zone holds it, with its change tag.
type Tagged = (RecordName, FieldMap, u64);

#[derive(Default)]
struct Zone {
    records: BTreeMap<String, Tagged>,
    seq: u64,
}

enum Saved {
    Stored(u64),
    /// The server holds a newer copy, handed back with its tag.
    Refused(FieldMap, u64),
    NoZone,
}

impl CloudKit {
    fn save(&mut self, zone: &str, name: RecordName, fields: FieldMap, tag: Option<u64>) -> Saved {
        let Some(zone) = self.zones.get_mut(zone) else {
            return Saved::NoZone;
        };
        if let Some((_, server, current)) = zone.records.get(&name.to_string()) {
            if tag != Some(*current) {
                return Saved::Refused(server.clone(), *current);
            }
        }
        zone.seq += 1;
        zone.records
            .insert(name.to_string(), (name, fields, zone.seq));
        Saved::Stored(zone.seq)
    }

    /// What changed in `zone` since `cursor`, shuffled, or None once the zone is gone.
    fn changed_since(&self, zone: &str, cursor: u64, rng: &mut Rng) -> Option<(Vec<Tagged>, u64)> {
        let zone = self.zones.get(zone)?;
        let mut changed: Vec<_> = zone
            .records
            .values()
            .filter(|(_, _, seq)| *seq > cursor)
            .cloned()
            .collect();
        for i in (1..changed.len()).rev() {
            changed.swap(i, rng.below(i + 1));
        }
        Some((changed, zone.seq))
    }
}

fn tag_bytes(tag: u64) -> Vec<u8> {
    tag.to_le_bytes().to_vec()
}

fn tag_of(bytes: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.try_into().ok()?))
}

/// A device on the CloudKit stand-in. Its change tags and its fetch position live where the app
/// keeps CloudKit's metadata and its sync engine's state, so joining a zone clears them for real.
struct Phone {
    pool: SqlitePool,
    /// This device's own clock, up to ten minutes off from the true time and moving with it.
    clock: &'static AtomicU64,
    skew: i64,
    /// None until it first connects.
    zone: Option<String>,
    /// Where this launch's fetching has got to; what's saved can be behind it.
    cursor: u64,
    /// Fetched records failed to apply this launch, so no state is saved until the next.
    unapplied: bool,
}

impl Phone {
    async fn saved_cursor(&self) -> u64 {
        super::engine_state(&self.pool)
            .await
            .unwrap()
            .and_then(|bytes| tag_of(&bytes))
            .unwrap_or(0)
    }

    /// A launch: settle the zone among those the account holds, deleting this device's own when
    /// another wins, and pick fetching up from the saved state.
    async fn launch(&mut self, cloud: &mut CloudKit) {
        let own =
            pikos_replica::zone::zone_name(&super::meta(&self.pool).await.unwrap().workspace_id);
        let zones: Vec<String> = cloud.zones.keys().cloned().collect();
        let joined = super::join(&self.pool, &zones).await.unwrap();
        if joined != own {
            cloud.zones.remove(&own);
        }
        cloud.zones.entry(joined.clone()).or_default();
        self.zone = Some(joined);
        self.cursor = self.saved_cursor().await;
        self.unapplied = false;
    }

    async fn upload(&mut self, cloud: &mut CloudKit, rng: &mut Rng) {
        let Some(zone) = self.zone.clone() else {
            return;
        };
        let names = pending(&self.pool, 100_000).await.unwrap();
        let built = build(&self.pool, &names).await.unwrap();
        let mut acked = Vec::new();
        let mut tags = Vec::new();
        for record in built {
            if !rng.chance(85) {
                continue;
            }
            let tag = record.system_fields.as_deref().and_then(tag_of);
            match cloud.save(&zone, record.name.clone(), record.fields, tag) {
                Saved::Stored(tag) => {
                    tags.push((record.name.clone(), tag_bytes(tag)));
                    acked.push((record.name, record.clock));
                }
                Saved::Refused(server, tag) => {
                    apply(&self.pool, &[(record.name.clone(), server)])
                        .await
                        .unwrap();
                    tags.push((record.name, tag_bytes(tag)));
                }
                Saved::NoZone => {
                    cloud.zones.entry(zone.clone()).or_default();
                }
            }
        }
        save_system_fields(&self.pool, &tags).await.unwrap();
        sent(&self.pool, &acked).await.unwrap();
    }

    async fn fetch(&mut self, cloud: &CloudKit, rng: &mut Rng, may_fail: bool) {
        let Some(zone) = self.zone.clone() else {
            return;
        };
        let Some((changed, seq)) = cloud.changed_since(&zone, self.cursor, rng) else {
            return;
        };
        self.cursor = seq;
        if may_fail && rng.chance(10) {
            self.unapplied = true;
            return;
        }

        let records: Vec<_> = changed
            .iter()
            .map(|(name, fields, _)| (name.clone(), fields.clone()))
            .collect();
        apply(&self.pool, &records).await.unwrap();
        let tags: Vec<_> = changed
            .into_iter()
            .map(|(name, _, tag)| (name, tag_bytes(tag)))
            .collect();
        save_system_fields(&self.pool, &tags).await.unwrap();
        if !self.unapplied {
            super::set_engine_state(&self.pool, &tag_bytes(self.cursor))
                .await
                .unwrap();
        }
    }
}

async fn run_cloudkit(seed: u64, devices: usize, steps: usize) {
    eprintln!("seed {seed}");
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let world: &'static AtomicU64 = Box::leak(Box::new(AtomicU64::new(1_800_000_000_000)));
    let mut cloud = CloudKit::default();
    let mut fleet = Vec::new();
    for _ in 0..devices {
        let skew = rng.below(20 * 60_000) as i64 - 10 * 60_000;
        let clock: &'static AtomicU64 = Box::leak(Box::new(AtomicU64::new(
            world.load(Ordering::SeqCst).saturating_add_signed(skew),
        )));
        let pool = test_pool_on(Clock::Manual(clock)).await;
        give_images_folder(&pool).await;
        // From the seed, since the order of the zones they name decides which one every device
        // joins, and a failure has to replay.
        sqlx::query("UPDATE replica_meta SET workspace_id = ? WHERE id = 1")
            .bind(format!("{:016x}", rng.next()))
            .execute(&pool)
            .await
            .unwrap();
        for n in 0..rng.below(3) {
            random_edit(&pool, &mut rng, 10_000 + n).await;
        }
        start(&pool).await.unwrap();
        fleet.push(Phone {
            pool,
            clock,
            skew,
            zone: None,
            cursor: 0,
            unapplied: false,
        });
    }

    for n in 0..steps {
        world.fetch_add(rng.below(3) as u64, Ordering::SeqCst);
        let now = world.load(Ordering::SeqCst);
        for device in &fleet {
            device
                .clock
                .store(now.saturating_add_signed(device.skew), Ordering::SeqCst);
        }
        let device = &mut fleet[rng.below(devices)];
        match rng.below(12) {
            0..=5 => random_edit(&device.pool, &mut rng, n).await,
            6 | 7 => device.upload(&mut cloud, &mut rng).await,
            8 | 9 => device.fetch(&cloud, &mut rng, true).await,
            _ => device.launch(&mut cloud).await,
        }
    }

    // Quiet: every device relaunches until all settle in one zone, then sends and fetches
    // everything.
    for _ in 0..8 {
        for device in &mut fleet {
            device.launch(&mut cloud).await;
            let mut sure = Rng(1);
            for attempt in 0.. {
                if pending(&device.pool, 1).await.unwrap().is_empty() {
                    break;
                }
                assert!(attempt < 50, "seed {seed}: a record never leaves the queue");
                device.upload(&mut cloud, &mut sure).await;
            }
        }
        for device in &mut fleet {
            device.cursor = 0;
            device.fetch(&cloud, &mut Rng(1), false).await;
        }
    }

    let zones: Vec<_> = fleet.iter().map(|d| d.zone.clone()).collect();
    assert!(
        zones.windows(2).all(|w| w[0] == w[1]),
        "seed {seed}: devices ended in different zones {zones:?}"
    );
    assert_eq!(
        cloud.zones.len(),
        1,
        "seed {seed}: zones left behind {:?}",
        cloud.zones.keys()
    );
    let first = synced(&fleet[0].pool).await;
    for (i, device) in fleet.iter().enumerate().skip(1) {
        assert_eq!(
            synced(&device.pool).await,
            first,
            "seed {seed}: device {i} differs from device 0"
        );
    }
    for (i, device) in fleet.iter().enumerate() {
        let broken = broken_foreign_keys(&device.pool).await;
        assert!(broken.is_empty(), "seed {seed}: device {i}: {broken:?}");
        let missing = missing_images(&device.pool).await;
        assert!(
            missing.is_empty(),
            "seed {seed}: device {i} lacks images {missing:?}"
        );
        assert!(
            !search_is_stale(&device.pool).await,
            "seed {seed}: device {i}'s search index doesn't match its pages"
        );
        let stale = stale_schedules(&device.pool).await;
        assert!(
            stale.is_empty(),
            "seed {seed}: device {i}'s schedule caches: {stale:#?}"
        );
    }
}

fn seeds() -> Vec<u64> {
    if let Ok(seed) = std::env::var("PIKOS_CONVERGENCE_SEED") {
        return vec![seed.parse().expect("a seed")];
    }
    let count: u64 = std::env::var("PIKOS_CONVERGENCE_SEEDS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(12);
    let from: u64 = std::env::var("PIKOS_CONVERGENCE_FROM")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    (from..from + count).collect()
}

#[tokio::test]
async fn devices_editing_at_random_through_cloudkit_end_up_the_same() {
    for seed in seeds() {
        run(Store::Cloud(Cloud::default()), seed, 3, 120).await;
    }
}

// qa: CLOUD-110:2
#[tokio::test]
async fn devices_that_start_alone_with_skewed_clocks_settle_in_one_zone_through_refusals_and_failed_applies(
) {
    for seed in seeds() {
        run_cloudkit(seed, 3, 160).await;
    }
}

#[tokio::test]
async fn devices_editing_at_random_through_a_shared_folder_end_up_the_same() {
    for seed in seeds() {
        run(Store::Folder(Folder::default()), seed, 3, 120).await;
    }
}
