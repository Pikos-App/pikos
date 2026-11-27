//! Quick Add for the CLI: the Rust parser the phone runs, and the JSON `add --dry-run`
//! prints.
//!
//! The JSON keeps the shape the TypeScript parser gave when the CLI ran it under Node,
//! because agents read it over MCP: an absent field is left out rather than `null`, and
//! `null` is kept for a cleared priority (`!0`).

use chrono::{Local, NaiveDateTime, SubsecRound};
use pikos_core::nlp::quick_add::{parse_input, ParseResult, ParsedInput};
use serde::Serialize;
use serde_json::Value;

use crate::error::CliError;

pub fn parse(text: &str) -> ParseResult {
    parse_input(text, now())
}

/// To the second, as the phone's reference is, so a relative time lands on the same
/// instant either way.
fn now() -> NaiveDateTime {
    Local::now().naive_local().trunc_subsecs(0)
}

pub fn to_json(result: &ParseResult) -> Result<Value, CliError> {
    let preview = match result {
        ParseResult::Single { input } => Preview::Single {
            input: input.into(),
        },
        ParseResult::Finite { inputs } => Preview::Finite {
            inputs: inputs.iter().map(Input::from).collect(),
            count: inputs.len(),
        },
        ParseResult::Recurring { input, rrule } => Preview::Recurring {
            input: input.into(),
            rrule,
        },
    };
    serde_json::to_value(preview).map_err(|_| CliError::internal("could not render the parse"))
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Preview<'a> {
    Single {
        input: Input<'a>,
    },
    Finite {
        inputs: Vec<Input<'a>>,
        count: usize,
    },
    Recurring {
        input: Input<'a>,
        rrule: &'a str,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Input<'a> {
    title: &'a str,
    tags: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    scheduled_start: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scheduled_end: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_query: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<Option<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reminder_minutes: Option<&'a [i64]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<&'a str>,
}

impl<'a> From<&'a ParsedInput> for Input<'a> {
    fn from(input: &'a ParsedInput) -> Self {
        Input {
            title: &input.title,
            tags: &input.tags,
            scheduled_start: input.scheduled_start.as_deref(),
            scheduled_end: input.scheduled_end.as_deref(),
            duration_minutes: input.duration_minutes,
            folder_query: input.folder_query.as_deref(),
            priority: input.priority.map(|p| p.map(|p| p.as_str())),
            reminder_minutes: input.reminder_minutes.as_deref(),
            content: input.content.as_deref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use serde_json::json;

    fn json_of(text: &str) -> Value {
        let sunday_noon = NaiveDate::from_ymd_opt(2026, 3, 15)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        to_json(&parse_input(text, sunday_noon)).unwrap()
    }

    #[test]
    fn an_unwritten_field_is_absent_and_a_cleared_priority_is_null() {
        assert_eq!(
            json_of("call bob"),
            json!({ "type": "single", "input": { "title": "call bob", "tags": [] } })
        );
        assert_eq!(json_of("call bob !0")["input"]["priority"], Value::Null);
        assert!(json_of("call bob !0")["input"]
            .as_object()
            .unwrap()
            .contains_key("priority"));
        assert_eq!(json_of("call bob !high")["input"]["priority"], "high");
    }

    #[test]
    fn a_finite_series_carries_its_count() {
        let finite = json_of("run m/w/f at 3pm");
        assert_eq!(finite["type"], "finite");
        assert_eq!(finite["count"], 3);
        assert_eq!(finite["inputs"].as_array().unwrap().len(), 3);
    }
}
