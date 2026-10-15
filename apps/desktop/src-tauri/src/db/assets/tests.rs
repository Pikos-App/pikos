use super::*;

#[test]
fn validate_image_ext_accepts_allowed_lowercase() {
    for ext in ALLOWED_IMAGE_EXTENSIONS {
        assert_eq!(validate_image_ext(ext).unwrap(), ext);
    }
}

#[test]
fn validate_image_ext_normalizes_case() {
    assert_eq!(validate_image_ext("PNG").unwrap(), "png");
    assert_eq!(validate_image_ext("JpEg").unwrap(), "jpeg");
}

#[test]
fn validate_image_ext_rejects_unknown_format() {
    let err = validate_image_ext("exe").unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
    let msg = format!("{err}");
    assert!(msg.contains("exe"), "error message should echo extension");
}

#[test]
fn validate_image_ext_rejects_empty() {
    assert!(validate_image_ext("").is_err());
}

#[test]
fn ext_from_path_extracts_lowercased() {
    assert_eq!(ext_from_path(Path::new("/tmp/foo.PNG")), "png");
    assert_eq!(ext_from_path(Path::new("relative/bar.jpeg")), "jpeg");
}

#[test]
fn ext_from_path_falls_back_to_bin() {
    assert_eq!(ext_from_path(Path::new("/tmp/no-extension")), "bin");
}

#[test]
fn ext_from_path_handles_multiple_dots() {
    // Should pick up the trailing extension, not the first segment.
    assert_eq!(ext_from_path(Path::new("/tmp/foo.bar.png")), "png");
}

// ── save_asset_into_dir (the filesystem core of save_asset) ────────────────────
// These cover the copy path that the validate_image_ext / ext_from_path unit
// tests don't: a real file is copied into a UUID-named entry under the assets
// dir, and the failure modes (missing source, bad extension) surface the right
// AppError. The AppHandle / app_data_dir() wiring around this is trivial glue
// and stays out of scope (it would need a MockRuntime writing to real app-data).

/// Unique temp dir per test — they run in parallel and share temp_dir().
fn unique_tmp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pkos_asset_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn save_asset_copies_into_assets_dir_with_uuid_name() {
    let dir = unique_tmp_dir();
    let source = dir.join("photo.PNG");
    std::fs::write(&source, b"\x89PNG fake bytes").unwrap();

    let assets_dir = dir.join("assets");
    let saved = save_asset_into_dir(&assets_dir, &source.to_string_lossy())
        .await
        .unwrap();

    let name = saved
        .strip_prefix("assets/")
        .expect("the stored path is relative to the app data dir");
    // Extension is normalized to lowercase; filename is a fresh UUID, not the source name.
    assert!(is_pikos_asset_name(name), "{name}");
    assert!(name.ends_with(".png"));
    // Bytes are copied faithfully.
    assert_eq!(
        std::fs::read(resolve_asset_path(&assets_dir, &saved)).unwrap(),
        b"\x89PNG fake bytes"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// qa: PRIV-04:4
#[tokio::test]
async fn a_pasted_image_is_stored_without_the_machines_path() {
    let dir = unique_tmp_dir();
    let assets_dir = dir.join("assets");

    let saved = save_bytes_into_dir(&assets_dir, b"GIF89a".to_vec(), "GIF")
        .await
        .unwrap();

    assert!(
        saved.starts_with("assets/") && saved.ends_with(".gif"),
        "{saved}"
    );
    assert!(!saved.contains(&*dir.to_string_lossy()));
    assert_eq!(
        std::fs::read(resolve_asset_path(&assets_dir, &saved)).unwrap(),
        b"GIF89a"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// The cross-language fixture directory; `assetPath.conformance.test.ts` reads the same file.
const ASSET_PATHS: &str =
    include_str!("../../../../../../crates/pikos-db/tests/fixtures/asset-paths.json");

// qa: PRIV-04:4
#[test]
fn every_stored_path_resolves_as_the_shared_table_says() {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Table {
        assets_dir: String,
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Case {
        name: String,
        stored: String,
        resolved: String,
    }

    let table: Table = serde_json::from_str(ASSET_PATHS).expect("parse asset-paths.json");
    assert!(!table.cases.is_empty());
    for case in &table.cases {
        assert_eq!(
            resolve_asset_path(Path::new(&table.assets_dir), &case.stored),
            PathBuf::from(&case.resolved),
            "{}",
            case.name
        );
    }
}

#[tokio::test]
async fn save_asset_rejects_missing_source() {
    let dir = unique_tmp_dir();
    let missing = dir.join("nope.png");

    let err = save_asset_into_dir(&dir.join("assets"), &missing.to_string_lossy())
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)));
    // The assets dir is not created when the source is missing (early return).
    assert!(!dir.join("assets").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn save_asset_rejects_disallowed_extension() {
    let dir = unique_tmp_dir();
    let source = dir.join("malware.exe");
    std::fs::write(&source, b"MZ").unwrap();

    let err = save_asset_into_dir(&dir.join("assets"), &source.to_string_lossy())
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));

    let _ = std::fs::remove_dir_all(&dir);
}
