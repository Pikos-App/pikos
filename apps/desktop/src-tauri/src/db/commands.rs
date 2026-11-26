//! Every pool-backed Tauri command, and the one place they are registered.
//!
//! Most commands are the same three lines: resolve the pool, hand it to a `pikos-db`
//! writer, await. A command that is never registered still compiles and only fails when a
//! user presses the button, so [`db_commands!`] emits both the `#[tauri::command]`
//! functions and the [`register`] call from one list. The e2e bridge's dispatcher comes off
//! the same list.
//!
//! Commands with a real body stay hand-written where they live and are named in the
//! `extras:` block, so they register through the same entry point.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPageReminder {
    pub page_id: String,
    pub minutes_before: i64,
}

mod prelude {
    pub use tauri::State;

    pub use pikos_calendar_sync::{
        connect_caldav, disconnect_account, reconnect_caldav, refresh_account_auto,
        release_all_credentials, resync_account_auto, CalendarSyncResult, Keychain,
    };
    pub use pikos_db::changes::ChangeState;
    pub use pikos_db::moves::{MoveOutcome, Placement};
    pub use pikos_db::reads::{PageIfNewer, TagCount, ViewCounts};
    pub use pikos_db::views::{
        CompletedCursor, CompletedWindow, ViewCursor, ViewKey, ViewScope, ViewWindow,
    };
    pub use pikos_db::*;

    pub use super::NewPageReminder;
    pub use crate::db::DbState;
}

/// One line per command:
///
/// ```ignore
/// name(arg: Type, …) -> ReturnType = impl_fn(call, args…);
/// ```
///
/// which expands to a `#[tauri::command] pub async fn name(state, arg, …) ->
/// AppResult<ReturnType>` that resolves the pool and calls `impl_fn(&pool, call, args…)`.
/// Everything after the pool is written as it should be passed, so the by-value / `&` /
/// `.as_deref()` variations the real writers want are part of the line.
///
/// Each `mod name { … }` block generates `db::commands::name`, which `db/mod.rs` (or the
/// module's own file) surfaces at `db::name`, the path commands register under.
///
/// The `extras:` block lists hand-written commands, registered but not generated, so
/// dropping one from it is a compile error at its own call sites rather than a dead button.
fn install<F>(builder: tauri::Builder<tauri::Wry>, handler: F) -> tauri::Builder<tauri::Wry>
where
    F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
{
    #[cfg(feature = "bench")]
    return builder.invoke_handler(crate::bench::wrap(handler));
    #[cfg(not(feature = "bench"))]
    builder.invoke_handler(handler)
}

macro_rules! db_commands {
    (
        extras: [ $($extra:path),* $(,)? ];
        dev_extras: [ $($dev_extra:path),* $(,)? ];
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

        /// The app's entire invoke surface; `lib.rs` lists no commands itself.
        pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
            #[cfg(debug_assertions)]
            return install(builder, tauri::generate_handler![
                $($extra,)*
                $($dev_extra,)*
                $($( $crate::db::$module::$name, )*)*
            ]);
            #[cfg(not(debug_assertions))]
            return install(builder, tauri::generate_handler![
                $($extra,)*
                $($( $crate::db::$module::$name, )*)*
            ]);
        }

        #[cfg(test)]
        pub const EXTRA_COMMANDS: &[&str] = &[$(stringify!($extra)),*];

        /// The declared commands again, reached by name over the e2e bridge. Generated from
        /// the same list as [`register`], so no command reaches one transport and misses the
        /// other; the bridge handles the `extras:` it needs itself.
        #[cfg(feature = "e2e-bridge")]
        pub mod bridge {
            #[allow(unused_imports)]
            use super::prelude::*;
            use crate::e2e_bridge::{arg, reply, Args, Reply};
            use serde_json::Value;

            /// `None` when `command` is not one `db_commands!` declares.
            ///
            /// A command whose call builds the OS keychain is refused: it touches
            /// the machine's real credentials, and most such commands also call a
            /// provider's server. Matching on the declaration rather than a list
            /// means a new such command is refused unasked.
            pub async fn dispatch(
                pool: &sqlx::SqlitePool,
                command: &str,
                mut args: Args,
            ) -> Option<Reply> {
                Some(match command {
                    $($(
                        stringify!($name) => async {
                            if stringify!($($call),*).contains("Keychain") {
                                return Err(Value::String(format!(
                                    "{} reaches the OS keychain, which the e2e bridge refuses",
                                    stringify!($name),
                                )));
                            }
                            $( let $arg: $arg_ty = arg(&mut args, stringify!($arg))?; )*
                            reply($($writer)::+(pool, $($call),*).await)
                        }.await,
                    )*)*
                    _ => return None,
                })
            }
        }

        /// Answer one declared command against a pool with no Tauri runtime; the args object
        /// is what `invoke` sends. `None` for a name this list does not declare (every
        /// `extras` command). Used by `examples/seed_workspace.rs`.
        pub async fn dispatch(
            pool: &sqlx::SqlitePool,
            command: &str,
            args: &serde_json::Value,
        ) -> Option<pikos_db::AppResult<serde_json::Value>> {
            #[allow(unused_imports)]
            use prelude::*;

            match command {
                $($(
                    stringify!($name) => Some(
                        async {
                            $( let $arg: $arg_ty = dispatch_arg(args, stringify!($arg))?; )*
                            let value = $($writer)::+(pool, $($call),*).await?;
                            Ok(serde_json::to_value(value)?)
                        }
                        .await,
                    ),
                )*)*
                _ => None,
            }
        }
    };
}

