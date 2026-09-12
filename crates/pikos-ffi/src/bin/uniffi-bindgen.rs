//! Bindings generator.
//!
//! `cargo run -p pikos-ffi --bin uniffi-bindgen -- generate --library <lib> --language swift --out-dir <dir>`
//!
//! Deliberately a normal Rust binary rather than an Xcode build phase: it means
//! the generated Swift can be produced, diffed and reviewed on any machine,
//! including CI runners with no Apple toolchain.
fn main() {
    uniffi::uniffi_bindgen_main()
}
