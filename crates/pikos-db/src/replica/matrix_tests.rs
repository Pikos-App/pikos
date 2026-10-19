//! The iCloud column of `docs/functionality-matrix.md`, as the other device sees it. Each test does
//! one row's operation through the app's own writer on one device, carries it to the other, and
//! checks what that device holds. Each claims its row of the QA checklist's CLOUD section.

use sqlx::SqlitePool;

use crate::moves::{move_pages, Placement};
use crate::reads::list_tags;
use crate::replica::build::{build, pending};
use crate::replica::two_devices::*;
use crate::*;

fn day(offset: i64) -> String {
    let today = chrono::NaiveDate::parse_from_str(&today_local(), "%Y-%m-%d").unwrap();
    (today + chrono::Duration::days(offset))
        .format("%Y-%m-%d")
        .to_string()
}

async fn created(pool: &SqlitePool, page: NewPage) -> String {
    create_page_impl(pool, page).await.unwrap().id
}

async fn edit(pool: &SqlitePool, id: &str, update: PageUpdate) {
    update_page_impl(pool, id.to_owned(), update).await.unwrap();
}

async fn page(pool: &SqlitePool, id: &str) -> Page {
    get_page(pool, id).await.unwrap().unwrap()
}

async fn trashed(pool: &SqlitePool, id: &str) -> bool {
    text(
        pool,
        &format!("SELECT deleted_at FROM pages WHERE id = '{id}'"),
    )
    .await
    .is_some()
}

