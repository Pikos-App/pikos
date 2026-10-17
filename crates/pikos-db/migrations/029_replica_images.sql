-- Images travel with sync. `assets_dir` is where this device keeps the workspace's image files; the
-- app sets it at every launch, since a workspace copied from another machine carries that one's.
ALTER TABLE replica_meta ADD COLUMN assets_dir TEXT;

-- A page body sent before images synced never sent its images. Sending every body that shows one
-- again sends them too; a receiver that already has the body finds nothing to change.
INSERT INTO replica_ops (entity, key, fields, deleted, clock)
  SELECT 'body', id, 1, 0, (SELECT hlc FROM replica_meta WHERE id = 1)
  FROM pages
  WHERE instr(content, '"image"') > 0 AND (SELECT started FROM replica_meta WHERE id = 1) = 1
  ON CONFLICT (entity, key) DO NOTHING;
