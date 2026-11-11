use std::path::PathBuf;

use super::{canonicalize_path, ensure_inside_data_dir};

fn unique_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pkos_{label}_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_workspace_in_another_builds_data_folder_is_refused_and_left_untouched() {
    let parent = unique_dir("data_dirs");
    let staging = parent.join("app.pikos.desktop.staging");
    let installed = parent.join("app.pikos.desktop");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::create_dir_all(&installed).unwrap();
    let real_db = installed.join("default.sqlite");
    std::fs::write(&real_db, b"the installed app's workspace").unwrap();
    let before = std::fs::metadata(&real_db).unwrap().modified().unwrap();

    let result = ensure_inside_data_dir(&canonicalize_path(real_db.to_str().unwrap()), &staging);

    assert!(result.is_err());
    assert_eq!(
        std::fs::read(&real_db).unwrap(),
        b"the installed app's workspace"
    );
    assert_eq!(
        std::fs::metadata(&real_db).unwrap().modified().unwrap(),
        before
    );
    std::fs::remove_dir_all(&parent).unwrap();
}

#[test]
fn a_path_that_climbs_out_of_the_data_folder_is_refused() {
    let parent = unique_dir("data_dirs");
    let staging = parent.join("staging");
    std::fs::create_dir_all(&staging).unwrap();
    let climbing = staging.join("../default.sqlite");

    let result = ensure_inside_data_dir(&canonicalize_path(climbing.to_str().unwrap()), &staging);

    assert!(result.is_err());
    std::fs::remove_dir_all(&parent).unwrap();
}

#[test]
fn a_workspace_inside_the_data_folder_opens_even_before_it_exists() {
    let data_dir = unique_dir("data_dir");
    let db = data_dir.join("default.sqlite");

    let result = ensure_inside_data_dir(&canonicalize_path(db.to_str().unwrap()), &data_dir);

    assert!(result.is_ok());
    std::fs::remove_dir_all(&data_dir).unwrap();
}
