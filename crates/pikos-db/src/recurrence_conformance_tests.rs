//! Recurrence-lifecycle conformance — the Rust half of a second shared table.
//!
//! Same contract as [`crate::sync_conformance_tests`], aimed at the occurrence sets:
//! completion, skip, exdates, and the two arms of a moved occurrence. Every scenario
//! runs the one series declared at the top of the fixture, against one of three
//! origins — native, an active mirror, a detached one — because origin is what picks
//! the arm in almost all of this code, and the mock has to pick the same one.

use serde::Deserialize;

use crate::pages::{
    complete_recurring_page_impl, recompute_recurring_schedules_impl,
    reschedule_virtual_occurrence_impl, skip_occurrence_impl, uncomplete_recurring_occurrence_impl,
    undo_skip_occurrence_impl, CompleteRecurringInput, RescheduleVirtualInput, SkipOccurrenceInput,
    UncompleteRecurringInput,
};
use crate::pool::{insert_test_page, insert_test_page_sync, test_pool, TestPage};
use crate::schedules::{
    add_rule_exdates_impl, create_recurrence_rule_impl, get_recurrence_rule_impl,
    remove_rule_exdate_impl, NewRecurrenceRule,
};

const TABLE: &str = include_str!("../tests/fixtures/recurrence-lifecycle.json");

const PAGE_ID: &str = "head-1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    series: Series,
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Series {
    rrule: String,
    start: String,
    end: String,
    timezone: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    name: String,
    origin: Origin,
    /// Replaces the table-level series for this row, for a shape the shared one
    /// can't carry — a span running over more than one day, say.
    series: Option<Series>,
    steps: Vec<Step>,
    expect: Expect,
}

