-- Generated from the replica manifest in pikos-db. Don't edit; regenerate with
-- UPDATE_GOLDEN=1 cargo test -p pikos-db replica

CREATE TRIGGER replica_page_insert AFTER INSERT ON pages
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'page', NEW.id,
      1023,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'page', NEW.id, hlc || hlc || hlc || hlc || hlc || hlc || hlc || hlc || hlc || hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_page_update AFTER UPDATE ON pages
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND ((OLD.title IS NOT NEW.title)
    OR (OLD.subtitle IS NOT NEW.subtitle)
    OR ((OLD.folder_id IS NOT NEW.folder_id AND NOT (NEW.folder_id IS NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id = OLD.folder_id))))
    OR ((OLD.parent_id IS NOT NEW.parent_id AND NOT (NEW.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.parent_id))))
    OR (OLD.priority IS NOT NEW.priority)
    OR (OLD.sort_order IS NOT NEW.sort_order)
    OR (OLD.links IS NOT NEW.links)
    OR (OLD.deleted_at IS NOT NEW.deleted_at)
    OR (OLD.created_at IS NOT NEW.created_at)
    OR (OLD.status IS NOT NEW.status OR OLD.completed_at IS NOT NEW.completed_at))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'page', NEW.id,
      (CASE WHEN OLD.title IS NOT NEW.title THEN 1 ELSE 0 END)
      | (CASE WHEN OLD.subtitle IS NOT NEW.subtitle THEN 2 ELSE 0 END)
      | (CASE WHEN (OLD.folder_id IS NOT NEW.folder_id AND NOT (NEW.folder_id IS NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id = OLD.folder_id))) THEN 4 ELSE 0 END)
      | (CASE WHEN (OLD.parent_id IS NOT NEW.parent_id AND NOT (NEW.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.parent_id))) THEN 8 ELSE 0 END)
      | (CASE WHEN OLD.priority IS NOT NEW.priority THEN 16 ELSE 0 END)
      | (CASE WHEN OLD.sort_order IS NOT NEW.sort_order THEN 32 ELSE 0 END)
      | (CASE WHEN OLD.links IS NOT NEW.links THEN 64 ELSE 0 END)
      | (CASE WHEN OLD.deleted_at IS NOT NEW.deleted_at THEN 128 ELSE 0 END)
      | (CASE WHEN OLD.created_at IS NOT NEW.created_at THEN 256 ELSE 0 END)
      | (CASE WHEN OLD.status IS NOT NEW.status OR OLD.completed_at IS NOT NEW.completed_at THEN 512 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'page', NEW.id, base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.title IS NOT NEW.title THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
      || CASE WHEN OLD.subtitle IS NOT NEW.subtitle THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 41, 20) END
      || CASE WHEN (OLD.folder_id IS NOT NEW.folder_id AND NOT (NEW.folder_id IS NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id = OLD.folder_id))) THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 61, 20) END
      || CASE WHEN (OLD.parent_id IS NOT NEW.parent_id AND NOT (NEW.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.parent_id))) THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 81, 20) END
      || CASE WHEN OLD.priority IS NOT NEW.priority THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 101, 20) END
      || CASE WHEN OLD.sort_order IS NOT NEW.sort_order THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 121, 20) END
      || CASE WHEN OLD.links IS NOT NEW.links THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 141, 20) END
      || CASE WHEN OLD.deleted_at IS NOT NEW.deleted_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 161, 20) END
      || CASE WHEN OLD.created_at IS NOT NEW.created_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 181, 20) END
      || CASE WHEN OLD.status IS NOT NEW.status OR OLD.completed_at IS NOT NEW.completed_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 201, 20) END
  WHERE entity = 'page' AND key = NEW.id;
  DELETE FROM replica_detached WHERE entity = 'page' AND key = NEW.id AND field = 2 AND ((OLD.folder_id IS NOT NEW.folder_id AND NOT (NEW.folder_id IS NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id = OLD.folder_id))));
  DELETE FROM replica_detached WHERE entity = 'page' AND key = NEW.id AND field = 3 AND ((OLD.parent_id IS NOT NEW.parent_id AND NOT (NEW.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.parent_id))));
