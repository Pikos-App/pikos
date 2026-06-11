#!/usr/bin/env python3
"""
seed-dst.py — Populate Pikos DB with pages around the US DST spring-forward.

US Pacific DST 2026: clocks jump from 2:00 AM → 3:00 AM on Sunday, March 8.
  Before transition: PST  (UTC-8)
  After  transition: PDT  (UTC-7)

Run:
  python3 scripts/seed-dst.py [path/to/workspace.sqlite]

If no path is given, the script tries the default Tauri app-data location:
  Linux  : ~/.local/share/com.pikos.app/default.sqlite
  macOS  : ~/Library/Application Support/com.pikos.app/default.sqlite
"""

import sqlite3
import sys
import os
import uuid
import json
from datetime import datetime, timezone
from typing import Optional

# ── helpers ──────────────────────────────────────────────────────────────────

def uid() -> str:
    return str(uuid.uuid4())

def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def tiptap(text: str) -> str:
    """Minimal Tiptap JSON doc with a single paragraph."""
    return json.dumps({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]
    })

# ── page catalogue ────────────────────────────────────────────────────────────
# Each entry: (title, subtitle, start_local, end_local, status, priority, tags)
# start/end are local wall-clock times in America/Los_Angeles (Pacific).
# The 2:00–2:59 AM window on March 8 is the DST gap (those times don't exist).

PAGES = [
    # ── Saturday March 7 — normal PST ─────────────────────────────────────────
    (
        "Pre-DST planning session",
        "Review tasks before clocks change",
        "2026-03-07T09:00:00", "2026-03-07T10:00:00",
        "not_started", 2, ["dst", "planning"],
    ),
    (
        "Saturday morning standup",
        "Async notes before the long weekend",
        "2026-03-07T10:30:00", "2026-03-07T11:00:00",
        "not_started", 3, ["standup"],
    ),
    (
        "Lunch break — check calendar edge cases",
        "Verify app handles DST gap gracefully",
        "2026-03-07T12:00:00", "2026-03-07T13:00:00",
        "not_started", 0, ["dst", "qa"],
    ),
    (
        "Afternoon deep work",
        "Finish GOO-79 Today smart view",
        "2026-03-07T14:00:00", "2026-03-07T16:00:00",
        "not_started", 1, ["focus", "dev"],
    ),
    (
        "Set reminder to update wall clocks",
        "Spring forward tonight — don't be late tomorrow",
        "2026-03-07T22:00:00", "2026-03-07T22:15:00",
        "not_started", 3, ["reminder", "dst"],
    ),
    (
        "Late-night reading",
        "Wind down before the short night",
        "2026-03-07T23:00:00", "2026-03-07T23:30:00",
        "not_started", 0, ["personal"],
    ),

    # ── DST transition zone — March 8 around 2 AM ─────────────────────────────
    # 2:00–2:59 AM does not exist (clocks skip to 3:00 AM).
    # We include pages bracketing the gap so the UI can be tested.
    (
        "Just before the DST gap",
        "Scheduled at 1:45 AM — last moment in PST",
        "2026-03-08T01:45:00", "2026-03-08T02:00:00",
        "not_started", 2, ["dst", "edge-case"],
    ),
    (
        "Exactly at 2 AM (non-existent wall time)",
        "Clocks skip from 2:00 → 3:00; this slot doesn't exist",
        "2026-03-08T02:00:00", "2026-03-08T02:30:00",
        "not_started", 1, ["dst", "gap", "edge-case"],
    ),
    (
        "Mid-gap 2:30 AM (non-existent)",
        "Another page in the skipped hour",
        "2026-03-08T02:30:00", "2026-03-08T03:00:00",
        "not_started", 1, ["dst", "gap", "edge-case"],
    ),
    (
        "Just after the DST gap",
        "Clocks now read 3:00 AM PDT — first valid time",
        "2026-03-08T03:00:00", "2026-03-08T03:30:00",
        "not_started", 2, ["dst", "edge-case"],
    ),

    # ── Sunday March 8 — PDT day, morning / afternoon ─────────────────────────
    (
        "Sunday morning run",
        "Shorter sleep thanks to DST — go anyway",
        "2026-03-08T07:00:00", "2026-03-08T08:00:00",
        "not_started", 0, ["health", "dst"],
    ),
    (
        "DST day brunch",
        "Meet at 10 AM PDT — remember it feels like 9",
        "2026-03-08T10:00:00", "2026-03-08T11:30:00",
        "not_started", 3, ["personal"],
    ),
    (
        "Verify Pikos calendar render after DST",
        "Check that all blocks appear at correct wall-clock times",
        "2026-03-08T11:30:00", "2026-03-08T12:00:00",
        "not_started", 1, ["dst", "qa", "dev"],
    ),
    (
        "Afternoon sync with east coast team",
        "East coast already sprung forward same day; both on summer time",
        "2026-03-08T14:00:00", "2026-03-08T15:00:00",
        "not_started", 2, ["meeting"],
    ),
    (
        "Evening wrap-up",
        "First full day on PDT — how did the app hold up?",
        "2026-03-08T18:00:00", "2026-03-08T18:30:00",
        "not_started", 3, ["review", "dst"],
    ),

    # ── All-day events for both days ──────────────────────────────────────────
    (
        "March 7 — Last day of EST",
        "All-day marker for day before spring forward",
        "2026-03-07", None,
        "not_started", 0, ["dst", "marker"],
    ),
    (
        "March 8 — DST begins (spring forward)",
        "Clocks +1h at 2 AM → 3 AM in America/Los_Angeles",
        "2026-03-08", None,
        "not_started", 0, ["dst", "marker"],
    ),

    # ── Monday March 9 — first full day on EDT ────────────────────────────────
    (
        "Monday standup — first day fully on PDT",
        "Confirm recurring meetings didn't drift",
        "2026-03-09T09:00:00", "2026-03-09T09:30:00",
        "not_started", 3, ["standup", "dst"],
    ),
    (
        "Post-DST calendar audit",
        "Compare scheduled blocks from Sat/Sun/Mon",
        "2026-03-09T10:00:00", "2026-03-09T11:00:00",
        "not_started", 2, ["dst", "qa"],
    ),

    # ── A few completed/in-progress pages for status variety ──────────────────
    (
        "Pre-flight: bump app version to 0.1.1",
        "Done before DST weekend",
        "2026-03-07T08:00:00", "2026-03-07T08:30:00",
        "done", 2, ["dev"],
    ),
    (
        "Write seed script for DST testing",
        "This very task",
        "2026-03-07T11:00:00", "2026-03-07T11:45:00",
        "not_started", 1, ["dev", "dst"],
    ),
]

