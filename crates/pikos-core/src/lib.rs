//! Portable Pikos domain logic, shared by the desktop app and the CLI.
//!
//! Deliberately dependency-free of `pikos-db`: this is pure logic with no I/O,
//! which is what makes it testable against a fixture table.

pub mod markdown;
pub mod markdown_import;

pub use markdown::prosemirror_to_markdown;
pub use markdown_import::{markdown_to_prosemirror, Refused};
