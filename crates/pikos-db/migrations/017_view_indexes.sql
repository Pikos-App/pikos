-- One index per stream `views.rs` reads an Inbox or folder list through, in each sort mode, so a
-- window costs the same however large the workspace is. Each is partial on exactly the rows its
-- query asks for, which is also what lets SQLite choose it. Ties break by manual order, then
-- creation, then id.

CREATE INDEX idx_view_manual ON pages(folder_id, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done';

CREATE INDEX idx_view_title ON pages(folder_id, title_key, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done';

CREATE INDEX idx_view_floating ON pages(folder_id, order_start, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 0 AND order_start IS NOT NULL;

CREATE INDEX idx_view_absolute ON pages(folder_id, abs_start_utc, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 1;

CREATE INDEX idx_view_unscheduled ON pages(folder_id, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND scheduled_start IS NULL;

CREATE INDEX idx_view_priority_floating
  ON pages(folder_id, priority, order_start, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 0 AND order_start IS NOT NULL;

CREATE INDEX idx_view_priority_absolute
  ON pages(folder_id, priority, abs_start_utc, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 1;

CREATE INDEX idx_view_priority_unscheduled ON pages(folder_id, priority, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND scheduled_start IS NULL;

-- Done pages newest first, in one folder or the Inbox, and across every folder for Today's and
-- Upcoming's sections.
CREATE INDEX idx_view_done ON pages(folder_id, completed_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'done';

CREATE INDEX idx_view_done_everywhere ON pages(completed_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'done';
