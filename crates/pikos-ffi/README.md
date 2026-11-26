# pikos-ffi

The Swift-facing surface of `pikos-core` and `pikos-db`. UniFFI generates the Swift package in
`apps/ios/PikosCore` from what this crate exports. The desktop app doesn't go through it.

## Rules for the boundary

- **Logic stays in `pikos-core` and `pikos-db`.** This crate converts types and nothing else. A
  second implementation of storage or scheduling is how two clients end up disagreeing about
  what a page is.
- **Dates cross as wall-clock strings**, never as a date type. The reason is on the crate docs
  in `src/lib.rs`.
- **Nothing exported may panic.** A Rust panic is a crash in the host app with no Swift-side
  recovery. Malformed input returns `None`, an empty list, or a `WorkspaceError`.
- **Layout returns structure, not geometry.** Pixel metrics belong to the renderer.
- **One writer.** `Workspace` writes. `ReadOnlyWorkspace` has no write methods, which is what
  widgets and other extensions hold. The container path is the caller's to choose.
- **A tri-state in the data layer becomes a named enum here** (`FolderScope`,
  `FolderAssignment`), because absent, null and a value don't survive the boundary.

## Generated bindings

After changing anything marked `#[uniffi::export]`, run `scripts/gen-swift-bindings.sh` and
commit the result. It runs anywhere Rust does, and CI fails on a stale diff. The generated
Swift isn't run through `swift-format`, so the output stays byte-identical across platforms.

The XCFramework the bindings call into is a gitignored build artifact, produced on a Mac by
`scripts/build-ios-framework.sh`.

`CONTENT_SCHEMA_VERSION` is mirrored here so iOS can check it without linking a database
engine. A test holds the copy equal to the one in `pikos-db`.
