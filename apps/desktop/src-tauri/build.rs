#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a build script fails the build by panicking"
)]

use std::process::Command;

fn main() {
    let commit = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=PIKOS_GIT_COMMIT={commit}");
    watch_commit();

    link_icloud_sync();
    tauri_build::build()
}

fn git(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Reruns this script when the commit changes, and at no other time. Git names the files, so this
/// holds in a worktree, whose `.git` is a file: a hardcoded `.git/HEAD` there doesn't exist,
/// and a missing file reads as changed, so every build recompiled the crate. Only the checked-out
/// branch's ref is watched, rather than all of `refs/`, so a fetch doesn't recompile it either.
fn watch_commit() {
    let Some(head) = git(&["rev-parse", "--git-path", "HEAD"]) else {
        return;
    };
    println!("cargo:rerun-if-changed={head}");
    let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) else {
        return; // Detached: the commit is in HEAD itself.
    };
    // A ref git has packed has no file of its own, and watching a missing file would rerun
    // every build, so watch the packed list instead.
    let packed = || git(&["rev-parse", "--git-path", "packed-refs"]);
    let watched = git(&["rev-parse", "--git-path", &branch])
        .filter(|path| std::path::Path::new(path).exists())
        .or_else(packed);
    if let Some(path) = watched {
        println!("cargo:rerun-if-changed={path}");
    }
}

/// With the `icloud-sync` feature on a Mac, builds the Swift transport as a static library and
/// links it, with CloudKit and the Swift runtime it needs.
///
/// The container comes from `PIKOS_ICLOUD_CONTAINER`, which must name the one the build's
/// entitlements grant: CloudKit refuses any other. Unset, it is staging's.
fn link_icloud_sync() {
    let wanted = std::env::var_os("CARGO_FEATURE_ICLOUD_SYNC").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if !wanted {
        return;
    }

    println!("cargo:rerun-if-env-changed=PIKOS_ICLOUD_CONTAINER");
    let container = std::env::var("PIKOS_ICLOUD_CONTAINER")
        .unwrap_or_else(|_| "iCloud.app.pikos.staging".to_owned());
    println!("cargo:rustc-env=PIKOS_ICLOUD_CONTAINER={container}");

    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let package = manifest.join("../../apple/PikosSync");
    let scratch = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("pikos-sync");
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64".to_owned(),
        other => other.to_owned(),
    };
    println!(
        "cargo:rerun-if-changed={}",
        package.join("Sources").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        package.join("Package.swift").display()
    );

    let built = Command::new("xcrun")
        .args([
            "swift",
            "build",
            "-c",
            "release",
            "--product",
            "PikosSyncMac",
            "--triple",
        ])
        .arg(format!("{arch}-apple-macosx"))
        .arg("--package-path")
        .arg(&package)
        .arg("--scratch-path")
        .arg(&scratch)
        .status()
        .expect("xcrun swift build");
    assert!(built.success(), "building PikosSyncMac failed");

    let output = |args: &[&str]| {
        let out = Command::new("xcrun").args(args).output().expect("xcrun");
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    };
    let sdk = output(&["--sdk", "macosx", "--show-sdk-path"]);
    let swift = std::path::PathBuf::from(output(&["--find", "swift"]));
    let toolchain_lib = swift.parent().unwrap().join("../lib/swift/macosx");

    println!(
        "cargo:rustc-link-search=native={}",
        scratch.join("release").display()
    );
    println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain_lib.display());
    println!("cargo:rustc-link-lib=static=PikosSyncMac");
    println!("cargo:rustc-link-lib=framework=CloudKit");
    // Swift's async CloudKit calls live in its overlay, which a static library doesn't pull in.
    println!("cargo:rustc-link-lib=dylib=swiftCloudKit");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
