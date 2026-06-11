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
