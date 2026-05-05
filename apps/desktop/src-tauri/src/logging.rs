//! Logging setup for the desktop app.
//!
//! See `apps/desktop/src/shared/logger.ts` for the philosophy that both
//! sides follow. The short version, restated here so a Rust-only reader
//! does not have to cross the language boundary:
//!
//! Logs exist to reconstruct a user's session from a bug report. Bias
//! toward silence — anything that ships to disk on every install is a
//! tax on every future bug report.
//!
//! ─── LOG these ─────────────────────────────────────────────────────────
//!
//! 1. Boundaries where errors disappear. Tauri command returns,
//!    `tokio::spawn`'d tasks, scheduler ticks, IPC handlers. If it can
//!    fail and nothing else surfaces the failure to the user, log it.
//! 2. Lifecycle anchors. App start, DB connected, scheduler started,
//!    workspace switched, auto-update events. One INFO line each — these
//!    are the timeline a developer scrolls between when reading a log.
//! 3. Destructive or audit-worthy actions. Reset, mass delete, workspace
//!    switch, export. INFO with counts and destination — never with
//!    content.
//! 4. Silent branches. When code chooses based on env, OS, or stored
//!    preference in a way the user can't see. DEBUG with the choice.
//!
//! ─── DO NOT log ────────────────────────────────────────────────────────
//!
//! - Per-event noise. Per-query SQL, per-tick polls that did nothing,
//!   per-keystroke saves, per-page renders. If it fires more than ~10×
//!   per session, it's noise.
//! - Happy-path success at fine grain ("page saved", "5 results").
//! - User content. Page titles, page text, search queries, user-provided
//!   file paths, tag names. Also: error messages from foreign systems
//!   (sqlite, OS, network) that may echo user input — pass the error
//!   *class* or a stable code, not the formatted `Display` output.
//!
//! ─── Severity ladder ───────────────────────────────────────────────────
//!
//! - ERROR — user-visible failure or silent corruption risk.
//! - WARN  — fallback taken, unexpected state, recoverable.
//! - INFO  — lifecycle anchors and destructive actions only.
//! - DEBUG — diagnostic detail useful in dev. Quiet enough to leave on
//!   while working.
//! - TRACE — per-query SQL, per-tick polls, hot-path reads. Off by
//!   default, opt in via `RUST_LOG`.
//!
//! ─── Structured fields ─────────────────────────────────────────────────
//!
//! `log` doesn't have spans, so use `key=value` field syntax in the
//! message itself. The message string stays app-controlled and short —
//! never interpolate user content (titles, tags, search queries, file
//! paths) into it. IDs and counts are safe; raw error strings from
//! foreign systems are not.
//!
//! Targets follow the module path automatically (`pikos_lib::db`,
//! `pikos_lib::notifications::scheduler`, …). Filter at the target
//! level via `RUST_LOG`.
//!
//! ─── Levels at runtime ─────────────────────────────────────────────────
//!
//! Defaults — release: `pikos_lib=info, *=warn`; dev: `pikos_lib=debug,
//! *=warn`. Override with `RUST_LOG`, e.g.:
//!
//!     RUST_LOG=pikos_lib=debug,sqlx=trace   # firehose for DB debugging
//!     RUST_LOG=pikos_lib::notifications=trace
//!     PIKOS_LOG_VERBOSE=1                   # legacy: pikos_lib=debug, deps=debug
//!
//! `RUST_LOG` wins over `PIKOS_LOG_VERBOSE` and over the defaults.

use log::LevelFilter;
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Build the configured `tauri-plugin-log` plugin. Call once during
/// `tauri::Builder::default().plugin(...)`.
pub fn build_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let verbose = std::env::var("PIKOS_LOG_VERBOSE").is_ok();
    let app_default = if cfg!(debug_assertions) || verbose {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let dep_default = if verbose {
        LevelFilter::Debug
    } else {
        LevelFilter::Warn
    };

    let mut builder = Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some("pikos".into()),
            }),
        ])
        // Dependency crates (sqlx, tao, wry, …) — drops per-query DEBUG flood.
        .level(dep_default)
        // Our crate and the JS-side bridge (target="webview").
        .level_for("pikos_lib", app_default)
        .level_for("webview", app_default)
        // Panic hook target — always surface panics.
        .level_for("panic", LevelFilter::Error)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepOne)
        .timezone_strategy(TimezoneStrategy::UseUtc);

    // RUST_LOG overrides for fine-grained control.
    // Format: "target=level,target=level,…" — anything unparseable is skipped.
    if let Ok(spec) = std::env::var("RUST_LOG") {
        for (target, level) in parse_rust_log(&spec) {
            builder = builder.level_for(target, level);
        }
    }

    builder.build()
}

/// Logs the panic message + location to the structured log file via the `log`
/// facade. tauri-plugin-log captures it and rotates with the rest of the app
/// log. Strips backtraces — `RUST_BACKTRACE` traces can contain absolute paths
/// from the build host, which we never want shipped in user logs.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "(unknown location)".into());
        log::error!(target: "panic", "panicked at {location}: {msg}");
    }));
}

fn parse_rust_log(spec: &str) -> Vec<(String, LevelFilter)> {
    spec.split(',')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let target = parts.next()?.trim();
            let level = parts.next()?.trim();
            if target.is_empty() {
                return None;
            }
            let level = match level.to_ascii_lowercase().as_str() {
                "off" => LevelFilter::Off,
                "error" => LevelFilter::Error,
                "warn" => LevelFilter::Warn,
                "info" => LevelFilter::Info,
                "debug" => LevelFilter::Debug,
                "trace" => LevelFilter::Trace,
                _ => return None,
            };
            Some((target.to_string(), level))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_pair() {
        assert_eq!(
            parse_rust_log("pikos_lib=debug"),
            vec![("pikos_lib".into(), LevelFilter::Debug)]
        );
    }

    #[test]
    fn parses_multiple_pairs() {
        assert_eq!(
            parse_rust_log("pikos_lib=debug,sqlx=trace"),
            vec![
                ("pikos_lib".into(), LevelFilter::Debug),
                ("sqlx".into(), LevelFilter::Trace),
            ]
        );
    }

    #[test]
    fn parses_module_path_target() {
        assert_eq!(
            parse_rust_log("pikos_lib::notifications::scheduler=trace"),
            vec![(
                "pikos_lib::notifications::scheduler".into(),
                LevelFilter::Trace
            )]
        );
    }

    #[test]
    fn skips_unparseable_pairs() {
        // Bare directives ("info") and unknown levels are silently ignored.
        // Bare directives are intentionally not supported — we don't want to
        // raise the global default by accident on a typo.
        assert_eq!(
            parse_rust_log("info,pikos_lib=debug,bogus=loud"),
            vec![("pikos_lib".into(), LevelFilter::Debug)]
        );
    }

    #[test]
    fn handles_whitespace() {
        assert_eq!(
            parse_rust_log(" pikos_lib = debug , sqlx = trace "),
            vec![
                ("pikos_lib".into(), LevelFilter::Debug),
                ("sqlx".into(), LevelFilter::Trace),
            ]
        );
    }

    #[test]
    fn empty_string_yields_nothing() {
        assert!(parse_rust_log("").is_empty());
    }
}
