//! The Google provider against a replay server: the real calendar list and sync, with the API
//! root moved and the OAuth half skipped, since replaying needs no grant and CI has no client.

use pikos_db::error::AppResult;
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{CalendarProvider, EventUpsert, RemoteCalendar, SyncDelta, SyncToken};

use super::sync;
use super::transport::ReqwestGoogle;

pub(crate) struct ReplayGoogle {
    root: String,
}

impl ReplayGoogle {
    pub(crate) fn new(replay_url: &str) -> Self {
        Self {
            root: format!("{replay_url}/calendar/v3"),
        }
    }

    fn transport(&self) -> ReqwestGoogle {
        ReqwestGoogle::at(&self.root, "replay-token")
    }

    /// The calendars and the primary calendar's id, as a connect reads them from a fresh grant.
    pub(crate) async fn list_for_connect(&self) -> AppResult<(Vec<RemoteCalendar>, String)> {
        Ok(sync::list_calendars_for_connect(&self.transport()).await?)
    }
}

impl CalendarProvider for ReplayGoogle {
    async fn list_calendars(&self, _account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        Ok(sync::list_calendars(&self.transport()).await?)
    }

    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        Ok(sync::sync_calendar(&self.transport(), &calendar.calendar_id, since.as_ref()).await?)
    }

    async fn fetch_event(
        &self,
        calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert> {
        Ok(sync::fetch_one(&self.transport(), &calendar.calendar_id, event_ref).await?)
    }

    async fn current_sync_token(
        &self,
        _calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        Ok(None)
    }
}
