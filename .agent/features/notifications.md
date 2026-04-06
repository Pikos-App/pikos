# Feature: Notifications — Key Decisions & Future Work

## Summary

OS desktop notifications for scheduled pages. Fully local — no network, no telemetry. Rust scheduler (Tokio background task, 30s polling) fires reminders via `tauri-plugin-notification`. Per-page overrides via `page_reminders` table; global defaults in Settings.

## Key Decisions (non-obvious)

### Rust Scheduler, Not JS
macOS/Windows throttle or suspend JS timers when the webview is backgrounded. A Tokio async task on the Tauri runtime is immune to this. 30-second polling interval catches all due reminders.

### Sentinel Value for "None"
`page_reminders.minutes_before = -1` means "explicitly no reminders for this page." Distinguishes "use global default" (0 rows) from "disabled" (1 sentinel row). Migration 007 relaxed the CHECK constraint.

### No Snooze or In-App Banner
Removed in favor of OS notifications only. Calendar already shows upcoming events when the app is focused. Simpler, fewer edge cases.

### Dedup via notification_log
Reminders fire once per `(schedule_id, type)` pair. Overdue alerts fire once per `(page_id, calendar_date)`. 30-day automatic pruning.

### Import Batch Safety
Overdue alerts skip pages created within the last 5 minutes (`p.created_at < recent_cutoff`), preventing fire-on-import for batch imports.

## Current State

Shipped: OS reminders (pre-event + overdue), per-page bell icon popover, global Settings panel (enable/disable, default lead time, overdue toggle, quiet hours), TickTick import mapping, dedup log, permission request flow.

## Unbuilt Features

- **OS notification action buttons** (Done/Open) via `tauri-plugin-notification` action categories
- **Notification sound toggle** — silent visual-only option, `.sound()` on builder
- **Daily digest** — morning summary of today's scheduled pages (opt-in)
- **Focus session end notification** — depends on GOO-78 focus timer
- **Messaging channel** (GOO-86) — Telegram/Discord delivery, shares `notification_log` for dedup