#[derive(Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Origin {
    Native,
    Active,
    Detached,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Step {
    #[serde(rename_all = "camelCase")]
    Complete {
        occurrence_date: Option<String>,
        scheduled_start: Option<String>,
        scheduled_end: Option<String>,
        #[serde(default)]
        expected_occurrence_date: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Uncomplete {
        occurrence_date: String,
    },
    #[serde(rename_all = "camelCase")]
    Skip {
        occurrence_date: String,
    },
    #[serde(rename_all = "camelCase")]
    UndoSkip {
        occurrence_date: String,
    },
    AddExdates {
        dates: Vec<String>,
    },
    RemoveExdate {
        date: String,
    },
    #[serde(rename_all = "camelCase")]
    Reschedule {
        original_date: String,
        scheduled_start: String,
        scheduled_end: Option<String>,
    },
    /// What a session left open across midnight leaves behind: a head the derivation
    /// no longer agrees with. Nothing in the adapter surface can produce one, and it
    /// is the only state the foreground heal exists to fix.
    #[serde(rename_all = "camelCase")]
    StaleHead {
        scheduled_start: String,
    },
    Recompute,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expect {
    head: Option<HeadExpect>,
    completed_dates: Option<Vec<String>>,
    skipped_dates: Option<Vec<String>>,
    exdates: Option<Vec<String>>,
    clones: Option<Vec<CloneExpect>>,
    clone_count: Option<usize>,
    override_count: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeadExpect {
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloneExpect {
    scheduled_start: String,
    status: String,
}

#[tokio::test]
async fn writers_satisfy_the_recurrence_lifecycle_table() {
    let table: Table = serde_json::from_str(TABLE).expect("recurrence-lifecycle.json parses");
    assert!(!table.scenarios.is_empty());
    for scenario in &table.scenarios {
        run(scenario.series.as_ref().unwrap_or(&table.series), scenario).await;
    }
}

async fn run(series: &Series, scenario: &Scenario) {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            scheduled_start: Some(&series.start),
            scheduled_end: Some(&series.end),
            ..TestPage::new(PAGE_ID, "Standup")
        },
    )
    .await
    .unwrap();
    // Rule first, sync link second. A synced series' rule is reconciler-written, and
    // the command path refuses to author one on a locked mirror — same stored rule
    // either way, so the fixture takes the order the command path allows.
    let rule = create_recurrence_rule_impl(
        &pool,
        NewRecurrenceRule {
            page_id: PAGE_ID.into(),
            rrule: series.rrule.clone(),
            rrule_exdates: vec![],
            scheduled_start: series.start.clone(),
            scheduled_end: Some(series.end.clone()),
            timezone: series.timezone.clone(),
        },
    )
    .await
    .unwrap();
    match scenario.origin {
        Origin::Native => {}
        Origin::Active => insert_test_page_sync(&pool, PAGE_ID, "active")
            .await
            .unwrap(),
        Origin::Detached => insert_test_page_sync(&pool, PAGE_ID, "detached")
            .await
            .unwrap(),
    }

    for step in &scenario.steps {
        apply(&pool, &rule.id, series, step).await;
    }
    check(&pool, scenario).await;
}

async fn apply(pool: &sqlx::SqlitePool, rule_id: &str, series: &Series, step: &Step) {
    match step {
        Step::Complete {
            occurrence_date,
            scheduled_start,
            scheduled_end,
            expected_occurrence_date,
        } => {
            complete_recurring_page_impl(
                pool,
                CompleteRecurringInput {
                    page_id: PAGE_ID.into(),
                    occurrence_date: occurrence_date.clone(),
                    scheduled_start: scheduled_start.clone(),
                    scheduled_end: scheduled_end.clone(),
                    expected_occurrence_date: expected_occurrence_date.clone(),
                },
            )
            .await
            .unwrap();
        }

        Step::Uncomplete { occurrence_date } => {
            uncomplete_recurring_occurrence_impl(
                pool,
                UncompleteRecurringInput {
                    page_id: PAGE_ID.into(),
                    occurrence_date: occurrence_date.clone(),
                },
            )
            .await
            .unwrap();
        }

        Step::Skip { occurrence_date } => {
            skip_occurrence_impl(
                pool,
                SkipOccurrenceInput {
                    page_id: PAGE_ID.into(),
                    occurrence_date: occurrence_date.clone(),
                },
            )
            .await
            .unwrap();
        }

        Step::UndoSkip { occurrence_date } => {
            undo_skip_occurrence_impl(
                pool,
                SkipOccurrenceInput {
                    page_id: PAGE_ID.into(),
                    occurrence_date: occurrence_date.clone(),
                },
            )
            .await
            .unwrap();
        }

        Step::AddExdates { dates } => {
            add_rule_exdates_impl(pool, rule_id.to_string(), dates.clone())
                .await
                .unwrap();
        }

        Step::RemoveExdate { date } => {
            remove_rule_exdate_impl(pool, rule_id.to_string(), date.clone())
                .await
                .unwrap();
        }

        Step::Reschedule {
            original_date,
            scheduled_start,
            scheduled_end,
        } => {
            reschedule_virtual_occurrence_impl(
                pool,
                RescheduleVirtualInput {
                    rule_id: rule_id.into(),
                    original_date: original_date.clone(),
                    scheduled_start: scheduled_start.clone(),
                    scheduled_end: scheduled_end.clone(),
                    timezone: series.timezone.clone(),
                },
            )
            .await
            .unwrap();
        }

        Step::StaleHead { scheduled_start } => {
            sqlx::query("UPDATE pages SET scheduled_start = ? WHERE id = ?")
                .bind(scheduled_start)
                .bind(PAGE_ID)
                .execute(pool)
                .await
                .unwrap();
        }

        Step::Recompute => {
            recompute_recurring_schedules_impl(pool).await.unwrap();
        }
    }
}

async fn check(pool: &sqlx::SqlitePool, scenario: &Scenario) {
    let at = &scenario.name;
    let expect = &scenario.expect;

    if let Some(want) = &expect.head {
        let (start, end, status): (Option<String>, Option<String>, String) =
            sqlx::query_as("SELECT scheduled_start, scheduled_end, status FROM pages WHERE id = ?")
                .bind(PAGE_ID)
                .fetch_one(pool)
                .await
                .unwrap();
        if let Some(want_start) = &want.scheduled_start {
            assert_eq!(
                start.as_deref(),
                Some(want_start.as_str()),
                "{at}: head start"
            );
        }
        if let Some(want_end) = &want.scheduled_end {
            assert_eq!(end.as_deref(), Some(want_end.as_str()), "{at}: head end");
        }
        if let Some(want_status) = &want.status {
            assert_eq!(&status, want_status, "{at}: head status");
        }
    }

    if let Some(want) = &expect.completed_dates {
        let got: Vec<String> = sqlx::query_scalar(
            "SELECT occurrence_date FROM completed_set WHERE page_id = ? ORDER BY occurrence_date",
        )
        .bind(PAGE_ID)
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(&got, want, "{at}: completed set");
    }

    if let Some(want) = &expect.skipped_dates {
        let got: Vec<String> = sqlx::query_scalar(
            "SELECT occurrence_date FROM skip_set WHERE page_id = ? ORDER BY occurrence_date",
        )
        .bind(PAGE_ID)
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(&got, want, "{at}: skip set");
    }

    if let Some(want) = &expect.exdates {
        let rule = get_recurrence_rule_impl(pool, PAGE_ID).await.unwrap();
        let got = rule.map(|r| r.rrule_exdates).unwrap_or_default();
        assert_eq!(&got, want, "{at}: rule exdates");
    }

    // Every page but the head is something a step minted — a completion clone or a
    // native occurrence that left the series.
    let clones: Vec<(Option<String>, String)> = sqlx::query_as(
        "SELECT scheduled_start, status FROM pages
         WHERE id <> ? AND deleted_at IS NULL ORDER BY scheduled_start",
    )
    .bind(PAGE_ID)
    .fetch_all(pool)
    .await
    .unwrap();

    if let Some(want) = expect.clone_count {
        assert_eq!(clones.len(), want, "{at}: clones");
    }
    if let Some(want) = &expect.clones {
        assert_eq!(clones.len(), want.len(), "{at}: clones");
        for (got, want) in clones.iter().zip(want) {
            assert_eq!(
                got.0.as_deref(),
                Some(want.scheduled_start.as_str()),
                "{at}: clone start"
            );
            assert_eq!(got.1, want.status, "{at}: clone status");
        }
    }

    if let Some(want) = expect.override_count {
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM page_schedules WHERE page_id = ? AND original_date IS NOT NULL",
        )
        .bind(PAGE_ID)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(n as usize, want, "{at}: override rows");
    }
}
