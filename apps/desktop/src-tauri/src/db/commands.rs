//! Every pool-backed Tauri command, and the one place they are registered.
//!
//! Most of this app's commands are the same three lines — resolve the pool from
//! managed state, hand it to a `pikos-db` writer, await. Written out, each one
//! spread that across four uncoupled edits (the writer, the shim, an import, the
//! `generate_handler!` list), and the fourth failing silently: a command that is
//! never registered still compiles, and only fails when a user presses the button.
//!
//! So the shims are declared once, below, and [`db_commands!`] emits both halves
//! from that single list — the `#[tauri::command]` functions *and* the
//! [`register`] call that puts them on the builder. Declaring a command is
//! therefore the same act as registering it; there is no second list to forget.
//!
//! Commands with a real body stay hand-written where they live and are named in
//! the `extras:` block, so they register through the same entry point. See
//! [`register`] for what is in there and why.

use serde::Deserialize;

/// Reminder creation input. Lives here rather than beside the command because
/// the command itself is generated; this is the only hand-written half of it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPageReminder {
    pub page_id: String,
    pub minutes_before: i64,
}

/// What every generated module gets in scope. One shared prelude rather than a
/// per-module import list, since the modules below exist only to namespace the
/// commands and nothing else is written inside them.
mod prelude {
    pub use tauri::State;

    pub use pikos_calendar_sync::{
        connect_caldav, disconnect_account, reconnect_caldav, refresh_account_auto,
        release_all_credentials, resync_account_auto, CalendarSyncResult, Keychain,
    };
    pub use pikos_db::*;

    pub use super::NewPageReminder;
    pub use crate::db::DbState;
}

