# Feature: Notification System

## Status
Not started. Blocked by GOO-29 (SQLite schema), GOO-34 (scheduled date picker).

## Goal
Remind users of scheduled pages without requiring them to keep Pikos in focus.
Covers OS-level desktop notifications (macOS Notification Center, Windows Toast, Linux
libnotify) plus in-app banners when the window is active. Zero network — fully local.

---

## Notification Types

| Type | Trigger | Default state |
|---|---|---|
| **Pre-event reminder** | N minutes before `scheduled_start` | On (10 min lead) |
| **At-start reminder** | Exactly at `scheduled_start` | Off |
| **Overdue alert** | Page past `scheduled_end` with `status ≠ done` | On, max 1/day/page |
| **Daily digest** | Fixed time each morning (default 8am) | Off (opt-in) |
| **Focus session end** | GOO-78 timer expires | On |

---

## Per-Page Reminder Configuration

Each page can have zero or more reminder times stored in a join table (supporting
multiple reminders, e.g. "1h before AND 10min before"):

```sql
CREATE TABLE page_reminders (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL,  -- 0 = at start time; negative values not allowed
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_page_reminders_page ON page_reminders(page_id);
```

**Defaults:** If a page has no row in `page_reminders`, the global default lead time
(from Settings) is used. If global reminders are off, no notification fires.

**UI surface:** Metadata header (GOO-32) — a small bell icon next to the scheduled date.
Clicking it opens a popover:

```
🔔 Reminders
  ○ None
  ● 10 min before  ← default, pre-selected if scheduled_start is set
  ○ 30 min before
  ○ 1 hour before
  ○ Custom…         → number input + "min before"
  [ + Add another reminder ]
```

Multiple reminders shown as chips, each deletable:
`[10 min before ×]  [1 hr before ×]  [+ Add]`

---

## Deduplication & State Log

```sql
CREATE TABLE notification_log (
  id            TEXT PRIMARY KEY,
  page_id       TEXT,            -- NULL for digest type
  schedule_id   TEXT,            -- from page_schedules; NULL for digest/focus
  type          TEXT NOT NULL,   -- 'reminder' | 'overdue' | 'digest' | 'focus'
  fired_at      INTEGER NOT NULL,
  snoozed_until INTEGER,         -- NULL if not snoozed
  action        TEXT             -- 'dismissed' | 'done' | 'snoozed' | 'opened' | NULL
);
CREATE INDEX idx_notif_log_schedule ON notification_log(schedule_id, type, fired_at);
```

Rules:
- **Reminder**: fires once per `(schedule_id, minutes_before)` pair. Re-fires only if
  the `scheduled_start` changes after the notification was sent.
- **Overdue**: fires at most once per `(page_id, calendar_date)`. Not re-sent if the
  user opens the app but doesn't act.
- **Snooze**: a snoozed notification inserts a row with `snoozed_until` set. The
  scheduler re-fires after that timestamp without creating a new log row (updates in place).

---

## Scheduler Architecture

Run in **Rust** via a Tokio background task, not JS `setInterval`. Reason: macOS/Windows
can throttle or suspend JS timers when the webview is backgrounded; a Rust async task
on the Tauri runtime is immune to this.

```rust
// src-tauri/src/notifications/scheduler.rs (sketch)
pub async fn run(app: AppHandle) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        if let Err(e) = check_and_fire(&app).await {
            tracing::error!("notification scheduler error: {e}");
        }
    }
}

async fn check_and_fire(app: &AppHandle) -> Result<()> {
    let db = app.state::<DbPool>();
    let now = Utc::now().timestamp();
    let window_start = now - 30;  // catch anything in the last tick window

    // 1. Pre-event reminders
    let due = db.query(
        "SELECT ps.id, ps.page_id, p.title, ps.scheduled_start, pr.minutes_before
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         JOIN page_reminders pr ON pr.page_id = ps.page_id
         WHERE ps.scheduled_start - (pr.minutes_before * 60) BETWEEN ? AND ?
           AND p.status != 'done'
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id AND nl.type = 'reminder'
               AND nl.snoozed_until IS NULL
           )",
        [window_start, now]
    ).await?;

    for row in due {
        fire_reminder(app, &row).await?;
    }

    // 2. Overdue alerts (similar query, scheduled_end < now)
    // 3. Daily digest (check if now is within 30s of configured digest time)
    Ok(())
}
```

Registered in `lib.rs`:
```rust
tauri::Builder::default()
    .setup(|app| {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(notifications::scheduler::run(handle));
        Ok(())
    })
```

**Required Cargo dep:** `tauri-plugin-notification` (official Tauri v2 plugin).

---

## OS Notification Delivery

`tauri-plugin-notification` wraps the native APIs:
- **macOS**: `UNUserNotificationCenter` (action buttons, grouping, sound)
- **Windows**: Windows Toast Notifications (action buttons, app ID required)
- **Linux**: `libnotify` / D-Bus (limited action support)

### Permission request
On first scheduled page creation, Pikos requests notification permission once:
```rust
use tauri_plugin_notification::NotificationExt;
app.notification().request_permission()?;
```
If denied: Settings shows a "Notifications are blocked — open System Settings" link.
No silent failures, no repeated requests.

### Notification content
```
[Pikos icon]  Review PRs                    ← page title
              Starts in 10 minutes · 2:00pm ← subtitle: lead time + start time
              [Done]  [Snooze]  [Open]       ← action buttons (macOS/Windows)
```

Title: page title only.
Subtitle: lead time description + formatted start time in user's local timezone.
Body: page subtitle (GOO-77) if set — otherwise omitted. Never includes note body
content (could be sensitive).

