//! The OAuth client Pikos is registered as, and the endpoints + scopes it talks
//! to. Everything here has a counterpart in the Google Cloud console, so treat a
//! change as a change to the published app: the consent screen declares
//! [`SCOPES`] verbatim, and requesting anything outside that set fails the grant.

use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, ClientId, ClientSecret, EndpointNotSet, EndpointSet, RevocationUrl, TokenUrl,
};

use super::error::GoogleError;

/// A desktop OAuth client's id and secret ship inside the binary — under PKCE the
/// secret isn't confidential and Google issues installed-app clients on that
/// basis. They're supplied at build time rather than committed so the public repo
/// doesn't advertise them; a build without them has no Google sync.
const CLIENT_ID: Option<&str> = option_env!("PIKOS_GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("PIKOS_GOOGLE_CLIENT_SECRET");

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

/// The narrowest pair that covers read-only sync: the calendar list, and events
/// on those calendars. Deliberately not `calendar.readonly`, which would also
/// hand us ACLs, settings and free/busy we never read.
///
/// These must match the verified consent screen exactly — widening the set means
/// re-submitting for verification, a multi-week external review.
pub(crate) const SCOPES: [&str; 2] = [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
];

/// Auth, token and revocation endpoints set; device-code and introspection unused.
pub(crate) type GoogleOauthClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointSet, EndpointSet>;

pub(crate) fn oauth_client() -> Result<GoogleOauthClient, GoogleError> {
    let (client_id, client_secret) = credentials().ok_or(GoogleError::NotConfigured)?;
    Ok(BasicClient::new(ClientId::new(client_id.to_string()))
        .set_client_secret(ClientSecret::new(client_secret.to_string()))
        .set_auth_uri(AuthUrl::new(AUTH_URL.to_string()).expect("static auth URL is valid"))
        .set_token_uri(TokenUrl::new(TOKEN_URL.to_string()).expect("static token URL is valid"))
        .set_revocation_url(
            RevocationUrl::new(REVOKE_URL.to_string()).expect("static revoke URL is valid"),
        ))
}

/// Whether this build can offer Google sync at all — the panel hides the option
/// rather than letting a connect attempt fail.
pub fn is_available() -> bool {
    credentials().is_some()
}

fn credentials() -> Option<(&'static str, &'static str)> {
    // An empty var is the same as an unset one: a CI job that exports the name
    // without a value must not produce a build that fails mid-grant instead.
    let id = CLIENT_ID.filter(|v| !v.is_empty())?;
    let secret = CLIENT_SECRET.filter(|v| !v.is_empty())?;
    Some((id, secret))
}
