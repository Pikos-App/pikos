-- Reading what changed since a change number, as the phone's Spotlight catch-up does after a
-- write, scanned every page: 39 ms at 200,000 pages on an M2, about three times that on a phone.
-- Indexed it reads only the pages that moved, 0.6 ms, with no measurable cost to a write.
CREATE INDEX IF NOT EXISTS idx_pages_row_seq ON pages(row_seq);
