#ifndef PIKOS_REPLICA_H
#define PIKOS_REPLICA_H

#include <stddef.h>
#include <stdint.h>

/// Implemented by the Mac app's Rust (apps/desktop/src-tauri/src/db/icloud.rs). Runs the workspace
/// operation `op` with the UTF-8 JSON in `input` and returns `{"ok": …}` or `{"err": "…"}`, which
/// the caller frees with `pikos_replica_free`.
uint8_t *pikos_replica_call(const char *op, const uint8_t *input, size_t input_len, size_t *output_len);

void pikos_replica_free(uint8_t *ptr, size_t len);

#endif