END;

CREATE TRIGGER replica_page_delete AFTER DELETE ON pages
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'page', OLD.id,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'page', OLD.id, base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock, CASE WHEN OLD.deleted_at IS NOT NULL THEN COALESCE((SELECT substr(clocks, 161, 20) FROM replica_clocks WHERE entity = 'page' AND key = OLD.id), (SELECT base_clock FROM replica_meta WHERE id = 1)) ELSE (SELECT hlc FROM replica_meta WHERE id = 1) END FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_body_insert AFTER INSERT ON pages
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'body', NEW.id,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'body', NEW.id, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_body_update AFTER UPDATE ON pages
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND ((OLD.content IS NOT NEW.content OR OLD.content_schema_version IS NOT NEW.content_schema_version))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'body', NEW.id,
      (CASE WHEN OLD.content IS NOT NEW.content OR OLD.content_schema_version IS NOT NEW.content_schema_version THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'body', NEW.id, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.content IS NOT NEW.content OR OLD.content_schema_version IS NOT NEW.content_schema_version THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'body' AND key = NEW.id;
END;

CREATE TRIGGER replica_folder_insert AFTER INSERT ON folders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'folder', NEW.id,
      63,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'folder', NEW.id, hlc || hlc || hlc || hlc || hlc || hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_folder_update AFTER UPDATE ON folders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND ((OLD.name IS NOT NEW.name)
    OR (OLD.color IS NOT NEW.color)
    OR (OLD.icon IS NOT NEW.icon)
    OR (OLD.sort_order IS NOT NEW.sort_order)
    OR (OLD.deleted_at IS NOT NEW.deleted_at)
    OR (OLD.created_at IS NOT NEW.created_at))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'folder', NEW.id,
      (CASE WHEN OLD.name IS NOT NEW.name THEN 1 ELSE 0 END)
      | (CASE WHEN OLD.color IS NOT NEW.color THEN 2 ELSE 0 END)
      | (CASE WHEN OLD.icon IS NOT NEW.icon THEN 4 ELSE 0 END)
      | (CASE WHEN OLD.sort_order IS NOT NEW.sort_order THEN 8 ELSE 0 END)
      | (CASE WHEN OLD.deleted_at IS NOT NEW.deleted_at THEN 16 ELSE 0 END)
      | (CASE WHEN OLD.created_at IS NOT NEW.created_at THEN 32 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'folder', NEW.id, base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.name IS NOT NEW.name THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
      || CASE WHEN OLD.color IS NOT NEW.color THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 41, 20) END
      || CASE WHEN OLD.icon IS NOT NEW.icon THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 61, 20) END
      || CASE WHEN OLD.sort_order IS NOT NEW.sort_order THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 81, 20) END
      || CASE WHEN OLD.deleted_at IS NOT NEW.deleted_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 101, 20) END
      || CASE WHEN OLD.created_at IS NOT NEW.created_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 121, 20) END
  WHERE entity = 'folder' AND key = NEW.id;
END;

