//! `google::config` reads the OAuth client through `option_env!`, which is baked
//! in at compile time. Without these, Cargo has no reason to recompile the crate
//! when the vars change — so setting them and rebuilding silently reuses a cached
//! rlib that still carries no credentials, and Google sync stays hidden with
//! nothing to indicate why.

fn main() {
    println!("cargo:rerun-if-env-changed=PIKOS_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=PIKOS_GOOGLE_CLIENT_SECRET");
}