/// Declares pool-backed commands and generates their registration.
///
/// One line per command:
///
/// ```ignore
/// name(arg: Type, …) -> ReturnType = impl_fn(call, args…);
/// ```
///
/// which expands to a `#[tauri::command] pub async fn name(state, arg, …) ->
/// AppResult<ReturnType>` that resolves the pool and calls
/// `impl_fn(&pool, call, args…).await`. The pool is threaded in as the first
/// argument and never spelled at the declaration site; everything after it is
/// written as it should be passed, so the by-value / `&` / `.as_deref()` /
/// field-access variations the real writers want are just part of the line.
///
/// Each `mod name { … }` block generates `db::commands::name`, which `db/mod.rs`
/// (or, where the module also holds hand-written commands, the module's own
/// file) surfaces at `db::name` — the path this macro registers them under and
/// the one the rest of the app knows them by.
///
/// The `extras:` block lists commands written by hand elsewhere. They are not
/// generated, only registered — which is the point: [`register`] is the whole
/// invoke surface, so a hand-written command reaches the frontend the same way a
/// declared one does, and dropping it from that block is a compile error at its
/// own call sites rather than a dead button.
macro_rules! db_commands {
    (
        extras: [ $($extra:path),* $(,)? ];
        $(
            $(#[$mod_attr:meta])*
            mod $module:ident {
                $(
                    $(#[$attr:meta])*
                    $name:ident ( $($arg:ident : $arg_ty:ty),* $(,)? ) -> $ret:ty
                        = $($writer:ident)::+ ( $($call:expr),* $(,)? );
                )*
            }
        )*
    ) => {
        $(
            $(#[$mod_attr])*
            pub mod $module {
                #[allow(unused_imports)]
                use super::prelude::*;

                $(
                    $(#[$attr])*
                    #[tauri::command]
                    pub async fn $name(
                        state: State<'_, DbState>,
                        $($arg: $arg_ty),*
                    ) -> AppResult<$ret> {
                        let pool = state.get_pool().await?;
                        $($writer)::+(&pool, $($call),*).await
                    }
                )*
            }
        )*

        /// Put every command on the builder: the ones declared by
        /// `db_commands!` above, plus the hand-written ones it was handed.
        ///
        /// This is the app's entire invoke surface. `lib.rs` calls it and lists
        /// nothing itself, so there is no registration list to fall out of sync
        /// with the commands that exist.
        pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
            builder.invoke_handler(tauri::generate_handler![
                $($extra,)*
                $($( $crate::db::$module::$name, )*)*
            ])
        }
    };
}

db_commands! {
    // Commands with a real body, registered here but written where they live:
    //
    // - `connect_db` owns the pool the generated shims read.
    // - the asset commands resolve the app data dir, not a pool.
    // - `expand_recurrence_range` is stateless — no pool at all.
    // - `google_sync_available` is sync and answers from the build config.
    // - `connect_google_account` drives an OAuth browser round-trip.
    // - `toggle_sync_calendar` is generic over the runtime (so a MockRuntime
    //   test can invoke it) and pokes the sync loop after enabling.
    // - the notification commands talk to the scheduler and the OS.
    // - the dev/settings commands each do real work around the pool.
    extras: [
        crate::db::connect_db,
        crate::db::assets::init_assets_dir,
        crate::db::assets::save_asset,
        crate::db::assets::save_asset_bytes,
        crate::db::schedules::expand_recurrence_range,
        crate::db::sync::google_sync_available,
        crate::db::sync::connect_google_account,
        crate::db::sync::toggle_sync_calendar,
        crate::notifications::scheduler::update_notification_settings,
        crate::notifications::scheduler::request_notification_permission,
        crate::notifications::scheduler::check_notification_permission,
        crate::db::dev::backdate_page,
        crate::db::dev::backup_db,
        crate::db::dev::backup_db_before_import,
        crate::db::dev::export_csv,
        crate::db::dev::export_ics,
        crate::db::dev::export_markdown,
        crate::db::dev::get_usage_stats,
        crate::db::dev::reset_db,
        crate::db::dev::dev_seed_synced_calendar,
        crate::db::dev::wipe_app_data,
    ];

    mod pages {
        get_page(id: String) -> Option<Page> = pikos_db::get_page(&id);
        create_page(data: NewPage) -> Page = create_page_impl(data);
        update_page(id: String, updates: PageUpdate) -> Page = update_page_impl(id, updates);
        clear_pending_description(id: String) -> () = clear_pending_description_impl(&id);
        delete_page(id: String) -> () = delete_page_impl(&id);
        soft_delete_page(id: String) -> () = soft_delete_page_impl(&id);
        restore_page(id: String) -> () = restore_page_impl(&id);
        /// The trash, newest deletion first. Read-only: everything that puts a
        /// page in it or takes one out is an existing command.
        list_trashed_pages() -> Vec<TrashedPage> = list_trashed_pages_impl();
        /// Destroy trashed pages deleted more than `older_than_days` ago,
        /// returning how many actually went. `0` is "Empty Trash"; the app's
        /// start-up sweep passes the retention window. A mirror is kept and
        /// stays tombstoned — see the writer.
        purge_trashed_pages(older_than_days: i64) -> i64
            = purge_trashed_pages_older_than(older_than_days);
        list_pages(filter: Option<PageFilter>) -> Vec<PageSummary> = list_pages_impl(filter);
        list_pages_today() -> Vec<PageSummary> = list_pages_today_impl();
        list_completed_pages(filter: CompletedPagesFilter) -> CompletedPagesResponse
            = list_completed_pages_impl(filter);
        reorder_pages(folder_id: Option<String>, ordered_ids: Vec<String>) -> ()
            = reorder_pages_impl(folder_id.as_deref(), &ordered_ids);
        set_pages_status(ids: Vec<String>, status: String, completed_at: Option<String>)
            -> Vec<PageSummary>
            = set_pages_status_impl(&ids, &status, completed_at.as_deref());
        complete_recurring_page(data: CompleteRecurringInput) -> CompleteRecurringResult
            = complete_recurring_page_impl(data);
        reschedule_virtual_occurrence(data: RescheduleVirtualInput) -> RescheduleVirtualResult
            = reschedule_virtual_occurrence_impl(data);
        uncomplete_recurring_occurrence(data: UncompleteRecurringInput) -> ()
            = uncomplete_recurring_occurrence_impl(data);
        skip_occurrence(data: SkipOccurrenceInput) -> () = skip_occurrence_impl(data);
        undo_skip_occurrence(data: SkipOccurrenceInput) -> () = undo_skip_occurrence_impl(data);
        recompute_recurring_schedules() -> Vec<PageSummary> = recompute_recurring_schedules_impl();
    }

    mod folders {
        get_folder(id: String) -> Option<Folder> = get_folder_impl(&id);
        create_folder(data: NewFolder) -> Folder = create_folder_impl(data);
        update_folder(id: String, updates: FolderUpdate) -> Folder
            = update_folder_impl(id, updates);
        delete_folder(id: String) -> () = delete_folder_impl(id);
        soft_delete_folder(id: String) -> () = soft_delete_folder_impl(id);
        restore_folder(id: String) -> () = restore_folder_impl(id);
        list_folders() -> Vec<Folder> = list_folders_impl();
        reorder_folders(ordered_ids: Vec<String>) -> () = reorder_folders_impl(&ordered_ids);
    }

    mod schedules {
        create_page_schedule(data: NewPageSchedule) -> PageSchedule
            = create_page_schedule_impl(data);
        update_page_schedule(id: String, updates: PageScheduleUpdate) -> PageSchedule
            = update_page_schedule_impl(id, updates);
        delete_page_schedule(id: String) -> () = delete_page_schedule_impl(id);
        list_page_schedules(page_id: String) -> Vec<PageSchedule>
            = list_page_schedules_impl(&page_id);
        list_page_schedules_for_rules(rule_ids: Vec<String>) -> Vec<PageSchedule>
            = list_page_schedules_for_rules_impl(&rule_ids);
        create_recurrence_rule(data: NewRecurrenceRule) -> PageRecurrenceRule
            = create_recurrence_rule_impl(data);
        update_recurrence_rule(id: String, updates: RecurrenceRuleUpdate) -> PageRecurrenceRule
            = update_recurrence_rule_impl(id, updates);
        add_rule_exdates(id: String, dates: Vec<String>) -> PageRecurrenceRule
            = add_rule_exdates_impl(id, dates);
        remove_rule_exdate(id: String, date: String) -> PageRecurrenceRule
            = remove_rule_exdate_impl(id, date);
        delete_recurrence_rule(id: String) -> () = delete_recurrence_rule_impl(&id);
        list_recurrence_rules() -> Vec<PageRecurrenceRule> = list_recurrence_rules_impl();
        get_recurrence_rule(page_id: String) -> Option<PageRecurrenceRule>
            = get_recurrence_rule_impl(&page_id);
    }

    mod search {
        search_pages(query: String, include_completed: Option<bool>) -> SearchResponse
            = search_pages_impl(query, include_completed);
    }

    /// Focus sessions. Write-only from here: the totals the Data panel shows are
    /// read through `get_usage_stats`, which aggregates the table rather than
    /// listing it, so there is no read counterpart to this command.
    mod focus {
        create_focus_session(
            page_id: String,
            started_at: String,
            ended_at: String,
            duration_s: i64,
        ) -> FocusSession
            = pikos_db::create_focus_session(&page_id, &started_at, &ended_at, duration_s);
    }

    mod tags {
        search_tags(query: String) -> Vec<String> = pikos_db::search_tags(&query);
    }

    /// Per-page reminder CRUD. The write/read logic lives in
    /// `pikos_db::reminders` (pool-based, unit-tested).
    mod notifications {
        create_page_reminder(data: NewPageReminder) -> PageReminder
            = pikos_db::create_page_reminder(&data.page_id, data.minutes_before);
        list_page_reminders(page_id: String) -> Vec<PageReminder>
            = pikos_db::list_page_reminders(&page_id);
        delete_page_reminder(id: String) -> () = pikos_db::delete_page_reminder(&id);
        delete_page_reminders(page_id: String) -> () = pikos_db::delete_page_reminders(&page_id);
        /// The notification log, newest first — what the scheduler fired, and
        /// what quiet hours silenced. Read-only: the log's only writer is the
        /// scheduler, so there is no frontend counterpart to this command.
        list_notification_history(limit: i64) -> Vec<NotificationHistoryEntry>
            = pikos_db::list_notification_history(limit);
    }

    /// The sync commands that are pure delegation. The keychain is constructed
    /// per call — credentials live in the OS keychain, keyed by account id, so
    /// there is no shared sync state to hold.
    mod sync {
        connect_caldav_account(
            base_url: String,
            username: String,
            password: String,
            display_name: String,
        ) -> AccountWithCalendars
            = connect_caldav(Keychain::system(), base_url, username, password, display_name);
        reconnect_caldav_account(account_id: String, password: String) -> AccountWithCalendars
            = reconnect_caldav(Keychain::system(), &account_id, password);
        disconnect_sync_account(account_id: String) -> ()
            = disconnect_account(Keychain::system(), &account_id);
        /// Credential teardown for a full data wipe — `wipe_app_data` doesn't
        /// reach the keychain.
        release_sync_credentials() -> () = release_all_credentials(Keychain::system());
        list_sync_calendars(account_id: String) -> Vec<SyncCalendar>
            = list_sync_calendars_impl(&account_id);
        set_sync_calendar_color(sync_calendar_id: String, color: String) -> SyncCalendar
            = set_sync_calendar_color_impl(&sync_calendar_id, &color);
        resync_sync_account(account_id: String) -> Vec<CalendarSyncResult>
            = resync_account_auto(Keychain::system(), &account_id);
        refresh_sync_account(account_id: String) -> Vec<CalendarSyncResult>
            = refresh_account_auto(Keychain::system(), &account_id);
        get_sync_status() -> Vec<AccountWithCalendars> = get_sync_status_impl();
    }
}