/// One command argument out of an `invoke` args object, which Tauri keys by
/// the camelCase of the Rust parameter name. A missing key reads as null, so an
/// `Option` parameter the caller left out is `None`, as it is over IPC.
fn dispatch_arg<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    param: &str,
) -> pikos_db::AppResult<T> {
    let mut key = String::with_capacity(param.len());
    let mut upper = false;
    for c in param.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            key.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            key.push(c);
        }
    }
    let value = args.get(&key).cloned().unwrap_or(serde_json::Value::Null);
    Ok(serde_json::from_value(value)?)
}

db_commands! {
    // Commands with a real body, registered here but written where they live. None is a plain
    // pool shim: `connect_db` owns the pool, and `toggle_sync_calendar` is generic over the
    // runtime so a MockRuntime test can invoke it.
    extras: [
        crate::db::connect_db,
        crate::db::assets::init_assets_dir,
        crate::db::assets::save_asset,
        crate::db::assets::save_asset_bytes,
        crate::db::schedules::expand_recurrence_range,
        crate::db::sync::google_sync_available,
        crate::db::sync::connect_google_account,
        crate::db::sync::toggle_sync_calendar,
        crate::db::icloud_settings::icloud_sync_state,
        crate::db::icloud_settings::icloud_sync_set,
        crate::db::icloud_settings::icloud_sync_act,
        crate::db::icloud_settings::icloud_sync_report,
        crate::notifications::scheduler::update_notification_settings,
        crate::notifications::scheduler::request_notification_permission,
        crate::notifications::scheduler::check_notification_permission,
        crate::notifications::scheduler::open_notification_settings,
        crate::notifications::click::replay_pending_notification_clicks,
        crate::db::dev::backup_db,
        crate::db::dev::backup_db_before_import,
        crate::db::dev::list_backups,
        crate::db::dev::restore_backup,
        crate::db::dev::close_damaged_workspace,
        crate::db::dev::export_csv,
        crate::db::dev::export_ics,
        crate::db::dev::export_markdown,
        crate::db::dev::export_page_markdown,
        crate::db::dev::get_usage_stats,
        crate::db::dev::wipe_app_data,
    ];
    // Debug builds only. Each deletes or rewrites data on one call, for the developer
    // menu and the seed scripts, and a release has no business answering it.
    dev_extras: [
        crate::db::dev::backdate_page,
        crate::db::dev::reset_db,
        crate::db::dev::dev_seed_synced_calendar,
    ];

    mod pages {
        get_page(id: String) -> Option<Page> = pikos_db::get_page(&id);
        create_page(data: NewPage) -> Page = create_page_impl(data);
        update_page(id: String, updates: PageUpdate) -> Page = update_page_impl(id, updates);
        pending_description_document(id: String) -> Option<String>
            = pending_description_document_impl(&id);
        clear_pending_description(id: String) -> () = clear_pending_description_impl(&id);
        delete_page(id: String) -> () = delete_page_impl(&id);
        soft_delete_page(id: String) -> () = soft_delete_page_impl(&id);
        restore_page(id: String) -> () = restore_page_impl(&id);
        /// The trash, newest deletion first.
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

    mod windows {
        list_view(key: ViewKey, after: Option<ViewCursor>, limit: u32) -> ViewWindow
            = views::list_view(&key, after.as_ref(), limit as usize);
        list_view_ids(key: ViewKey, after: Option<ViewCursor>, through: Option<ViewCursor>)
            -> Vec<String>
            = views::list_view_ids(&key, after.as_ref(), through.as_ref());
        list_completed_window(
            scope: Option<ViewScope>,
            since: Option<String>,
            after: Option<CompletedCursor>,
            limit: u32,
        ) -> CompletedWindow
            = views::list_completed(scope.as_ref(), since.as_deref(), after.as_ref(), limit as usize);
        list_range(start: Option<String>, end: String, zone: String, open_only: bool)
            -> Vec<PageSummary>
            = reads::list_range(start.as_deref(), &end, &zone, open_only);
        list_series_heads(open_only: bool, since: Option<i64>) -> Vec<PageSummary>
            = reads::list_series_heads(open_only, since);
        count_views(zone: String, today: chrono::NaiveDate) -> ViewCounts
            = reads::count_views(&zone, today);
        get_pages(ids: Vec<String>) -> Vec<PageSummary> = reads::get_pages(&ids);
        get_page_if_newer(id: String, known: Option<i64>) -> PageIfNewer
            = reads::get_page_if_newer(&id, known);
        list_recent_pages(exclude: Option<String>, limit: u32) -> Vec<PageSummary>
            = reads::list_recent_pages(exclude.as_deref(), limit as usize);
        list_tags() -> Vec<TagCount> = reads::list_tags();
        list_backlinks(id: String) -> Vec<PageSummary> = reads::list_backlinks(&id);
        move_pages(ids: Vec<String>, place: Placement) -> MoveOutcome
            = moves::move_pages(&ids, &place);
        change_state() -> ChangeState = changes::change_state();
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

    /// Focus sessions. Write-only from here: `get_usage_stats` aggregates the table.
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

    mod replica {
        record_first_run_seed() -> () = pikos_db::replica::record_seed();
    }

    mod notifications {
        create_page_reminder(data: NewPageReminder) -> PageReminder
            = pikos_db::create_page_reminder(&data.page_id, data.minutes_before);
        list_page_reminders(page_id: String) -> Vec<PageReminder>
            = pikos_db::list_page_reminders(&page_id);
        delete_page_reminder(id: String) -> () = pikos_db::delete_page_reminder(&id);
        delete_page_reminders(page_id: String) -> () = pikos_db::delete_page_reminders(&page_id);
        /// The notification log, newest first: what the scheduler fired, and what quiet hours
        /// silenced. Its only writer is the scheduler.
        list_notification_history(limit: i64) -> Vec<NotificationHistoryEntry>
            = pikos_db::list_notification_history(limit);
    }

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

#[cfg(test)]
mod tests {
    /// The developer commands that delete or rewrite data on one call. Every build registers
    /// `EXTRA_COMMANDS`, so none of these may be in it.
    const DEV_ONLY: &[&str] = &["backdate_page", "reset_db", "dev_seed_synced_calendar"];

    #[test]
    fn a_release_build_registers_no_developer_command() {
        for path in super::EXTRA_COMMANDS {
            let name = path.rsplit("::").next().unwrap().trim();
            assert!(
                !DEV_ONLY.contains(&name),
                "{path} is registered in release builds"
            );
        }
    }

    use serde_json::json;

    use super::dispatch;

    #[tokio::test]
    async fn dispatch_reads_args_by_their_camel_case_ipc_keys() {
        let pool = pikos_db::test_pool().await;
        let created = dispatch(
            &pool,
            "create_folder",
            &json!({ "data": { "name": "Seeded", "parentId": null } }),
        )
        .await
        .expect("create_folder is declared")
        .expect("folder created");
        assert_eq!(created["name"], "Seeded");

        let reordered = dispatch(
            &pool,
            "reorder_folders",
            &json!({ "orderedIds": [created["id"]] }),
        )
        .await
        .expect("reorder_folders is declared");
        assert!(
            reordered.is_ok(),
            "orderedIds must reach ordered_ids: {reordered:?}"
        );
    }

    #[tokio::test]
    async fn dispatch_declines_commands_it_does_not_declare() {
        let pool = pikos_db::test_pool().await;
        assert!(dispatch(&pool, "backdate_page", &json!({})).await.is_none());
        assert!(dispatch(&pool, "no_such_command", &json!({}))
            .await
            .is_none());
    }
}
