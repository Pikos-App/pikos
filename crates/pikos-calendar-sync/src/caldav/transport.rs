//! The PROPFIND transport seam. Discovery logic talks to this trait so it can be
//! exercised against recorded fixtures (Layer 1) with no network; production uses
//! [`ReqwestDav`]. Redirects are surfaced, not auto-followed — discovery re-applies
//! the original scheme/host itself (see [`crate::http::client_no_redirect`]).

use super::error::CaldavError;
use crate::http;

/// One PROPFIND response, reduced to what discovery needs.
pub(crate) struct DavResponse {
    pub status: u16,
    /// `Location` header, present on a 3xx.
    pub location: Option<String>,
    pub body: String,
}

#[allow(async_fn_in_trait)]
pub(crate) trait DavTransport {
    /// Issue a PROPFIND with the given `Depth` and XML body.
    async fn propfind(
        &self,
        url: &str,
        depth: &str,
        body: &str,
    ) -> Result<DavResponse, CaldavError>;

    /// Issue a REPORT with the given `Depth` and XML body — the verb behind
    /// `sync-collection`, `calendar-query`, and `calendar-multiget`.
    async fn report(&self, url: &str, depth: &str, body: &str) -> Result<DavResponse, CaldavError>;
}

/// Production transport: preemptive Basic auth over a no-redirect client.
pub(crate) struct ReqwestDav {
    client: reqwest::Client,
    username: String,
    password: String,
}

impl ReqwestDav {
    pub(crate) fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            client: http::client_no_redirect(),
            username: username.into(),
            password: password.into(),
        }
    }
}

impl ReqwestDav {
    /// Shared body for the WebDAV verbs (PROPFIND/REPORT) — same preemptive Basic
    /// auth, Depth, and XML content type; only the method differs.
    async fn send(
        &self,
        method: &[u8],
        url: &str,
        depth: &str,
        body: &str,
    ) -> Result<DavResponse, CaldavError> {
        let method = reqwest::Method::from_bytes(method).expect("valid WebDAV method");
        let resp = self
            .client
            .request(method, url)
            // Sent preemptively — iCloud/Fastmail expect Basic without a challenge round-trip.
            .basic_auth(&self.username, Some(&self.password))
            .header("Depth", depth)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/xml; charset=utf-8",
            )
            .body(body.to_owned())
            .send()
            .await
            .map_err(|e| CaldavError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = resp
            .text()
            .await
            .map_err(|e| CaldavError::Network(e.to_string()))?;

        Ok(DavResponse {
            status,
            location,
            body,
        })
    }
}

impl DavTransport for ReqwestDav {
    async fn propfind(
        &self,
        url: &str,
        depth: &str,
        body: &str,
    ) -> Result<DavResponse, CaldavError> {
        self.send(b"PROPFIND", url, depth, body).await
    }

    async fn report(&self, url: &str, depth: &str, body: &str) -> Result<DavResponse, CaldavError> {
        self.send(b"REPORT", url, depth, body).await
    }
}
