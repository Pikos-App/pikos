-- When the calendar changes a description the user has already edited in their
-- body, the reconciler must not clobber the body — it parks the new upstream text
-- here for the editor's passive "calendar description changed" notice. Stored as
-- plain text so that notice renders offline without a re-fetch. NULL = nothing
-- pending; cleared once the divergence resolves (see the seeded_description_hash
-- machinery in 010).
ALTER TABLE page_sync ADD COLUMN pending_description TEXT;
