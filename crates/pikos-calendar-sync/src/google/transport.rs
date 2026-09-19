//! The Calendar API transport seam. Sync logic talks to this trait so it can be
//! exercised against recorded fixtures (Layer 1) with no network and no OAuth
//! client; production uses [`ReqwestGoogle`].
//!
//! Only GET is modelled — sync is read-only end to end, so there is no verb here
//! that could mutate a user's calendar even by mistake.

use super::error::GoogleError;
use crate::http;

/// One Calendar API response, reduced to what sync needs. The body is left
/// unparsed so the caller can branch on status before trusting it.
pub(crate) struct GoogleResponse {
    pub status: u16,
    pub body: String,
}

#[allow(async_fn_in_trait)]
pub(crate) trait GoogleTransport {
    /// GET `path` (relative to the API root) with `query` as URL parameters.
    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<GoogleResponse, GoogleError>;
}

const API_ROOT: &str = "https://www.googleapis.com/calendar/v3";

/// Production transport: bearer auth against the Calendar API.
///
/// The access token is resolved once per sync and handed in, rather than being
/// refreshed per request — a refresh rotates the stored refresh token, so doing it
/// mid-sync would race the persist step (see [`super::auth`]).
pub(crate) struct ReqwestGoogle {
    client: reqwest::Client,
    access_token: String,
}

impl ReqwestGoogle {
    pub(crate) fn new(access_token: impl Into<String>) -> Self {
        Self {
            client: http::client(),
            access_token: access_token.into(),
        }
    }
}

impl GoogleTransport for ReqwestGoogle {
    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<GoogleResponse, GoogleError> {
        let resp = self
            .client
            .get(format!("{API_ROOT}{path}"))
            .bearer_auth(&self.access_token)
            .query(query)
            .send()
            .await
            .map_err(|e| GoogleError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| GoogleError::Network(e.to_string()))?;

        Ok(GoogleResponse { status, body })
    }
}
