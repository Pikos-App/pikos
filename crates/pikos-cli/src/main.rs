//! Pikos CLI — headless access to the local workspace, over the shared
//! `pikos-db` writer. DB work is pure Rust; only the natural-language parser is
//! bridged to the TS core via a one-shot `node` subprocess, so NLP stays
//! single-sourced in TS and the writer in pikos-db. Recurrence math is not
//! bridged — the occurrence-sets model derives the completed occurrence and the
//! next head server-side, in the same transaction as the write.
//!
//! The crate is laid out along that path: [`cli`] parses, [`commands`] dispatches,
//! [`ops`] does the work against [`pikos_db`], and [`render`] prints it.

mod bridge;
mod cli;
mod commands;
mod error;
mod ops;
mod render;
mod schedule;
mod workspace;
mod write;

use clap::Parser;
use serde_json::json;

#[tokio::main]
async fn main() {
    let parsed = cli::Cli::parse();
    let json = parsed.json;
    if let Err(e) = commands::run(parsed).await {
        if json {
            eprintln!(
                "{}",
                json!({ "error": { "kind": e.kind, "message": e.message } })
            );
        } else {
            eprintln!("pikos: {} ({})", e.message, e.kind);
        }
        std::process::exit(e.code);
    }
}
