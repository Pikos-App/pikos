/**
 * How long a trashed page is kept, in days. Mirrors `TRASH_RETENTION_DAYS` in
 * `crates/pikos-db/src/pages.rs`, which the start-up purge passes and which alone destroys anything:
 * the two must agree or the empty state's "kept for 30 days" is a claim nothing backs.
 */
export const TRASH_RETENTION_DAYS = 30;