**Notification style (macOS):**
- Default: **Banner** (auto-dismisses after ~5s, stays in Notification Center)
- Option in Settings: **Alert** (stays on screen until dismissed) — for users who
  miss banners

**Grouping:** All Pikos notifications share `thread-id: "pikos-reminders"` so they
collapse in Notification Center instead of stacking.

**Sound:** System default notification sound. Can be disabled in Settings or muted
globally via macOS Focus modes (Pikos respects Focus modes automatically via the OS).

---

## Action Buttons

Registered as a notification category at startup:
```rust
// macOS: UNNotificationCategory with three actions
NotificationCategory {
    id: "PIKOS_REMINDER",
    actions: [
        { id: "DONE",  title: "Done",     destructive: false },
        { id: "SNOOZE",title: "Snooze",   destructive: false },
        { id: "OPEN",  title: "Open",     foreground: true   },
    ]
}
```

**`[Done]`** — marks page `status = done`, logs `action = 'done'`. No app open required.

**`[Snooze]`** — presents a sub-menu (macOS) or cycles through options (Windows):
  - Snooze 15 min
  - Snooze 1 hour
  - Snooze until tomorrow (uses the global morning digest time, e.g. 8am)

  Inserts/updates `snoozed_until` in `notification_log`. The scheduler picks it up on
  the next tick after `snoozed_until`.

**`[Open]`** — brings Pikos to foreground and navigates to the page.
  Uses `app.get_webview_window("main")?.set_focus()` + emits a `navigate:page` Tauri
  event that the React app handles.

---

## In-App Banner (Window Focused)

When the Pikos window has focus, firing an OS notification creates a jarring double
experience. Instead, suppress the OS notification and show an in-app banner:

```
┌─────────────────────────────────────────────────────────┐
│ 🔔  Review PRs — starts in 10 minutes           [×]    │
│     [✓ Done]  [⏱ Snooze]  [→ Open]                    │
└─────────────────────────────────────────────────────────┘
```

Position: top-right, below the window chrome. Stacks if multiple fire close together
(max 3 visible, rest queued). Auto-dismisses after 8 seconds. Animated slide-in/out
(Framer Motion, same spring config as sidebar: stiffness 350, damping 35).

Implementation: Tauri emits a `notification:due` event to the webview. React renders
a `<NotificationBanner>` component via a portal into `document.body`. The Rust
scheduler checks `app.get_webview_window("main")?.is_focused()` before deciding
which path to take.

---

## Settings

**Settings → Notifications** (new tab):

```
Notifications
─────────────────────────────────────────────
Enable notifications          [toggle — on]

Default reminder lead time    [10 min ▾]
  Options: At start time / 5 min / 10 min /
           15 min / 30 min / 1 hour / Custom

Overdue alerts                [toggle — on]
  Alert me once per day for overdue items

Notification style            [Banner ▾]
  Banner — auto-dismisses
  Alert  — stays until dismissed (macOS only)

Daily digest                  [toggle — off]
  Send a morning summary of today's tasks
  Time: [8:00 AM ▾]

Quiet hours                   [toggle — off]
  Don't notify between [10:00 PM] and [8:00 AM]

─────────────────────────────────────────────
Notifications blocked by system              ← shown only if permission denied
[Open System Settings →]
```

---

## Privacy

- No data leaves the device. Ever.
- Notification content: title + start time only by default. Subtitle (GOO-77) included
  if set and the user hasn't disabled it. Note body never appears in notifications.
- `notification_log` stored in SQLite (same workspace DB) — not exported unless user
  explicitly exports their workspace.
- No analytics on notification interaction rates. Snooze/done actions are logged only
  locally (in `notification_log.action`) for dedup purposes.

---

## Interaction with GOO-86 (Messaging Notifications)

GOO-86 adds a second delivery channel (Telegram, Discord) for the same notification
types. The two systems are **independent but share the same `notification_log` table**
for dedup — a page that fired an OS reminder does not also fire a messaging reminder
for the same event (unless the user explicitly enables both in Settings).

Settings → Notifications shows a "Also send via messaging" section when GOO-86 is
configured, with per-type toggles.

---

## Import Interaction

When the importer maps reminders from external sources:

- **TickTick `Reminder` column**: ISO 8601 duration offsets relative to scheduled start.
  - `PT0S` = "On time" (at start)
  - `-PT5M` = 5 minutes early
  - `-PT30M` = 30 minutes early
  - `-PT1H` = 1 hour early
  - `-P1D` = 1 day early
  - Maps directly to `page_reminders.minutes_before` (parse duration, convert to minutes).
- **Todoist**: No explicit reminder column in CSV exports. No mapping needed.
- **Bulk import safety**: The scheduler must NOT fire notifications for pages created during an import batch (identified by the `_import_*` batch tag). Either suppress notifications for the batch tag, or only fire for schedules with `scheduled_start` in the future at the time of import.
- The global "Enable notifications" toggle must be checked before any notification fires — this is the user's kill switch for all notification types.

---

## Dependencies

- **GOO-29** — SQLite schema (need to add `page_reminders` + `notification_log` tables)
- **GOO-34** — Scheduled date picker (pages must have `scheduled_start` before reminders make sense)
- **GOO-76** — `page_schedules` table (scheduler queries this, not `pages.scheduled_start` denorm)
- **GOO-32** — Metadata header (bell icon UI lives here)
- **GOO-77** — Subtitle field (included in notification body if set)
- **GOO-78** — Focus timer (focus-end notification type)
- **Tauri dep** — `tauri-plugin-notification` (add to `Cargo.toml` + `tauri.conf.json` permissions)
