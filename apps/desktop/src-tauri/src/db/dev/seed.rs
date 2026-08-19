//! Mock calendar-sync seed (dev only).
//!
//! Writes the rows a finished sync would leave — external folders, page_sync
//! links, mixed timed/all-day/recurring/detached pages — without touching the
//! network or keychain, so the synced UI can be spot-checked on demand.
//! Re-running replaces only its own mock account.

use chrono::Datelike;

use crate::db::DbState;
use crate::error::AppResult;

// A doc node requires at least one block child (ProseMirror `block+`); an empty
// content array crashes the editor on open. Match the app's EMPTY_TIPTAP_DOC.
const EMPTY_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
const MOCK_ACCOUNT_NAME: &str = "Mock Calendar (dev)";
/// What an all-day series' rule row carries — see the reconciler's `SENTINEL_TZ`.
const ZONELESS_RULE_TZ: &str = "UTC";

/// Read-only mirror layer for a seeded synced page. `pending_description` is what
/// drives the "calendar description changed" notice; all fields default to empty
/// so most seed rows stay bare mirrors.
#[derive(Default)]
struct SyncedMirror<'a> {
    location: Option<&'a str>,
    attendees: Option<&'a str>, // JSON array of attendee strings
    pending_description: Option<&'a str>,
    body: Option<&'a str>, // Tiptap JSON; the user's own notes on the event
}

/// What a seeded row's stored zone must be, given the source zone the event came
/// with. Detaching **spends** the stamp (`float_wall_clock`): every wall-clock is
/// rewritten into the device zone, `page_schedules.timezone` goes NULL and the
/// rule keeps the device zone. Seeding the source zone onto a detached row instead
/// describes a state the product cannot reach — and off that zone, every later
/// conversion of the row shifts it by the offset. Seed times are already
/// device-local, so applying the outcome is just this pair of stamps.
///
/// An all-day series never gets that far: date-only has nothing to convert, so
/// `float_wall_clock` returns before touching anything and the rule's zone-less
/// sentinel stands.
fn schedule_row_zone<'a>(source: Option<&'a str>, sync_state: &str) -> Option<&'a str> {
    match sync_state {
        "detached" => None,
        _ => source,
    }
}

/// The rule row's half of the pairing [`schedule_row_zone`] documents.
fn rule_row_zone<'a>(source: Option<&'a str>, sync_state: &str) -> &'a str {
    match (source, sync_state) {
        (None, _) => ZONELESS_RULE_TZ,
        (Some(_), "detached") => pikos_db::device_zone().name(),
        (Some(tz), _) => tz,
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_synced_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    folder_id: &str,
    account_id: &str,
    calendar_id: &str,
    title: &str,
    scheduled_start: &str,
    scheduled_end: Option<&str>,
    timezone: Option<&str>,
    sync_state: &str,
    sort_order: i64,
    mirror: SyncedMirror<'_>,
    now: &str,
) -> AppResult<()> {
    let page_id = uuid::Uuid::new_v4().to_string();
    // The body's own plain text, projected the way every real writer projects it
    // (`create_page_impl`, and the reconciler when it applies a description). Seeding
    // an empty projection beside a non-empty body leaves the user's notes on a mirror
    // unfindable — search reads `content_text`, not `content`.
    let body = mirror.body.unwrap_or(EMPTY_DOC);
    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, content, content_text, status, priority, tags,
            sort_order, scheduled_start, scheduled_end, links, mirror_search_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'not_started', 0, '[]', ?, ?, ?, '[]', ?, ?, ?)",
    )
    .bind(&page_id)
    .bind(folder_id)
    .bind(title)
    .bind(body)
    .bind(pikos_db::extract_text_from_tiptap(body))
    .bind(sort_order)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .bind(pikos_db::mirror_search_text(
        mirror.location,
        mirror.attendees,
    ))
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, scheduled_end, timezone, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&page_id)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .bind(schedule_row_zone(timezone, sync_state))
    .bind(now)
    .execute(&mut **tx)
    .await?;

    let ext = uuid::Uuid::new_v4().to_string();
    // A parked description means the user edited the body, so mark the page owned —
    // that's the only state in which the reconciler withholds an upstream change.
    let user_modified = mirror.pending_description.is_some();
    sqlx::query(
        "INSERT INTO page_sync (id, page_id, account_id, provider, calendar_id, external_id,
            ical_uid, sync_state, user_modified, mirror_location, mirror_attendees,
            pending_description, created_at)
         VALUES (?, ?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&page_id)
    .bind(account_id)
    .bind(calendar_id)
    .bind(&ext)
    .bind(&ext)
    .bind(sync_state)
    .bind(user_modified)
    .bind(mirror.location)
    .bind(mirror.attendees)
    .bind(mirror.pending_description)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A provider-moved instance of a seeded series: the occurrence's own start (in
