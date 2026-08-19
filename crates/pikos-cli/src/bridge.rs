//! The natural-language parser bridge.
//!
//! NLP stays single-sourced in the TS core, so `add` shells to a one-shot `node`
//! subprocess running the `@pikos/bridge` bundle and reads its JSON back. DB work
//! is pure Rust; nothing else in the CLI needs Node.

use std::path::PathBuf;
use std::process::Command as Proc;

use serde::Deserialize;
use serde_json::Value;

use crate::error::CliError;

fn bridge_js() -> Result<PathBuf, CliError> {
    if let Ok(p) = std::env::var("PIKOS_BRIDGE_JS") {
        return Ok(PathBuf::from(p));
    }
    // Candidates relative to the executable, then a dev fallback relative to cwd.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bridge.mjs"));
            candidates.push(dir.join("../bridge/bridge.mjs"));
        }
    }
    candidates.push(PathBuf::from("packages/pikos-bridge/dist/bridge.mjs"));
    candidates.into_iter().find(|p| p.exists()).ok_or_else(|| {
        CliError::internal("parser bridge (bridge.mjs) not found; set PIKOS_BRIDGE_JS to its path")
    })
}

pub fn run_bridge(cmd: &str, payload: &str) -> Result<Value, CliError> {
    let js = bridge_js()?;
    let out = Proc::new("node")
        .arg(&js)
        .arg(cmd)
        .arg(payload)
        .output()
        .map_err(|e| {
            // ENOENT means `node` isn't on PATH. Only `add` hits this path — every
            // other command is DB-only, so steer the user toward those + an install hint.
            if e.kind() == std::io::ErrorKind::NotFound {
                CliError::missing_node(
                    "this command needs Node.js (the NLP parser runs in a one-shot \
                     node subprocess). Install from https://nodejs.org or `brew install node`. \
                     Every other command (list, today, search, read, status, delete, done) \
                     works without Node.",
                )
            } else {
                CliError::internal(format!("failed to run node for the parser bridge: {e}"))
            }
        })?;
    let v: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| CliError::internal("parser bridge returned invalid output"))?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("parser bridge error")
            .to_string();
        return Err(CliError::usage(msg));
    }
    Ok(v)
}

#[derive(Deserialize, Default)]
pub struct ParsedInput {
    #[serde(default)]
    pub title: String,
    #[serde(rename = "scheduledStart")]
    pub scheduled_start: Option<String>,
    #[serde(rename = "scheduledEnd")]
    pub scheduled_end: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(rename = "folderQuery")]
    pub folder_query: Option<String>,
    pub priority: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ParseResult {
    Single { input: ParsedInput },
    Finite { inputs: Vec<ParsedInput> },
    Recurring { input: ParsedInput, rrule: String },
}