TIMEZONE = "America/Los_Angeles"

# ── database helpers ──────────────────────────────────────────────────────────

def insert_page(cur, folder_id: Optional[str], title: str, subtitle: str,
                content_text: str, status: str, priority: int, tags: list,
                sort_order: int) -> str:
    page_id = uid()
    ts = now_iso()
    completed_at = ts if status == "done" else None
    cur.execute(
        """
        INSERT INTO pages
          (id, folder_id, title, subtitle, content, content_text,
           status, priority, tags, sort_order, completed_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            page_id, folder_id, title, subtitle,
            tiptap(subtitle or title), content_text or subtitle or title,
            status, priority, json.dumps(tags), sort_order,
            completed_at, ts, ts,
        ),
    )
    return page_id


def insert_schedule(cur, page_id: str, start: str, end: Optional[str],
                    timezone: Optional[str]) -> str:
    sched_id = uid()
    ts = now_iso()
    cur.execute(
        """
        INSERT INTO page_schedules
          (id, page_id, scheduled_start, scheduled_end, timezone, status, created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
        (sched_id, page_id, start, end, timezone, "not_started", ts),
    )
    return sched_id


def update_page_denorm(cur, page_id: str, start: str, end: Optional[str]) -> None:
    """Keep pages.scheduled_start/end in sync (denorm of next upcoming schedule)."""
    cur.execute(
        "UPDATE pages SET scheduled_start=?, scheduled_end=? WHERE id=?",
        (start, end, page_id),
    )


def get_or_create_folder(cur, name: str, color: str = "#6366f1") -> str:
    row = cur.execute("SELECT id FROM folders WHERE name=?", (name,)).fetchone()
    if row:
        return row[0]
    folder_id = uid()
    ts = now_iso()
    cur.execute(
        """
        INSERT INTO folders (id, name, parent_id, sort_order, color, created_at, updated_at)
        VALUES (?,?,NULL,1,?,?,?)
        """,
        (folder_id, name, color, ts, ts),
    )
    return folder_id


# ── main ──────────────────────────────────────────────────────────────────────

def default_db_path() -> str:
    if sys.platform == "darwin":
        return os.path.expanduser(
            "~/Library/Application Support/com.pikos.app/default.sqlite"
        )
    # Linux (and anything else)
    return os.path.expanduser(
        "~/.local/share/com.pikos.app/default.sqlite"
    )


def seed(db_path: str) -> None:
    if not os.path.exists(db_path):
        print(f"  Creating new database at: {db_path}")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    # Apply migrations if tables don't exist
    migration_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "apps", "desktop", "src-tauri", "migrations", "001_initial.sql",
    )
    migration_path = os.path.normpath(migration_path)
    if os.path.exists(migration_path):
        with open(migration_path) as f:
            sql = f.read()
        # SQLite Python can't executescript with WAL pragma inline; split on ";"
        # executescript commits any pending transaction first — that's fine here.
        con.executescript(sql)
        print(f"  Applied migration: {migration_path}")
    else:
        print(f"  Warning: migration not found at {migration_path} — assuming schema exists")

    folder_id = get_or_create_folder(cur, "DST Testing", "#f59e0b")

    inserted = 0
    for i, (title, subtitle, start, end, status, priority, tags) in enumerate(PAGES):
        is_timed = "T" in start
        tz = TIMEZONE if is_timed else None

        page_id = insert_page(
            cur,
            folder_id=folder_id,
            title=title,
            subtitle=subtitle,
            content_text=f"{subtitle or ''} [{', '.join(tags)}]",
            status=status,
            priority=priority,
            tags=tags,
            sort_order=i + 1,
        )

        insert_schedule(cur, page_id, start, end, tz)
        update_page_denorm(cur, page_id, start, end)
        inserted += 1
        print(f"  [{i+1:02d}] {start}  {title}")

    con.commit()
    con.close()
    print(f"\n  Done — {inserted} pages seeded into '{db_path}'")
    print(f"  Folder: 'DST Testing'")
    print(f"  Timezone: {TIMEZONE}")
    print(f"  Date range: 2026-03-07 (PST) → 2026-03-09 (PDT)")
    print(f"\n  DST gap pages (2:00–2:59 AM on March 8) are marked with [gap] tags.")
    print(f"  Compare today (Mar 7) vs tomorrow (Mar 8) in the Pikos calendar.")


if __name__ == "__main__":
    db_path = sys.argv[1] if len(sys.argv) > 1 else default_db_path()
    print(f"\nPikos DST seed script")
    print(f"  Target DB : {db_path}\n")
    seed(db_path)