CREATE TRIGGER replica_folder_delete AFTER DELETE ON folders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'folder', OLD.id,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'folder', OLD.id, base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock, CASE WHEN OLD.deleted_at IS NOT NULL THEN COALESCE((SELECT substr(clocks, 101, 20) FROM replica_clocks WHERE entity = 'folder' AND key = OLD.id), (SELECT base_clock FROM replica_meta WHERE id = 1)) ELSE (SELECT hlc FROM replica_meta WHERE id = 1) END FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_tag_insert AFTER INSERT ON tags
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'tag', NEW.name,
      0,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'tag', NEW.name, hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_pagetag_insert AFTER INSERT ON page_tags
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'pagetag', NEW.page_id || '/' || (SELECT name FROM tags WHERE id = NEW.tag_id),
      0,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'pagetag', NEW.page_id || '/' || (SELECT name FROM tags WHERE id = NEW.tag_id), hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_pagetag_delete AFTER DELETE ON page_tags
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'pagetag', OLD.page_id || '/' || (SELECT name FROM tags WHERE id = OLD.tag_id),
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'pagetag', OLD.page_id || '/' || (SELECT name FROM tags WHERE id = OLD.tag_id), base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_rule_insert AFTER INSERT ON page_recurrence_rules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'rule', NEW.page_id,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'rule', NEW.page_id, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_rule_update AFTER UPDATE ON page_recurrence_rules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND ((OLD.rrule IS NOT NEW.rrule OR OLD.rrule_exdates IS NOT NEW.rrule_exdates OR OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.created_at IS NOT NEW.created_at))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'rule', NEW.page_id,
      (CASE WHEN OLD.rrule IS NOT NEW.rrule OR OLD.rrule_exdates IS NOT NEW.rrule_exdates OR OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.created_at IS NOT NEW.created_at THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'rule', NEW.page_id, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.rrule IS NOT NEW.rrule OR OLD.rrule_exdates IS NOT NEW.rrule_exdates OR OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.created_at IS NOT NEW.created_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'rule' AND key = NEW.page_id;
END;

CREATE TRIGGER replica_rule_delete AFTER DELETE ON page_recurrence_rules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'rule', OLD.page_id,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'rule', OLD.page_id, base_clock || base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_sched_insert AFTER INSERT ON page_schedules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND NEW.rule_id IS NULL
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'sched', NEW.id,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'sched', NEW.id, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_sched_update AFTER UPDATE ON page_schedules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND NEW.rule_id IS NULL
  AND ((OLD.page_id IS NOT NEW.page_id OR OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'sched', NEW.id,
      (CASE WHEN OLD.page_id IS NOT NEW.page_id OR OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'sched', NEW.id, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.page_id IS NOT NEW.page_id OR OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'sched' AND key = NEW.id;
END;

CREATE TRIGGER replica_sched_delete AFTER DELETE ON page_schedules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND OLD.rule_id IS NULL
  AND EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'sched', OLD.id,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'sched', OLD.id, base_clock || base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_override_insert AFTER INSERT ON page_schedules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND NEW.rule_id IS NOT NULL
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'override', NEW.page_id || '/' || NEW.original_date,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'override', NEW.page_id || '/' || NEW.original_date, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_override_update AFTER UPDATE ON page_schedules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND NEW.rule_id IS NOT NULL
  AND ((OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'override', NEW.page_id || '/' || NEW.original_date,
      (CASE WHEN OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'override', NEW.page_id || '/' || NEW.original_date, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.scheduled_start IS NOT NEW.scheduled_start OR OLD.scheduled_end IS NOT NEW.scheduled_end OR OLD.timezone IS NOT NEW.timezone OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'override' AND key = NEW.page_id || '/' || NEW.original_date;
END;

CREATE TRIGGER replica_override_delete AFTER DELETE ON page_schedules
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND OLD.rule_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM page_recurrence_rules WHERE id = OLD.rule_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'override', OLD.page_id || '/' || OLD.original_date,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'override', OLD.page_id || '/' || OLD.original_date, base_clock || base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_done_insert AFTER INSERT ON completed_set
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'done', NEW.page_id || '/' || NEW.occurrence_date,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'done', NEW.page_id || '/' || NEW.occurrence_date, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_done_update AFTER UPDATE ON completed_set
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND ((OLD.clone_id IS NOT NEW.clone_id))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'done', NEW.page_id || '/' || NEW.occurrence_date,
      (CASE WHEN OLD.clone_id IS NOT NEW.clone_id THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'done', NEW.page_id || '/' || NEW.occurrence_date, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.clone_id IS NOT NEW.clone_id THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'done' AND key = NEW.page_id || '/' || NEW.occurrence_date;
END;

CREATE TRIGGER replica_done_delete AFTER DELETE ON completed_set
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'done', OLD.page_id || '/' || OLD.occurrence_date,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'done', OLD.page_id || '/' || OLD.occurrence_date, base_clock || base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_skip_insert AFTER INSERT ON skip_set
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'skip', NEW.page_id || '/' || NEW.occurrence_date,
      0,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'skip', NEW.page_id || '/' || NEW.occurrence_date, hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_skip_delete AFTER DELETE ON skip_set
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'skip', OLD.page_id || '/' || OLD.occurrence_date,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'skip', OLD.page_id || '/' || OLD.occurrence_date, base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_remind_insert AFTER INSERT ON page_reminders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'remind', NEW.id,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'remind', NEW.id, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_remind_update AFTER UPDATE ON page_reminders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND ((OLD.page_id IS NOT NEW.page_id OR OLD.minutes_before IS NOT NEW.minutes_before OR OLD.created_at IS NOT NEW.created_at))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'remind', NEW.id,
      (CASE WHEN OLD.page_id IS NOT NEW.page_id OR OLD.minutes_before IS NOT NEW.minutes_before OR OLD.created_at IS NOT NEW.created_at THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'remind', NEW.id, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN OLD.page_id IS NOT NEW.page_id OR OLD.minutes_before IS NOT NEW.minutes_before OR OLD.created_at IS NOT NEW.created_at THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'remind' AND key = NEW.id;
END;

CREATE TRIGGER replica_remind_delete AFTER DELETE ON page_reminders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'remind', OLD.id,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'remind', OLD.id, base_clock || base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_focus_insert AFTER INSERT ON focus_sessions
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'focus', NEW.id,
      1,
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'focus', NEW.id, hlc || hlc, NULL FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_focus_update AFTER UPDATE ON focus_sessions
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND (((OLD.page_id IS NOT NEW.page_id AND NOT (NEW.page_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id))) OR OLD.started_at IS NOT NEW.started_at OR OLD.ended_at IS NOT NEW.ended_at OR OLD.duration_s IS NOT NEW.duration_s))
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'focus', NEW.id,
      (CASE WHEN (OLD.page_id IS NOT NEW.page_id AND NOT (NEW.page_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id))) OR OLD.started_at IS NOT NEW.started_at OR OLD.ended_at IS NOT NEW.ended_at OR OLD.duration_s IS NOT NEW.duration_s THEN 1 ELSE 0 END),
      0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'focus', NEW.id, base_clock || base_clock FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO NOTHING;
  UPDATE replica_clocks SET clocks =
      substr(clocks, 1, 20)
      || CASE WHEN (OLD.page_id IS NOT NEW.page_id AND NOT (NEW.page_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id))) OR OLD.started_at IS NOT NEW.started_at OR OLD.ended_at IS NOT NEW.ended_at OR OLD.duration_s IS NOT NEW.duration_s THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE substr(clocks, 21, 20) END
  WHERE entity = 'focus' AND key = NEW.id;
  DELETE FROM replica_detached WHERE entity = 'focus' AND key = NEW.id AND field = 0 AND ((OLD.page_id IS NOT NEW.page_id AND NOT (NEW.page_id IS NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id))) OR OLD.started_at IS NOT NEW.started_at OR OLD.ended_at IS NOT NEW.ended_at OR OLD.duration_s IS NOT NEW.duration_s);
END;

CREATE TRIGGER replica_focus_delete AFTER DELETE ON focus_sessions
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'focus', OLD.id,
      0,
      1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'focus', OLD.id, base_clock || base_clock, (SELECT hlc FROM replica_meta WHERE id = 1) FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_page_purge BEFORE DELETE ON pages
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT OR REPLACE INTO replica_detached (entity, key, field, col, target)
  SELECT 'page', c.id, 3, 'parent_id', OLD.id
  FROM pages AS c WHERE c.parent_id = OLD.id;
  INSERT OR REPLACE INTO replica_detached (entity, key, field, col, target)
  SELECT 'focus', c.id, 0, 'page_id', OLD.id
  FROM focus_sessions AS c WHERE c.page_id = OLD.id;
END;

CREATE TRIGGER replica_folder_purge BEFORE DELETE ON folders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT OR REPLACE INTO replica_detached (entity, key, field, col, target)
  SELECT 'page', c.id, 2, 'folder_id', OLD.id
  FROM pages AS c WHERE c.folder_id = OLD.id;
END;

CREATE TRIGGER replica_scope_enter AFTER UPDATE OF sync_state ON page_sync
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND OLD.sync_state <> 'detached' AND NEW.sync_state = 'detached'
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'page', t.id, 1023, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM pages AS t WHERE (1) AND (t.id = NEW.page_id OR t.id IN (SELECT clone_id FROM completed_set WHERE page_id = NEW.page_id))
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'page', t.id, replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc || replica_meta.hlc FROM pages AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.id = NEW.page_id OR t.id IN (SELECT clone_id FROM completed_set WHERE page_id = NEW.page_id))
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'body', t.id, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM pages AS t WHERE (1) AND (t.id = NEW.page_id OR t.id IN (SELECT clone_id FROM completed_set WHERE page_id = NEW.page_id))
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'body', t.id, replica_meta.hlc || replica_meta.hlc FROM pages AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.id = NEW.page_id OR t.id IN (SELECT clone_id FROM completed_set WHERE page_id = NEW.page_id))
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'pagetag', t.page_id || '/' || (SELECT name FROM tags WHERE id = t.tag_id), 0, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM page_tags AS t WHERE (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'pagetag', t.page_id || '/' || (SELECT name FROM tags WHERE id = t.tag_id), replica_meta.hlc FROM page_tags AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'rule', t.page_id, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM page_recurrence_rules AS t WHERE (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'rule', t.page_id, replica_meta.hlc || replica_meta.hlc FROM page_recurrence_rules AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'sched', t.id, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM page_schedules AS t WHERE (t.rule_id IS NULL) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'sched', t.id, replica_meta.hlc || replica_meta.hlc FROM page_schedules AS t, replica_meta
  WHERE replica_meta.id = 1 AND (t.rule_id IS NULL) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'override', t.page_id || '/' || t.original_date, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM page_schedules AS t WHERE (t.rule_id IS NOT NULL) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'override', t.page_id || '/' || t.original_date, replica_meta.hlc || replica_meta.hlc FROM page_schedules AS t, replica_meta
  WHERE replica_meta.id = 1 AND (t.rule_id IS NOT NULL) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'done', t.page_id || '/' || t.occurrence_date, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM completed_set AS t WHERE (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'done', t.page_id || '/' || t.occurrence_date, replica_meta.hlc || replica_meta.hlc FROM completed_set AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'skip', t.page_id || '/' || t.occurrence_date, 0, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM skip_set AS t WHERE (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'skip', t.page_id || '/' || t.occurrence_date, replica_meta.hlc FROM skip_set AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'remind', t.id, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM page_reminders AS t WHERE (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'remind', t.id, replica_meta.hlc || replica_meta.hlc FROM page_reminders AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'focus', t.id, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM focus_sessions AS t WHERE (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'focus', t.id, replica_meta.hlc || replica_meta.hlc FROM focus_sessions AS t, replica_meta
  WHERE replica_meta.id = 1 AND (1) AND (t.page_id = NEW.page_id)
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_scope_leave AFTER UPDATE OF sync_state ON page_sync
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND OLD.sync_state = 'detached' AND NEW.sync_state <> 'detached'
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'page', NEW.page_id, 0, 1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'page', NEW.page_id, base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;

CREATE TRIGGER replica_folder_scope_enter AFTER UPDATE OF is_external_calendar ON folders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND OLD.is_external_calendar = 1 AND NEW.is_external_calendar = 0
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'folder', NEW.id, 63, 0, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks)
  SELECT 'folder', NEW.id, hlc || hlc || hlc || hlc || hlc || hlc || hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;
END;

CREATE TRIGGER replica_folder_scope_leave AFTER UPDATE OF is_external_calendar ON folders
WHEN (SELECT started FROM replica_meta WHERE id = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM replica_applying)
  AND OLD.is_external_calendar = 0 AND NEW.is_external_calendar = 1
BEGIN
  UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;
  INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'folder', NEW.id, 0, 1, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;
  INSERT INTO replica_clocks (entity, key, clocks, tomb)
  SELECT 'folder', NEW.id, base_clock || base_clock || base_clock || base_clock || base_clock || base_clock || base_clock, hlc FROM replica_meta WHERE id = 1
  ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;
END;
