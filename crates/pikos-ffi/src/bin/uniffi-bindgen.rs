//! Bindings generator, a plain Rust binary rather than an Xcode build phase so the Swift can be
//! generated and diffed on any machine, CI runners without Apple tooling included.
//!
//! `cargo run -p pikos-ffi --bin uniffi-bindgen -- generate --library <lib> --language swift --out-dir <dir>`
fn main() {
    uniffi::uniffi_bindgen_main()
}
