//! The Google half of the single opaque keychain blob per `sync_account` — the
//! parallel of `CaldavCredentials`, except Google needs several values (two
//! tokens, an expiry, the granted scopes) so they serialize together into the one
//! entry the keychain wrapper stores. Never persisted to SQLite.

use chrono::{DateTime, Duration, Utc};
use oauth2::{basic::BasicTokenResponse, TokenResponse};
use serde::{Deserialize, Serialize};

use super::config::SCOPES;
use super::error::GoogleError;

/// Refresh this far ahead of the stated expiry so a token can't lapse between the
/// check and the request it authorizes.
const EXPIRY_SKEW: Duration = Duration::seconds(60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleCredentials {
    pub access_token: String,
    /// The long-lived half. Google only issues one on a grant that asked for
    /// offline access with a forced consent prompt; without it the account dies
    /// silently an hour after connecting.
    pub refresh_token: String,
    /// RFC 3339 UTC. `None` when the token response omitted `expires_in`, which
    /// forces a refresh before every use rather than risking a stale token.
    pub expires_at: Option<String>,
    /// What the user actually granted. Google's granular consent screen lets them
    /// approve a subset, so this is not necessarily [`SCOPES`].
    pub granted_scopes: Vec<String>,
}

impl GoogleCredentials {
    /// Serialize for the keychain. The blob is opaque to the store.
    pub fn to_blob(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    pub fn from_blob(blob: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(blob)
    }

    /// Build from a fresh grant. `previous_refresh_token` carries the stored one
    /// through a refresh response, which normally omits it — Google may rotate,
    /// but usually returns the same token or none at all.
    pub(crate) fn from_response(
        response: &BasicTokenResponse,
        previous_refresh_token: Option<&str>,
    ) -> Result<Self, GoogleError> {
        let refresh_token = response
            .refresh_token()
            .map(|t| t.secret().to_string())
            .or_else(|| previous_refresh_token.map(str::to_string))
            .ok_or_else(|| {
                GoogleError::Protocol("Google returned no refresh token for this grant".into())
            })?;

        Ok(Self {
            access_token: response.access_token().secret().to_string(),
            refresh_token,
            expires_at: response
                .expires_in()
                .and_then(|d| Duration::from_std(d).ok())
                .map(|d| format_instant(Utc::now() + d)),
            granted_scopes: response
                .scopes()
                .map(|s| s.iter().map(|scope| scope.to_string()).collect())
                .unwrap_or_default(),
        })
    }

    /// True when the access token is past its expiry, within [`EXPIRY_SKEW`], or
    /// carries no expiry at all.
    pub(crate) fn needs_refresh(&self) -> bool {
        self.needs_refresh_at(Utc::now())
    }

    fn needs_refresh_at(&self, now: DateTime<Utc>) -> bool {
        let Some(expires_at) = &self.expires_at else {
            return true;
        };
        match DateTime::parse_from_rfc3339(expires_at) {
            Ok(expiry) => now + EXPIRY_SKEW >= expiry.with_timezone(&Utc),
            // An unreadable expiry is a corrupt blob; refreshing costs one request
            // and heals it, where trusting it would use a token of unknown age.
            Err(_) => true,
        }
    }

    /// Every scope the sync engine needs, or the ones the user withheld. Google's
    /// granular consent lets a user approve the calendar list but not the events,
    /// which yields a token that authorizes nothing useful — better to say so at
    /// connect time than to sync empty calendars forever.
    pub(crate) fn missing_scopes(&self) -> Vec<&'static str> {
        SCOPES
            .into_iter()
            .filter(|required| !self.granted_scopes.iter().any(|g| g == required))
            .collect()
    }
}

fn format_instant(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(expires_at: Option<&str>, scopes: &[&str]) -> GoogleCredentials {
        GoogleCredentials {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: expires_at.map(str::to_string),
            granted_scopes: scopes.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn at(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn blob_round_trips() {
        let c = creds(Some("2026-07-21T10:00:00.000Z"), &SCOPES);
        assert_eq!(
            GoogleCredentials::from_blob(&c.to_blob().unwrap()).unwrap(),
            c
        );
    }

    #[test]
    fn a_token_well_inside_its_life_is_reused() {
        let c = creds(Some("2026-07-21T10:00:00.000Z"), &[]);
        assert!(!c.needs_refresh_at(at("2026-07-21T09:30:00Z")));
    }

    // The skew is the point of the check: a token expiring in 30s would otherwise
    // be handed to a request that outlives it.
    #[test]
    fn a_token_inside_the_skew_window_refreshes() {
        let c = creds(Some("2026-07-21T10:00:00.000Z"), &[]);
        assert!(c.needs_refresh_at(at("2026-07-21T09:59:30Z")));
    }

    #[test]
    fn a_missing_or_unreadable_expiry_refreshes() {
        assert!(creds(None, &[]).needs_refresh_at(at("2026-07-21T09:00:00Z")));
        assert!(creds(Some("not-a-date"), &[]).needs_refresh_at(at("2026-07-21T09:00:00Z")));
    }

    #[test]
    fn missing_scopes_names_only_what_was_withheld() {
        assert!(creds(None, &SCOPES).missing_scopes().is_empty());
        assert_eq!(creds(None, &[SCOPES[0]]).missing_scopes(), vec![SCOPES[1]]);
        assert_eq!(creds(None, &[]).missing_scopes(), SCOPES.to_vec());
    }
}
