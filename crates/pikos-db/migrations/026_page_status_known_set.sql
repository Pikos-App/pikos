-- A page's status is one the app knows: 'not_started' or 'done'.
--
-- Nothing stopped pages.status holding any string, and a page saved as 'Done'
-- (by an import, the CLI, or later a sync peer) showed in neither Today nor
-- Completed: in the workspace and nowhere on screen. Triggers rather than a
-- CHECK, because a CHECK means recreating pages and every trigger on it, and
-- a raise names the column, which a CHECK failure doesn't. The writer refuses
-- the same set first (PAGE_STATUSES in pages.rs), so a caller gets an input
-- error rather than a storage one; widening the set changes both.

-- A case variant of a known status is that status. Anything else keeps the
-- page visible: done if it has a completion time, open otherwise.
UPDATE pages SET status = lower(status)
WHERE status NOT IN ('not_started', 'done') AND lower(status) IN ('not_started', 'done');

UPDATE pages
SET status = CASE WHEN completed_at IS NOT NULL THEN 'done' ELSE 'not_started' END
WHERE status NOT IN ('not_started', 'done');

CREATE TRIGGER page_status_known_on_insert
BEFORE INSERT ON pages
WHEN NEW.status NOT IN ('not_started', 'done')
BEGIN
  SELECT RAISE(ABORT, 'pages.status must be not_started or done');
END;

CREATE TRIGGER page_status_known_on_update
BEFORE UPDATE OF status ON pages
WHEN NEW.status NOT IN ('not_started', 'done')
BEGIN
  SELECT RAISE(ABORT, 'pages.status must be not_started or done');
END;