/// Schedules a page and returns the schedule row's id.
async fn schedule(pool: &SqlitePool, page: &str, start: &str, end: Option<&str>) -> String {
    create_page_schedule_impl(
        pool,
        NewPageSchedule {
            page_id: page.to_owned(),
            scheduled_start: start.to_owned(),
            scheduled_end: end.map(ToOwned::to_owned),
            timezone: Some("UTC".into()),
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap()
    .id
}

async fn reschedule(pool: &SqlitePool, schedule: &str, update: PageScheduleUpdate) {
    update_page_schedule_impl(pool, schedule.to_owned(), update)
        .await
        .unwrap();
}

/// A page's own schedule, start and end, if it has one.
async fn schedule_of(pool: &SqlitePool, page: &str) -> Option<(String, Option<String>)> {
    sqlx::query_as(
        "SELECT scheduled_start, scheduled_end FROM page_schedules
         WHERE page_id = ? AND rule_id IS NULL",
    )
    .bind(page)
    .fetch_optional(pool)
    .await
    .unwrap()
}

/// A page repeating daily from `first` at 09:00, and its rule's id.
async fn repeating(pool: &SqlitePool, title: &str, first: &str, rrule: &str) -> (String, String) {
    let id = created(pool, new_page(title)).await;
    let rule = create_recurrence_rule_impl(
        pool,
        NewRecurrenceRule {
            page_id: id.clone(),
            rrule: rrule.into(),
            rrule_exdates: vec![],
            scheduled_start: format!("{first}T09:00:00"),
            scheduled_end: Some(format!("{first}T09:30:00")),
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
    (id, rule.id)
}

async fn complete_head(pool: &SqlitePool, id: &str) {
    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: id.to_owned(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: None,
        },
    )
    .await
    .unwrap();
}

async fn skip(pool: &SqlitePool, id: &str, date: &str) {
    skip_occurrence_impl(
        pool,
        SkipOccurrenceInput {
            page_id: id.to_owned(),
            occurrence_date: date.to_owned(),
        },
    )
    .await
    .unwrap();
}

async fn dates(pool: &SqlitePool, sql: &str, page: &str) -> Vec<String> {
    sqlx::query_scalar(sql)
        .bind(page)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn done_dates(pool: &SqlitePool, page: &str) -> Vec<String> {
    dates(
        pool,
        "SELECT occurrence_date FROM completed_set WHERE page_id = ? ORDER BY occurrence_date",
        page,
    )
    .await
}

async fn skipped_dates(pool: &SqlitePool, page: &str) -> Vec<String> {
    dates(
        pool,
        "SELECT occurrence_date FROM skip_set WHERE page_id = ? ORDER BY occurrence_date",
        page,
    )
    .await
}

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

// ─── Pages ───────────────────────────────────────────────────────────────────

// qa: CLOUD-03
#[tokio::test]
async fn one_body_edited_on_both_devices_keeps_the_later_save_whole() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Notes")).await;
    converge(&mac, &phone).await;

    let body = |text: &str| {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}]}}"#
        )
    };
    edit(
        &mac,
        &id,
        PageUpdate {
            content: Some(body("from the Mac")),
            ..Default::default()
        },
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    edit(
        &phone,
        &id,
        PageUpdate {
            content: Some(body("from the phone")),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(page(&mac, &id).await.content, body("from the phone"));
}

// qa: CLOUD-04
#[tokio::test]
async fn a_subtitle_reaches_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Dentist")).await;
    converge(&mac, &phone).await;

    edit(
        &mac,
        &id,
        PageUpdate {
            subtitle: Some(serde_json::json!("Bring the forms")),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(
        page(&phone, &id).await.subtitle.as_deref(),
        Some("Bring the forms")
    );
}

// qa: CLOUD-05
#[tokio::test]
async fn a_priority_reaches_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Taxes")).await;
    converge(&mac, &phone).await;

    edit(
        &mac,
        &id,
        PageUpdate {
            priority: Some(3),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(page(&phone, &id).await.priority, 3);
}

// qa: CLOUD-06
#[tokio::test]
async fn tags_added_on_two_devices_both_stay_and_a_removal_travels() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Groceries")).await;
    converge(&mac, &phone).await;

    let tags = |names: &[&str]| PageUpdate {
        tags: Some(names.iter().map(|n| n.to_string()).collect()),
        ..Default::default()
    };
    edit(&mac, &id, tags(&["errands"])).await;
    edit(&phone, &id, tags(&["home"])).await;
    converge(&mac, &phone).await;
    let both = page(&phone, &id).await.tags;
    edit(&mac, &id, tags(&["home"])).await;
    converge(&mac, &phone).await;

    assert_eq!(both, vec!["errands".to_owned(), "home".to_owned()]);
    assert_eq!(page(&phone, &id).await.tags, vec!["home".to_owned()]);
    assert_converged(&mac, &phone).await;
}

async fn folder(pool: &SqlitePool, name: &str) -> String {
    create_folder_impl(
        pool,
        NewFolder {
            name: name.into(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap()
    .id
}

// qa: CLOUD-08, CLOUD-09
#[tokio::test]
async fn a_page_moved_to_another_folder_is_in_it_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let work = folder(&mac, "Work").await;
    let id = created(&mac, new_page("Report")).await;
    converge(&mac, &phone).await;

    edit(
        &mac,
        &id,
        PageUpdate {
            folder_id: Some(serde_json::json!(work)),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(page(&phone, &id).await.folder_id.as_deref(), Some(&*work));
}

// qa: CLOUD-10
#[tokio::test]
async fn a_reordered_list_is_in_the_same_order_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let first = created(&mac, new_page("First")).await;
    let second = created(&mac, new_page("Second")).await;
    let third = created(&mac, new_page("Third")).await;
    converge(&mac, &phone).await;

    move_pages(
        &mac,
        std::slice::from_ref(&third),
        &Placement {
            after: None,
            before: Some(first.clone()),
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    let order = |pool: SqlitePool| async move {
        dates(
            &pool,
            "SELECT id FROM pages WHERE folder_id IS ? ORDER BY sort_order",
            "",
        )
        .await
    };
    let _ = second;
    assert_eq!(order(phone.clone()).await, order(mac.clone()).await);
    assert_converged(&mac, &phone).await;
}

// ─── Schedule ────────────────────────────────────────────────────────────────

// qa: CLOUD-13, CLOUD-14, CLOUD-17
#[tokio::test]
async fn a_new_date_and_time_reach_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Dentist")).await;
    let block = schedule(
        &mac,
        &id,
        "2030-01-10T09:00:00",
        Some("2030-01-10T10:00:00"),
    )
    .await;
    converge(&mac, &phone).await;

    reschedule(
        &mac,
        &block,
        PageScheduleUpdate {
            scheduled_start: Some("2030-01-12T14:30:00".into()),
            scheduled_end: Some(serde_json::json!("2030-01-12T15:30:00")),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(
        schedule_of(&phone, &id).await,
        Some((
            "2030-01-12T14:30:00".into(),
            Some("2030-01-12T15:30:00".into())
        ))
    );
    assert_eq!(
        page(&phone, &id).await.scheduled_start.as_deref(),
        Some("2030-01-12T14:30:00")
    );
}

// qa: CLOUD-15, CLOUD-18
#[tokio::test]
async fn a_new_end_reaches_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Workshop")).await;
    let block = schedule(
        &mac,
        &id,
        "2030-01-10T09:00:00",
        Some("2030-01-10T10:00:00"),
    )
    .await;
    converge(&mac, &phone).await;

    reschedule(
        &mac,
        &block,
        PageScheduleUpdate {
            scheduled_end: Some(serde_json::json!("2030-01-10T11:30:00")),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(
        schedule_of(&phone, &id).await.and_then(|(_, end)| end),
        Some("2030-01-10T11:30:00".into())
    );
}

// qa: CLOUD-16
#[tokio::test]
async fn a_cleared_schedule_leaves_the_page_unscheduled_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Call")).await;
    let block = schedule(&mac, &id, "2030-01-10T09:00:00", None).await;
    converge(&mac, &phone).await;

    delete_page_schedule_impl(&mac, block).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(schedule_of(&phone, &id).await, None);
    assert_eq!(page(&phone, &id).await.scheduled_start, None);
}

// qa: CLOUD-19
#[tokio::test]
async fn a_page_dropped_on_the_calendar_is_scheduled_there_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Gym")).await;
    converge(&mac, &phone).await;

    schedule(
        &mac,
        &id,
        "2030-01-11T07:00:00",
        Some("2030-01-11T08:00:00"),
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(
        page(&phone, &id).await.scheduled_start.as_deref(),
        Some("2030-01-11T07:00:00")
    );
}

// qa: CLOUD-20
#[tokio::test]
async fn reminders_set_changed_and_removed_reach_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Flight")).await;
    schedule(&mac, &id, "2030-01-10T09:00:00", None).await;
    let early = create_page_reminder(&mac, &id, 60).await.unwrap();
    converge(&mac, &phone).await;
    let set = leads(&phone, &id).await;

    create_page_reminder(&mac, &id, 15).await.unwrap();
    delete_page_reminder(&mac, &early.id).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(set, vec![60]);
    assert_eq!(leads(&phone, &id).await, vec![15]);
}

// qa: CLOUD-24
#[tokio::test]
async fn a_floating_time_reads_the_same_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Standup")).await;
    create_page_schedule_impl(
        &mac,
        NewPageSchedule {
            page_id: id.clone(),
            scheduled_start: "2030-01-10T09:00:00".into(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    let zone = text(
        &phone,
        &format!("SELECT timezone FROM page_schedules WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(
        page(&phone, &id).await.scheduled_start.as_deref(),
        Some("2030-01-10T09:00:00")
    );
    assert_eq!(
        zone, None,
        "a floating time carries no zone to convert from"
    );
}

// ─── All-day pages ───────────────────────────────────────────────────────────

// qa: CLOUD-25, CLOUD-27, CLOUD-31, CLOUD-32
#[tokio::test]
async fn an_all_day_span_arrives_on_the_same_days_with_its_inclusive_end() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Trip")).await;
    schedule(&mac, &id, "2030-01-10", Some("2030-01-12")).await;
    converge(&mac, &phone).await;

    assert_eq!(
        schedule_of(&phone, &id).await,
        Some(("2030-01-10".into(), Some("2030-01-12".into())))
    );
}

// qa: CLOUD-26
#[tokio::test]
async fn converting_between_timed_and_all_day_follows_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Errands")).await;
    let block = schedule(&mac, &id, "2030-01-10T09:00:00", None).await;
    converge(&mac, &phone).await;

    reschedule(
        &mac,
        &block,
        PageScheduleUpdate {
            scheduled_start: Some("2030-01-10".into()),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;
    let all_day = schedule_of(&phone, &id).await;
    reschedule(
        &mac,
        &block,
        PageScheduleUpdate {
            scheduled_start: Some("2030-01-10T16:00:00".into()),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(all_day.map(|(start, _)| start), Some("2030-01-10".into()));
    assert_eq!(
        schedule_of(&phone, &id).await.map(|(start, _)| start),
        Some("2030-01-10T16:00:00".into())
    );
}

// qa: CLOUD-28, CLOUD-29, CLOUD-30
#[tokio::test]
async fn a_dragged_and_resized_all_day_span_arrives_moved_and_resized() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Conference")).await;
    let block = schedule(&mac, &id, "2030-01-10", Some("2030-01-11")).await;
    converge(&mac, &phone).await;

    reschedule(
        &mac,
        &block,
        PageScheduleUpdate {
            scheduled_start: Some("2030-01-12".into()),
            scheduled_end: Some(serde_json::json!("2030-01-16")),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(
        schedule_of(&phone, &id).await,
        Some(("2030-01-12".into(), Some("2030-01-16".into())))
    );
}

// qa: CLOUD-33, CLOUD-92
#[tokio::test]
async fn an_all_day_pages_reminder_and_its_day_before_lead_reach_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Birthday")).await;
    schedule(&mac, &id, "2030-01-10", None).await;
    create_page_reminder(&mac, &id, 0).await.unwrap();
    create_page_reminder(&mac, &id, 24 * 60).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(leads(&phone, &id).await, vec![0, 24 * 60]);
}

// qa: CLOUD-35, CLOUD-75
#[tokio::test]
async fn pages_due_today_and_earlier_land_in_the_other_devices_today() {
    let (mac, phone) = (device().await, device().await);
    let today = created(&mac, new_page("Today")).await;
    schedule(&mac, &today, &day(0), None).await;
    let overdue = created(&mac, new_page("Yesterday")).await;
    schedule(&mac, &overdue, &day(-1), None).await;
    let inbox = created(&mac, new_page("Someday")).await;
    converge(&mac, &phone).await;

    let listed: Vec<String> = list_pages_today_impl(&phone)
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();

    assert!(listed.contains(&today), "{listed:?}");
    assert!(listed.contains(&overdue), "{listed:?}");
    let someday = page(&phone, &inbox).await;
    assert_eq!((someday.folder_id, someday.scheduled_start), (None, None));
}

// qa: CLOUD-36
#[tokio::test]
async fn an_all_day_series_arrives_all_day() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Bins out")).await;
    create_recurrence_rule_impl(
        &mac,
        NewRecurrenceRule {
            page_id: id.clone(),
            rrule: "FREQ=WEEKLY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2030-01-07".into(),
            scheduled_end: None,
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(
        page(&phone, &id).await.scheduled_start.as_deref(),
        Some("2030-01-07")
    );
}

// ─── Repeating pages ─────────────────────────────────────────────────────────

// qa: CLOUD-37, CLOUD-51
#[tokio::test]
async fn a_series_arrives_with_the_same_head_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Standup", "2030-01-07", "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(
        page(&phone, &id).await.scheduled_start,
        page(&mac, &id).await.scheduled_start
    );
}

// qa: CLOUD-38, CLOUD-40
#[tokio::test]
async fn a_rule_edited_on_both_devices_keeps_the_later_rule_on_both() {
    let (mac, phone) = (device().await, device().await);
    let (id, rule) = repeating(&mac, "Review", "2030-01-07", "FREQ=DAILY").await;
    converge(&mac, &phone).await;
    let phones_rule = text(
        &phone,
        &format!("SELECT id FROM page_recurrence_rules WHERE page_id = '{id}'"),
    )
    .await
    .unwrap();

    let cadence = |rrule: &str| RecurrenceRuleUpdate {
        rrule: Some(rrule.into()),
        ..Default::default()
    };
    update_recurrence_rule_impl(&mac, rule.clone(), cadence("FREQ=WEEKLY"))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    update_recurrence_rule_impl(&phone, phones_rule, cadence("FREQ=MONTHLY"))
        .await
        .unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let on_mac = text(
        &mac,
        &format!("SELECT rrule FROM page_recurrence_rules WHERE id = '{rule}'"),
    )
    .await;
    assert_eq!(on_mac.as_deref(), Some("FREQ=MONTHLY"));
}

// qa: CLOUD-39
#[tokio::test]
async fn a_page_that_stops_repeating_is_a_one_off_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, rule) = repeating(&mac, "Water plants", "2030-01-07", "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    delete_recurrence_rule_impl(&mac, &rule).await.unwrap();
    converge(&mac, &phone).await;

    let rules = count(
        &phone,
        &format!("SELECT COUNT(*) FROM page_recurrence_rules WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(rules, 0);
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-41, CLOUD-44
#[tokio::test]
async fn completing_an_overdue_head_moves_it_to_the_same_occurrence_on_both() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Journal", &day(-3), "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    complete_head(&mac, &id).await;
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(done_dates(&phone, &id).await, vec![day(-3)]);
    assert_eq!(
        page(&phone, &id).await.scheduled_start,
        page(&mac, &id).await.scheduled_start
    );
}

// qa: CLOUD-42
#[tokio::test]
async fn a_moved_head_is_moved_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, rule) = repeating(&mac, "Piano", "2030-01-07", "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    reschedule_virtual_occurrence_impl(
        &mac,
        RescheduleVirtualInput {
            rule_id: rule,
            original_date: "2030-01-07".into(),
            scheduled_start: "2030-01-07T18:00:00".into(),
            scheduled_end: None,
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(
        page(&phone, &id).await.scheduled_start,
        page(&mac, &id).await.scheduled_start
    );
}

// qa: CLOUD-45, CLOUD-54
#[tokio::test]
async fn just_this_one_leaves_the_backlog_open_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Vitamins", &day(-3), "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    complete_head(&mac, &id).await;
    skip(&mac, &id, &day(-2)).await;
    converge(&mac, &phone).await;

    assert_eq!(done_dates(&phone, &id).await, vec![day(-3)]);
    assert_eq!(skipped_dates(&phone, &id).await, vec![day(-2)]);
    assert_eq!(
        page(&phone, &id)
            .await
            .scheduled_start
            .map(|s| s[..10].to_owned()),
        Some(day(-1))
    );
}

// qa: CLOUD-46
#[tokio::test]
async fn completing_everything_before_today_completes_it_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Stretch", &day(-3), "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    for _ in 0..3 {
        complete_head(&mac, &id).await;
    }
    converge(&mac, &phone).await;

    assert_eq!(
        done_dates(&phone, &id).await,
        vec![day(-3), day(-2), day(-1)]
    );
    assert_eq!(
        page(&phone, &id)
            .await
            .scheduled_start
            .map(|s| s[..10].to_owned()),
        Some(day(0))
    );
}

// qa: CLOUD-47
#[tokio::test]
async fn an_unchecked_done_copy_is_open_again_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Run", &day(-2), "FREQ=DAILY").await;
    complete_head(&mac, &id).await;
    converge(&mac, &phone).await;

    uncomplete_recurring_occurrence_impl(
        &mac,
        UncompleteRecurringInput {
            page_id: id.clone(),
            occurrence_date: day(-2),
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert!(done_dates(&phone, &id).await.is_empty());
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-48, CLOUD-49
#[tokio::test]
async fn a_deleted_and_restored_head_takes_its_series_along_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Laundry", "2030-01-07", "FREQ=WEEKLY").await;
    converge(&mac, &phone).await;

    soft_delete_page_impl(&mac, &id).await.unwrap();
    converge(&mac, &phone).await;
    let was_trashed = trashed(&phone, &id).await;
    restore_page_impl(&mac, &id).await.unwrap();
    converge(&mac, &phone).await;

    assert!(was_trashed);
    assert!(!trashed(&phone, &id).await);
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-50
#[tokio::test]
async fn the_last_occurrence_of_a_series_completed_on_one_device_ends_it_on_both() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Course", &day(-1), "FREQ=DAILY;COUNT=1").await;
    converge(&mac, &phone).await;

    complete_head(&phone, &id).await;
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let (on_mac, on_phone) = (page(&mac, &id).await, page(&phone, &id).await);
    assert_eq!(
        (on_mac.status, on_mac.scheduled_start),
        (on_phone.status, on_phone.scheduled_start)
    );
}

// ─── Occurrences ─────────────────────────────────────────────────────────────

// qa: CLOUD-52, CLOUD-53, CLOUD-55
#[tokio::test]
async fn skipped_occurrences_are_skipped_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Meditate", &day(-3), "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    for offset in [-3, -2, -1] {
        skip(&mac, &id, &day(offset)).await;
    }
    converge(&mac, &phone).await;

    assert_eq!(
        skipped_dates(&phone, &id).await,
        vec![day(-3), day(-2), day(-1)]
    );
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-56
#[tokio::test]
async fn a_moved_occurrence_is_at_its_new_time_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, rule) = repeating(&mac, "Lesson", "2030-01-07", "FREQ=DAILY").await;
    converge(&mac, &phone).await;

    let moved = |start: &str| RescheduleVirtualInput {
        rule_id: rule.clone(),
        original_date: "2030-01-09".into(),
        scheduled_start: start.into(),
        scheduled_end: None,
        timezone: "UTC".into(),
    };
    reschedule_virtual_occurrence_impl(&mac, moved("2030-01-09T17:00:00"))
        .await
        .unwrap();
    converge(&mac, &phone).await;
    reschedule_virtual_occurrence_impl(&mac, moved("2030-01-10T08:00:00"))
        .await
        .unwrap();
    converge(&mac, &phone).await;

    let moved_pages = count(
        &phone,
        "SELECT COUNT(*) FROM pages WHERE scheduled_start = '2030-01-10T08:00:00'",
    )
    .await;
    assert_eq!(moved_pages, 1);
    assert_converged(&mac, &phone).await;
    let _ = id;
}

// qa: CLOUD-64
#[tokio::test]
async fn a_done_copy_moved_and_deleted_follows_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = repeating(&mac, "Swim", &day(-2), "FREQ=DAILY").await;
    complete_head(&mac, &id).await;
    converge(&mac, &phone).await;
    let clone = text(
        &mac,
        &format!("SELECT clone_id FROM completed_set WHERE page_id = '{id}'"),
    )
    .await
    .unwrap();

    edit(
        &mac,
        &clone,
        PageUpdate {
            title: Some("Swim, 40 lengths".into()),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;
    let renamed = page(&phone, &clone).await.title;
    soft_delete_page_impl(&mac, &clone).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(renamed, "Swim, 40 lengths");
    assert!(trashed(&phone, &clone).await);
    assert_converged(&mac, &phone).await;
}

// ─── Detached calendar series ────────────────────────────────────────────────

/// A calendar's daily series that detaches from it, after the provider pinned `pins` (an
/// occurrence date and the time it was moved to) while it was still a mirror.
async fn detached_series(
    pool: &SqlitePool,
    title: &str,
    first: &str,
    pins: &[(&str, &str)],
) -> (String, String) {
    let (id, rule) = repeating(pool, title, first, "FREQ=DAILY").await;
    insert_test_page_sync(pool, &id, "active").await.unwrap();
    for (date, start) in pins {
        sqlx::query(
            "INSERT INTO page_schedules
             (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
             VALUES (?, ?, ?, NULL, 'UTC', ?, ?, 'not_started', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&id)
        .bind(start)
        .bind(&rule)
        .bind(format!("{date}T09:00:00"))
        .bind(now_iso())
        .execute(pool)
        .await
        .unwrap();
    }
    link_state(pool, &id, "detached").await;
    (id, rule)
}

/// Where the occurrence of `date` is pinned, one start per override row.
async fn pinned_at(pool: &SqlitePool, page: &str, date: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT scheduled_start FROM page_schedules
         WHERE page_id = ? AND rule_id IS NOT NULL AND substr(original_date, 1, 10) = ?",
    )
    .bind(page)
    .bind(date)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn complete_occurrence(pool: &SqlitePool, id: &str, date: &str, start: &str) -> String {
    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: id.to_owned(),
            occurrence_date: Some(date.to_owned()),
            scheduled_start: Some(start.to_owned()),
            scheduled_end: None,
            expected_occurrence_date: None,
        },
    )
    .await
    .unwrap()
    .clone
    .id
}

async fn move_occurrence(pool: &SqlitePool, rule: &str, date: &str, start: &str) {
    reschedule_virtual_occurrence_impl(
        pool,
        RescheduleVirtualInput {
            rule_id: rule.to_owned(),
            original_date: date.to_owned(),
            scheduled_start: start.to_owned(),
            scheduled_end: None,
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
}

// qa: CLOUD-57
#[tokio::test]
async fn an_occurrence_completed_in_a_detached_series_is_done_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = detached_series(&mac, "Standup", "2030-01-07", &[]).await;
    converge(&mac, &phone).await;

    let clone = complete_occurrence(&mac, &id, "2030-01-09", "2030-01-09T09:00:00").await;
    converge(&mac, &phone).await;

    assert_eq!(done_dates(&phone, &id).await, vec!["2030-01-09"]);
    let done = page(&phone, &clone).await;
    assert_eq!(
        (done.status.as_str(), done.scheduled_start.as_deref()),
        ("done", Some("2030-01-09T09:00:00"))
    );
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-58
#[tokio::test]
async fn ticking_a_detached_series_with_a_backlog_shows_the_same_ticks_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, _) = detached_series(&mac, "Journal", &day(-3), &[]).await;
    converge(&mac, &phone).await;

    complete_head(&mac, &id).await;
    complete_head(&mac, &id).await;
    converge(&mac, &phone).await;

    assert_eq!(done_dates(&phone, &id).await, vec![day(-3), day(-2)]);
    assert_eq!(
        page(&phone, &id).await.scheduled_start,
        page(&mac, &id).await.scheduled_start
    );
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-59
#[tokio::test]
async fn a_detached_series_arrives_with_its_pinned_occurrence_where_it_was_pinned() {
    let (mac, phone) = (device().await, device().await);
    let pins = [("2030-01-09", "2030-01-09T15:00:00")];
    let (id, _) = detached_series(&mac, "Review", "2030-01-07", &pins).await;
    converge(&mac, &phone).await;

    assert_eq!(
        pinned_at(&phone, &id, "2030-01-09").await,
        vec!["2030-01-09T15:00:00"]
    );
    assert_eq!(
        page(&phone, &id).await.scheduled_start,
        page(&mac, &id).await.scheduled_start
    );
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-60
#[tokio::test]
async fn a_moved_pinned_occurrence_is_at_its_new_time_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let pins = [("2030-01-09", "2030-01-09T15:00:00")];
    let (id, rule) = detached_series(&mac, "Review", "2030-01-07", &pins).await;
    converge(&mac, &phone).await;

    move_occurrence(&mac, &rule, "2030-01-09", "2030-01-10T08:00:00").await;
    converge(&mac, &phone).await;

    assert_eq!(
        pinned_at(&phone, &id, "2030-01-09").await,
        vec!["2030-01-10T08:00:00"]
    );
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-61
#[tokio::test]
async fn a_deleted_pinned_occurrence_is_gone_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let pins = [("2030-01-09", "2030-01-09T15:00:00")];
    let (id, _) = detached_series(&mac, "Review", "2030-01-07", &pins).await;
    converge(&mac, &phone).await;

    skip(&mac, &id, "2030-01-09").await;
    converge(&mac, &phone).await;

    assert_eq!(skipped_dates(&phone, &id).await, vec!["2030-01-09"]);
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-62
#[tokio::test]
async fn a_completed_pinned_occurrence_is_done_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let pins = [("2030-01-09", "2030-01-09T15:00:00")];
    let (id, _) = detached_series(&mac, "Review", "2030-01-07", &pins).await;
    converge(&mac, &phone).await;

    let clone = complete_occurrence(&mac, &id, "2030-01-09", "2030-01-09T15:00:00").await;
    converge(&mac, &phone).await;

    assert_eq!(done_dates(&phone, &id).await, vec!["2030-01-09"]);
    let done = page(&phone, &clone).await;
    assert_eq!(
        (done.status.as_str(), done.scheduled_start.as_deref()),
        ("done", Some("2030-01-09T15:00:00"))
    );
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-63
#[tokio::test]
async fn a_detached_series_relinked_after_a_move_leaves_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let (id, rule) = detached_series(&mac, "Planning", "2030-01-07", &[]).await;
    move_occurrence(&mac, &rule, "2030-01-09", "2030-01-09T17:00:00").await;
    converge(&mac, &phone).await;
    let arrived = pinned_at(&phone, &id, "2030-01-09").await;

    link_state(&mac, &id, "active").await;
    converge(&mac, &phone).await;

    assert_eq!(arrived, vec!["2030-01-09T17:00:00"]);
    assert!(get_page(&phone, &id).await.unwrap().is_none());
    let left_behind = count(
        &phone,
        &format!("SELECT COUNT(*) FROM page_schedules WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(left_behind, 0);
    assert!(get_page(&mac, &id).await.unwrap().is_some());
}

// ─── Folders ─────────────────────────────────────────────────────────────────

async fn folder_name_and_color(pool: &SqlitePool, id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT name, color FROM folders WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or((None, None))
}

// qa: CLOUD-66, CLOUD-67, CLOUD-68
#[tokio::test]
async fn a_folder_created_renamed_and_recolored_follows_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = folder(&mac, "Home").await;
    converge(&mac, &phone).await;
    let arrived = folder_name_and_color(&phone, &id).await;

    update_folder_impl(
        &mac,
        id.clone(),
        FolderUpdate {
            name: Some("House".into()),
            color: Some(serde_json::json!("blue")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_eq!(arrived, (Some("Home".into()), None));
    assert_eq!(
        folder_name_and_color(&phone, &id).await,
        (Some("House".into()), Some("blue".into()))
    );
}

// qa: CLOUD-69:2
#[tokio::test]
async fn a_deleted_folder_and_its_pages_are_in_the_other_devices_trash() {
    let (mac, phone) = (device().await, device().await);
    let id = folder(&mac, "Old project").await;
    let inside = created(
        &mac,
        NewPage {
            folder_id: Some(id.clone()),
            ..new_page("Notes")
        },
    )
    .await;
    converge(&mac, &phone).await;

    soft_delete_folder_impl(&mac, id.clone()).await.unwrap();
    converge(&mac, &phone).await;

    let trashed_folder = count(
        &phone,
        &format!("SELECT COUNT(*) FROM folders WHERE id = '{id}' AND deleted_at IS NOT NULL"),
    )
    .await;
    assert_eq!(trashed_folder, 1);
    assert!(trashed(&phone, &inside).await);
    assert_converged(&mac, &phone).await;
}

// ─── Everywhere else ─────────────────────────────────────────────────────────

// qa: CLOUD-74
#[tokio::test]
async fn opening_a_page_doesnt_change_the_other_devices_recent_pages() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Recipe")).await;
    converge(&mac, &phone).await;

    edit(
        &mac,
        &id,
        PageUpdate {
            last_opened_at: Some(serde_json::json!("2030-01-10T08:00:00")),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    assert_eq!(page(&phone, &id).await.last_opened_at, None);
}

// qa: CLOUD-76, CLOUD-90
#[tokio::test]
async fn exporting_sends_nothing() {
    let (mac, phone) = (device().await, device().await);
    created(&mac, new_page("Notes")).await;
    converge(&mac, &phone).await;

    plan_markdown_export(&mac, false).await.unwrap();
    build_export_ics(&mac, false).await.unwrap();

    assert!(pending(&mac, 10).await.unwrap().is_empty());
}

// qa: CLOUD-77
#[tokio::test]
async fn imported_pages_arrive_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let imported = folder(&mac, "Imported").await;
    let mut ids = Vec::new();
    for title in ["One", "Two", "Three"] {
        ids.push(
            created(
                &mac,
                NewPage {
                    folder_id: Some(imported.clone()),
                    ..new_page(title)
                },
            )
            .await,
        );
    }
    converge(&mac, &phone).await;

    for id in &ids {
        assert_eq!(
            page(&phone, id).await.folder_id.as_deref(),
            Some(&*imported)
        );
    }
}

// qa: CLOUD-82:2
#[tokio::test]
async fn the_trash_sweep_removes_a_page_everywhere() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Old")).await;
    soft_delete_page_impl(&mac, &id).await.unwrap();
    sqlx::query("UPDATE pages SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
        .bind(&id)
        .execute(&mac)
        .await
        .unwrap();
    converge(&mac, &phone).await;

    let swept = purge_trashed_pages_older_than(&mac, TRASH_RETENTION_DAYS)
        .await
        .unwrap();
    converge(&mac, &phone).await;

    assert_eq!(swept, 1);
    assert!(get_page(&phone, &id).await.unwrap().is_none());
}

// qa: CLOUD-83, CLOUD-84
#[tokio::test]
async fn arriving_tags_are_counted_and_searchable_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(
        &mac,
        NewPage {
            tags: vec!["errands".into()],
            ..new_page("Groceries")
        },
    )
    .await;
    created(
        &mac,
        NewPage {
            tags: vec!["errands".into()],
            ..new_page("Pharmacy")
        },
    )
    .await;
    converge(&mac, &phone).await;

    let tags = list_tags(&phone).await.unwrap();
    let found = search_pages_impl(&phone, "#errands groceries".into(), None)
        .await
        .unwrap();

    assert!(
        tags.iter()
            .any(|t| t.name == "errands" && t.page_count == 2),
        "{:?}",
        tags.iter()
            .map(|t| (&t.name, t.page_count))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        found.results.iter().map(|r| &r.id).collect::<Vec<_>>(),
        vec![&id]
    );
}

// qa: CLOUD-85, CLOUD-89
#[tokio::test]
async fn pages_ahead_arrive_on_their_days_for_upcoming_and_the_month() {
    let (mac, phone) = (device().await, device().await);
    let soon = created(&mac, new_page("Soon")).await;
    schedule(&mac, &soon, &format!("{}T10:00:00", day(3)), None).await;
    let span = created(&mac, new_page("Holiday")).await;
    schedule(&mac, &span, &day(10), Some(&day(14))).await;
    converge(&mac, &phone).await;

    assert_eq!(
        page(&phone, &soon).await.scheduled_start,
        Some(format!("{}T10:00:00", day(3)))
    );
    let holiday = page(&phone, &span).await;
    assert_eq!(
        (holiday.scheduled_start, holiday.scheduled_end),
        (Some(day(10)), Some(day(14)))
    );
}

// qa: CLOUD-86
#[tokio::test]
async fn overdue_pages_moved_to_today_are_due_today_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let mut overdue = Vec::new();
    for title in ["Call bank", "Reply to Sam"] {
        let id = created(&mac, new_page(title)).await;
        let block = schedule(&mac, &id, &day(-2), None).await;
        overdue.push((id, block));
    }
    converge(&mac, &phone).await;

    for (_, block) in &overdue {
        reschedule(
            &mac,
            block,
            PageScheduleUpdate {
                scheduled_start: Some(day(0)),
                ..Default::default()
            },
        )
        .await;
    }
    converge(&mac, &phone).await;

    for (id, _) in &overdue {
        assert_eq!(
            page(&phone, id).await.scheduled_start.as_deref(),
            Some(&*day(0))
        );
    }
}

// qa: CLOUD-87
#[tokio::test]
async fn several_pages_completed_moved_and_deleted_together_follow_on_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let work = folder(&mac, "Work").await;
    let ids: Vec<String> = {
        let mut ids = Vec::new();
        for title in ["A", "B", "C", "D"] {
            ids.push(created(&mac, new_page(title)).await);
        }
        ids
    };
    converge(&mac, &phone).await;

    set_pages_status_impl(&mac, &ids[0..2], "done", Some("2030-01-10T09:00:00"))
        .await
        .unwrap();
    for id in &ids[2..4] {
        edit(
            &mac,
            id,
            PageUpdate {
                folder_id: Some(serde_json::json!(work)),
                ..Default::default()
            },
        )
        .await;
    }
    soft_delete_page_impl(&mac, &ids[3]).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(page(&phone, &ids[0]).await.status, "done");
    assert_eq!(page(&phone, &ids[1]).await.status, "done");
    assert_eq!(
        page(&phone, &ids[2]).await.folder_id.as_deref(),
        Some(&*work)
    );
    assert!(trashed(&phone, &ids[3]).await);
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-91
#[tokio::test]
async fn notifications_fired_on_one_device_arent_in_the_other_devices_history() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Pills")).await;
    schedule(&mac, &id, "2030-01-10T08:00:00", None).await;
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, type, fired_at)
         VALUES ('n1', ?, 'reminder', '2030-01-10T07:45:00')",
    )
    .bind(&id)
    .execute(&mac)
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_eq!(
        count(&phone, "SELECT COUNT(*) FROM notification_log").await,
        0
    );
}

// qa: CLOUD-80
#[tokio::test]
async fn a_reminder_fired_on_one_device_fires_once_on_the_other_and_not_again_on_the_first() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Pills")).await;
    schedule(&mac, &id, "2030-01-10T09:00:00", None).await;
    create_page_reminder(&mac, &id, 15).await.unwrap();
    converge(&mac, &phone).await;
    let fire = chrono::NaiveDateTime::parse_from_str("2030-01-10T08:45:30", "%Y-%m-%dT%H:%M:%S")
        .unwrap();
    let tick = ReminderWindow::for_test(fire, fire.and_utc());

    let fired = due_explicit_reminders(&mac, &tick).await.unwrap();
    for reminder in &fired {
        log_reminder_fired(&mac, &id, &reminder.schedule_id, "2030-01-10T08:45:00")
            .await
            .unwrap();
    }
    edit(
        &phone,
        &id,
        PageUpdate {
            title: Some("Pills, with food".into()),
            ..Default::default()
        },
    )
    .await;
    converge(&mac, &phone).await;

    let planned = upcoming_reminders(
        &phone,
        (fire - chrono::Duration::hours(1)).and_utc(),
        chrono_tz::UTC,
        chrono::Duration::days(1),
        10,
    )
    .await
    .unwrap();
    assert_eq!(fired.len(), 1);
    assert!(due_explicit_reminders(&mac, &tick).await.unwrap().is_empty());
    assert_eq!(
        planned
            .iter()
            .map(|r| (r.page_id.as_str(), r.fire_at.as_str()))
            .collect::<Vec<_>>(),
        vec![(id.as_str(), "2030-01-10T08:45:00")]
    );
}

// qa: CLOUD-93
#[tokio::test]
async fn a_finished_focus_session_reaches_the_other_device() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Essay")).await;
    converge(&mac, &phone).await;

    create_focus_session(
        &mac,
        &id,
        "2030-01-10T09:00:00",
        "2030-01-10T09:25:00",
        1500,
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    let sessions = count(
        &phone,
        &format!("SELECT COUNT(*) FROM focus_sessions WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(sessions, 1);
}

// ─── Calendar accounts and their events ──────────────────────────────────────

// qa: CLOUD-95, CLOUD-96, CLOUD-100, CLOUD-101
#[tokio::test]
async fn a_calendars_edits_to_a_live_mirror_are_never_sent() {
    let (mac, phone) = (device().await, device().await);
    insert_test_page(&mac, TestPage::new("mirror", "Team sync"))
        .await
        .unwrap();
    insert_test_page_sync(&mac, "mirror", "active")
        .await
        .unwrap();
    converge(&mac, &phone).await;

    for upstream in [
        "UPDATE pages SET title = 'Team sync, moved', subtitle = 'Room 4' WHERE id = 'mirror'",
        "UPDATE pages SET scheduled_start = '2030-01-10T15:00:00' WHERE id = 'mirror'",
        "UPDATE pages SET content = '{\"type\":\"doc\"}' WHERE id = 'mirror'",
    ] {
        sqlx::query(upstream).execute(&mac).await.unwrap();
        let queued = pending(&mac, 10).await.unwrap();
        let built = build(&mac, &queued).await.unwrap();
        assert!(built.is_empty(), "{upstream}");
    }
    converge(&mac, &phone).await;

    assert!(get_page(&phone, "mirror").await.unwrap().is_none());
}

// qa: CLOUD-97, CLOUD-99
#[tokio::test]
async fn a_calendar_removing_a_live_mirror_sends_nothing() {
    let mac = device().await;
    insert_test_page(&mac, TestPage::new("mirror", "Standup"))
        .await
        .unwrap();
    insert_test_page_sync(&mac, "mirror", "active")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES ('alert', 'mirror', 10, '2030-01-01T00:00:00Z')",
    )
    .execute(&mac)
    .await
    .unwrap();
    let queued = pending(&mac, 100).await.unwrap();
    build(&mac, &queued).await.unwrap();

    for upstream in [
        "DELETE FROM page_reminders WHERE id = 'alert'",
        "DELETE FROM pages WHERE id = 'mirror'",
    ] {
        sqlx::query(upstream).execute(&mac).await.unwrap();
        let queued = pending(&mac, 10).await.unwrap();
        let built = build(&mac, &queued).await.unwrap();
        assert!(built.is_empty(), "{upstream} sent {:?}", queued);
    }
}

// qa: CLOUD-72, CLOUD-102, CLOUD-103, CLOUD-105, CLOUD-106, CLOUD-107, CLOUD-108
#[tokio::test]
async fn a_calendar_account_and_its_folders_stay_on_their_device() {
    let (mac, phone) = (device().await, device().await);
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('acct', 'caldav', 'Work', 'basic', '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')",
    )
    .execute(&mac)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO folders (id, name, sort_order, is_external_calendar, created_at, updated_at)
         VALUES ('cal', 'Work calendar', 0, 1, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')",
    )
    .execute(&mac)
    .await
    .unwrap();
    sqlx::query("UPDATE sync_account SET display_name = 'Work (reconnected)' WHERE id = 'acct'")
        .execute(&mac)
        .await
        .unwrap();
    converge(&mac, &phone).await;

    assert_eq!(count(&phone, "SELECT COUNT(*) FROM sync_account").await, 0);
    assert_eq!(
        count(&phone, "SELECT COUNT(*) FROM folders WHERE id = 'cal'").await,
        0
    );
}

// ─── Settings ────────────────────────────────────────────────────────────────

// qa: CLOUD-121
#[tokio::test]
async fn changes_made_while_sync_was_off_reach_the_other_device_once_it_is_back_on() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Packing list")).await;
    converge(&mac, &phone).await;

    crate::replica::set_paused(&mac, true).await.unwrap();
    edit(
        &mac,
        &id,
        PageUpdate {
            title: Some("Packing list, Lisbon".into()),
            ..Default::default()
        },
    )
    .await;
    crate::replica::set_paused(&mac, false).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(page(&phone, &id).await.title, "Packing list, Lisbon");
}

// ─── Long absences ───────────────────────────────────────────────────────────

// qa: CLOUD-125
#[tokio::test]
async fn a_device_back_after_the_retention_window_sends_back_what_it_kept() {
    let (mac, phone) = (device().await, device().await);
    let id = created(&mac, new_page("Old notes")).await;
    converge(&mac, &phone).await;
    let long_ago = (chrono::Utc::now()
        - chrono::Duration::days(crate::replica::RETENTION_DAYS + 10))
    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
    .to_string();
    sqlx::query("UPDATE replica_meta SET last_fetch_at = ? WHERE id = 1")
        .bind(&long_ago)
        .execute(&phone)
        .await
        .unwrap();

    hard_delete_page_impl(&mac, &id).await.unwrap();
    crate::replica::build::sent(
        &mac,
        &crate::replica::build::build(&mac, &pending(&mac, 100).await.unwrap())
            .await
            .unwrap()
            .into_iter()
            .map(|b| (b.name, b.clock))
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    let past_retention = chrono::Utc::now().timestamp_millis()
        - (crate::replica::RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000;
    sqlx::query("UPDATE replica_clocks SET tomb_at = ? WHERE tomb IS NOT NULL")
        .bind(past_retention)
        .execute(&mac)
        .await
        .unwrap();
    crate::replica::expire(&mac).await.unwrap();
    let zone =
        pikos_replica::zone::zone_name(&crate::replica::meta(&phone).await.unwrap().workspace_id);
    crate::replica::join(&phone, &[zone]).await.unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert!(get_page(&mac, &id).await.unwrap().is_some());
}

#[tokio::test]
async fn a_device_back_after_the_retention_window_forgets_the_transports_copies() {
    let phone = device().await;
    created(&phone, new_page("Old notes")).await;
    let names = pending(&phone, 100).await.unwrap();
    let built = build(&phone, &names).await.unwrap();
    crate::replica::build::save_system_fields(
        &phone,
        &built
            .iter()
            .map(|b| (b.name.clone(), b"change tag".to_vec()))
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    let long_ago = (chrono::Utc::now()
        - chrono::Duration::days(crate::replica::RETENTION_DAYS + 10))
    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
    .to_string();
    sqlx::query("UPDATE replica_meta SET last_fetch_at = ? WHERE id = 1")
        .bind(&long_ago)
        .execute(&phone)
        .await
        .unwrap();
    let zone =
        pikos_replica::zone::zone_name(&crate::replica::meta(&phone).await.unwrap().workspace_id);

    crate::replica::join(&phone, &[zone]).await.unwrap();

    assert_eq!(
        count(
            &phone,
            "SELECT COUNT(*) FROM replica_clocks WHERE system_fields IS NOT NULL"
        )
        .await,
        0
    );
}