/// the source-zone wall-clock basis a `RECURRENCE-ID` carries) and where the
/// provider put it.
struct MovedInstance<'a> {
    original: &'a str,
    start: &'a str,
    end: &'a str,
}

/// The occurrence deltas and lifecycle state of a seeded recurring series —
/// everything past the bare "weekly from here". Defaults to a live series with no
/// exceptions, which is what most seed rows want.
struct SyncedSeries<'a> {
    sync_state: &'a str,
    /// Cancelled occurrences, in the same basis as [`MovedInstance::original`].
    exdates: &'a [&'a str],
    moved: Option<MovedInstance<'a>>,
    /// `page_sync.created_at` when the series must read as connected before the
    /// seed run — the anchor both the head floor and the render floor key on.
    /// `None` stamps the run's own timestamp, as a fresh connect would.
    connected_at: Option<&'a str>,
}

impl Default for SyncedSeries<'_> {
    fn default() -> Self {
        Self {
            sync_state: "active",
            exdates: &[],
            moved: None,
            connected_at: None,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_synced_recurring(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    folder_id: &str,
    account_id: &str,
    calendar_id: &str,
    title: &str,
    base_start: &str,
    base_end: &str,
    timezone: Option<&str>,
    rrule: &str,
    series: SyncedSeries<'_>,
    sort_order: i64,
    now: &str,
) -> AppResult<()> {
    let page_id = uuid::Uuid::new_v4().to_string();
    // The head is the *derived* current occurrence, so it has to be what
    // `recompute_recurring_schedule` would write — and the engine gives an all-day
    // occurrence no end at all (`timed_duration` returns None for a date-only
    // anchor). Stamping the base end here describes a row the first recompute
    // clears, and the mock, which derives its head, never had one.
    let head_end = base_start.contains('T').then_some(base_end);
    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, content, content_text, status, priority, tags,
            sort_order, scheduled_start, scheduled_end, links, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 'not_started', 0, '[]', ?, ?, ?, '[]', ?, ?)",
    )
    .bind(&page_id)
    .bind(folder_id)
    .bind(title)
    .bind(EMPTY_DOC)
    .bind(sort_order)
    .bind(base_start)
    .bind(head_end)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;

    let rule_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO page_recurrence_rules (id, page_id, rrule, rrule_exdates, scheduled_start,
            scheduled_end, timezone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&rule_id)
    .bind(&page_id)
    .bind(rrule)
    .bind(serde_json::to_string(series.exdates).unwrap_or_else(|_| "[]".to_string()))
    .bind(base_start)
    .bind(base_end)
    .bind(rule_row_zone(timezone, series.sync_state))
    .bind(now)
    .execute(&mut **tx)
    .await?;

    if let Some(moved) = series.moved {
        sqlx::query(
            "INSERT INTO page_schedules (id, page_id, scheduled_start, scheduled_end, timezone,
                rule_id, original_date, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&page_id)
        .bind(moved.start)
        .bind(moved.end)
        .bind(schedule_row_zone(timezone, series.sync_state))
        .bind(&rule_id)
        .bind(moved.original)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }

    let ext = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO page_sync (id, page_id, account_id, provider, calendar_id, external_id,
            ical_uid, sync_state, created_at)
         VALUES (?, ?, ?, 'caldav', ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&page_id)
    .bind(account_id)
    .bind(calendar_id)
    .bind(&ext)
    .bind(&ext)
    .bind(series.sync_state)
    .bind(series.connected_at.unwrap_or(now))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn dev_seed_synced_calendar(state: tauri::State<'_, DbState>) -> AppResult<()> {
    let pool = state.get_pool().await?;
    dev_seed_synced_calendar_impl(&pool).await
}

pub(crate) async fn dev_seed_synced_calendar_impl(pool: &sqlx::SqlitePool) -> AppResult<()> {
    let now = pikos_db::now_iso();
    let today = chrono::Local::now().date_naive();
    let day = |offset: i64| {
        (today + chrono::Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    };
    let at = |offset: i64, hm: &str| format!("{}T{hm}:00", day(offset));

    let mut tx = pool.begin().await?;

    // Idempotent: drop a prior mock account (cascades its calendars + page_sync).
    sqlx::query("DELETE FROM sync_account WHERE display_name = ?")
        .bind(MOCK_ACCOUNT_NAME)
        .execute(&mut *tx)
        .await?;

    let account_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', ?, 'basic', ?, ?)",
    )
    .bind(&account_id)
    .bind(MOCK_ACCOUNT_NAME)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let mut folder_ids = Vec::new();
    for (i, (name, color, cal_id)) in [
        ("Personal (synced)", "#7c9cf0", "mock-personal"),
        ("Work (synced)", "#f0a37c", "mock-work"),
    ]
    .into_iter()
    .enumerate()
    {
        let folder_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO folders (id, name, sort_order, color, is_external_calendar, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(&folder_id)
        .bind(name)
        .bind(1000 + i as i64)
        .bind(color)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO sync_calendar (id, account_id, calendar_id, display_name, color, enabled,
                folder_id, last_synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&account_id)
        .bind(cal_id)
        .bind(name)
        .bind(color)
        .bind(&folder_id)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        folder_ids.push((folder_id, cal_id));
    }
    let (personal, personal_cal) = &folder_ids[0];
    let (work, work_cal) = &folder_ids[1];

    // "Team standup" carries the full read-only mirror surface: location, attendees,
    // a user-edited body, and a withheld upstream description → shows the notice.
    //
    // Times and shapes mirror the TS seed (`shared/seeds/syncedCalendar.ts`), which
    // places each event in a lane the realistic seed leaves free and records what
    // each shape is here to make reachable — see the note there.
    let standup_body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"My prep: land the calendar-sync PR before we demo."}]}]}"#;
    insert_synced_page(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Team standup",
        &at(0, "11:00"),
        Some(&at(0, "11:30")),
        Some("America/New_York"),
        "active",
        0,
        SyncedMirror {
            location: Some("Zoom"),
            attendees: Some(r#"["alex@example.com","sam@example.com","jordan@example.com"]"#),
            pending_description: Some(
                "Agenda updated: demo the new sync panel, then round-table blockers.",
            ),
            body: Some(standup_body),
        },
        &now,
    )
    .await?;
    insert_synced_page(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Design review (LA team)",
        &at(0, "15:00"),
        Some(&at(0, "16:00")),
        Some("America/Los_Angeles"),
        "active",
        1,
        SyncedMirror {
            location: Some("Room 4B"),
            attendees: Some(r#"["design@example.com"]"#),
            ..SyncedMirror::default()
        },
        &now,
    )
    .await?;
    insert_synced_page(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Company offsite",
        &day(0),
        None,
        None,
        "active",
        2,
        SyncedMirror::default(),
        &now,
    )
    .await?;
    insert_synced_page(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Product summit",
        &day(0),
        Some(&day(2)),
        None,
        "active",
        3,
        SyncedMirror::default(),
        &now,
    )
    .await?;
    insert_synced_recurring(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Weekly 1:1 (London)",
        &at(0, "17:00"),
        &at(0, "17:30"),
        Some("Europe/London"),
        "FREQ=WEEKLY",
        SyncedSeries::default(),
        4,
        &now,
    )
    .await?;
    // A live series carrying both occurrence deltas a provider can send: a
    // cancelled instance (timed EXDATE) and one moved weeks out. Both stored as
    // full wall-clock, which is what exercises the day-keyed exclusion — a
    // date-only fixture passes whether or not the render layer day-keys.
    insert_synced_recurring(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Recurring review",
        &at(0, "10:00"),
        &at(0, "10:30"),
        Some("America/New_York"),
        "FREQ=WEEKLY",
        SyncedSeries {
            exdates: &[&at(7, "10:00")],
            moved: Some(MovedInstance {
                original: &at(14, "10:00"),
                start: &at(24, "15:00"),
                end: &at(24, "15:30"),
            }),
            ..SyncedSeries::default()
        },
        5,
        &now,
    )
    .await?;
    insert_synced_recurring(
        &mut tx,
        personal,
        &account_id,
        personal_cal,
        "Swim class (term ends)",
        &at(0, "06:00"),
        &at(0, "06:30"),
        Some("America/New_York"),
        &format!(
            "FREQ=WEEKLY;UNTIL={}T113000",
            (today + chrono::Duration::days(21)).format("%Y%m%d")
        ),
        SyncedSeries {
            sync_state: "detached",
            ..SyncedSeries::default()
        },
        6,
        &now,
    )
    .await?;

    insert_synced_page(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Tokyo sync",
        &at(1, "10:00"),
        Some(&at(1, "10:30")),
        Some("Asia/Tokyo"),
        "active",
        0,
        SyncedMirror::default(),
        &now,
    )
    .await?;
    insert_synced_page(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Budget sign-off",
        &at(-2, "13:00"),
        Some(&at(-2, "13:30")),
        Some("America/New_York"),
        "active",
        1,
        SyncedMirror::default(),
        &now,
    )
    .await?;
    insert_synced_page(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Old planning (detached)",
        &at(0, "17:00"),
        Some(&at(0, "17:30")),
        Some("America/New_York"),
        "detached",
        2,
        SyncedMirror::default(),
        &now,
    )
    .await?;
    insert_synced_page(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Contractor call (no zone)",
        &at(0, "13:30"),
        Some(&at(0, "14:00")),
        None,
        "active",
        3,
        SyncedMirror::default(),
        &now,
    )
    .await?;
    // A detached series carrying a provider-moved instance: its occurrences stay
    // in-series as override rows rather than cloning out, so the moved block is
    // unlocked and a re-link can reclaim the slot. Times mirror the TS seed.
    insert_synced_recurring(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Detached sprint",
        &at(0, "07:15"),
        &at(0, "07:45"),
        Some("America/New_York"),
        "FREQ=WEEKLY",
        SyncedSeries {
            sync_state: "detached",
            moved: Some(MovedInstance {
                original: &at(14, "07:15"),
                start: &at(16, "15:00"),
                end: &at(16, "15:30"),
            }),
            ..SyncedSeries::default()
        },
        4,
        &now,
    )
    .await?;
    // Backdated: its passed occurrences read as missed, so the head is overdue.
    let connected_five_days_ago = (chrono::Utc::now() - chrono::Duration::days(5))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    insert_synced_recurring(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Release countdown",
        &at(-5, "08:30"),
        &at(-5, "09:00"),
        Some("America/New_York"),
        "FREQ=DAILY;COUNT=6",
        SyncedSeries {
            connected_at: Some(&connected_five_days_ago),
            ..SyncedSeries::default()
        },
        5,
        &now,
    )
    .await?;
    insert_synced_recurring(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "On-call rotation",
        &day(0),
        &day(0),
        None,
        "FREQ=WEEKLY",
        SyncedSeries {
            sync_state: "detached",
            moved: Some(MovedInstance {
                original: &day(14),
                start: &day(15),
                end: &day(15),
            }),
            ..SyncedSeries::default()
        },
        6,
        &now,
    )
    .await?;
    let month_end = last_day_of_month(today);
    insert_synced_recurring(
        &mut tx,
        work,
        &account_id,
        work_cal,
        "Month-end close",
        &format!("{month_end}T12:30:00"),
        &format!("{month_end}T13:00:00"),
        Some("America/New_York"),
        "FREQ=MONTHLY;BYMONTHDAY=-1",
        SyncedSeries {
            sync_state: "detached",
            ..SyncedSeries::default()
        },
        7,
        &now,
    )
    .await?;

    tx.commit().await?;
    log::info!("dev_seed_synced_calendar: seeded mock account + 2 calendars + 15 pages");
    Ok(())
}

fn last_day_of_month(day: chrono::NaiveDate) -> String {
    let first_next = if day.month() == 12 {
        chrono::NaiveDate::from_ymd_opt(day.year() + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(day.year(), day.month() + 1, 1)
    };
    first_next
        .and_then(|d| d.pred_opt())
        .unwrap_or(day)
        .format("%Y-%m-%d")
        .to_string()
}
