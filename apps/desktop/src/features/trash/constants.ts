/**
 * How long a trashed page is kept, in days.
 *
 * The number the UI promises has to be the number the sweep enforces: this
 * mirrors `TRASH_RETENTION_DAYS` in `crates/pikos-db/src/pages.rs`, which the
 * app's start-up purge passes and which is the only thing that actually
 * destroys anything. Changing one without the other turns the empty state's
 * "kept for 30 days" into a claim nothing backs.
 */
export const TRASH_RETENTION_DAYS = 30;
