//! The OAuth 2.0 + PKCE grant, and the token lifecycle that follows it.
//!
//! Split in two so the caller can open the browser between the halves:
//! [`begin_authorization`] binds the loopback port and builds the consent URL,
//! [`PendingAuth::complete`] waits for the redirect and trades the code for
//! tokens. [`access_token`] then keeps a bearer token live, and [`revoke`]
//! returns the grant to Google on disconnect.
//!
//! Public entry points resolve the build's OAuth and HTTP clients; the work
//! happens in inner functions that take both, so tests drive the whole flow
//! against scripted responses without build-time credentials — the same seam
//! CalDAV's `DavTransport` provides.

use std::time::Duration;

use oauth2::basic::{BasicErrorResponse, BasicErrorResponseType, BasicRevocationErrorResponse};
use oauth2::{
    AsyncHttpClient, AuthorizationCode, CsrfToken, ErrorResponse, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, RefreshToken, RequestTokenError, Scope,
};

use crate::keychain::Keychain;

use super::config::{self, GoogleOauthClient, SCOPES};
use super::credentials::GoogleCredentials;
use super::error::GoogleError;
use super::loopback::Loopback;

/// How long the loopback listener waits for the user to finish in the browser.
/// Long enough to sign in and pick an account; short enough that an abandoned
/// attempt releases the port instead of holding it for the session.
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(300);

/// An authorization waiting on the user's browser. Holds the bound loopback port,
/// so dropping it without completing releases the port and abandons the attempt.
pub struct PendingAuth {
    loopback: Loopback,
    redirect_uri: RedirectUrl,
    authorize_url: String,
    csrf: CsrfToken,
    verifier: PkceCodeVerifier,
}

/// Bind the redirect listener and build the consent URL. The caller opens it in
/// the user's browser — Google's Desktop client type requires a real browser, not
/// an embedded webview.
pub async fn begin_authorization() -> Result<PendingAuth, GoogleError> {
    begin_with(config::oauth_client()?).await
}

async fn begin_with(client: GoogleOauthClient) -> Result<PendingAuth, GoogleError> {
    let loopback = Loopback::bind().await?;
    let redirect_uri = RedirectUrl::new(loopback.redirect_uri())
        .map_err(|e| GoogleError::Protocol(format!("invalid loopback redirect: {e}")))?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();

    let (url, csrf) = client
        .set_redirect_uri(redirect_uri.clone())
        .authorize_url(CsrfToken::new_random)
        .add_scopes(SCOPES.iter().map(|s| Scope::new((*s).to_string())))
        .set_pkce_challenge(challenge)
        // Google issues a refresh token only for an offline grant with consent
        // actually shown — a silently re-approved grant returns an access token
        // that dies in an hour with no way to renew it.
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .url();

    Ok(PendingAuth {
        loopback,
        redirect_uri,
        authorize_url: url.to_string(),
        csrf,
        verifier,
    })
}

impl PendingAuth {
    /// The consent URL to open in the browser.
    pub fn authorize_url(&self) -> &str {
        &self.authorize_url
    }

    /// Wait for the redirect, then exchange the code for tokens.
    pub async fn complete(self) -> Result<GoogleCredentials, GoogleError> {
        let client = config::oauth_client()?;
        self.complete_with(client, &crate::http::client()).await
    }

    async fn complete_with<C>(
        self,
        client: GoogleOauthClient,
        http: &C,
    ) -> Result<GoogleCredentials, GoogleError>
    where
        C: for<'a> AsyncHttpClient<'a>,
    {
        let callback = self.loopback.wait(AUTHORIZATION_TIMEOUT).await?;
        if callback.state != *self.csrf.secret() {
            return Err(GoogleError::Protocol(
                "the redirect carried a state Pikos didn't issue".into(),
            ));
        }

        let client = client.set_redirect_uri(self.redirect_uri);
        let response = client
            .exchange_code(AuthorizationCode::new(callback.code))
            .set_pkce_verifier(self.verifier)
            .request_async(http)
            .await
            .map_err(token_error)?;

        let credentials = GoogleCredentials::from_response(&response, None)?;
        let missing = credentials.missing_scopes();
        if !missing.is_empty() {
            log::warn!("google: consent withheld scopes: {}", missing.join(", "));
            return Err(GoogleError::ScopesWithheld);
        }
        Ok(credentials)
    }
}

/// Persist an account's credentials. The keychain key is the `sync_account` row
/// id, so a second Google account gets its own entry and can't overwrite the first.
pub fn store(
    keychain: &Keychain,
    account_id: &str,
    credentials: &GoogleCredentials,
) -> Result<(), GoogleError> {
    let blob = credentials
        .to_blob()
        .map_err(|e| GoogleError::Protocol(format!("serialize credentials: {e}")))?;
    keychain
        .store(account_id, &blob)
        .map_err(|e| GoogleError::Network(e.to_string()))
}

/// A usable bearer token for this account, refreshing in place when the stored
/// one is spent.
pub async fn access_token(keychain: &Keychain, account_id: &str) -> Result<String, GoogleError> {
    let client = config::oauth_client()?;
    access_token_with(keychain, account_id, &client, &crate::http::client()).await
}

async fn access_token_with<C>(
    keychain: &Keychain,
    account_id: &str,
    client: &GoogleOauthClient,
    http: &C,
) -> Result<String, GoogleError>
where
    C: for<'a> AsyncHttpClient<'a>,
{
    let credentials = load(keychain, account_id)?;
    if !credentials.needs_refresh() {
        return Ok(credentials.access_token);
    }
    let refreshed = refresh(client, http, &credentials).await?;
    // Written before the token is used: if Google rotated the refresh token, the
    // old one is already dead, so a lost write would strand the account.
    store(keychain, account_id, &refreshed)?;
    Ok(refreshed.access_token)
}

async fn refresh<C>(
    client: &GoogleOauthClient,
    http: &C,
    credentials: &GoogleCredentials,
) -> Result<GoogleCredentials, GoogleError>
where
    C: for<'a> AsyncHttpClient<'a>,
{
    let refresh_token = RefreshToken::new(credentials.refresh_token.clone());
    let response = client
        .exchange_refresh_token(&refresh_token)
        .request_async(http)
        .await
        .map_err(token_error)?;

    let mut refreshed =
        GoogleCredentials::from_response(&response, Some(&credentials.refresh_token))?;
    // A refresh response need not restate the grant; keep what consent established
    // rather than reading the omission as revoked scopes.
    if refreshed.granted_scopes.is_empty() {
        refreshed.granted_scopes = credentials.granted_scopes.clone();
    }
    Ok(refreshed)
}

/// Hand the grant back to Google so it disappears from the user's connected-apps
/// list, not just Pikos's. Idempotent — a grant Google already dropped is the
/// desired end state, so a repeat disconnect succeeds.
pub async fn revoke(keychain: &Keychain, account_id: &str) -> Result<(), GoogleError> {
    let client = config::oauth_client()?;
    revoke_with(keychain, account_id, &client, &crate::http::client()).await
}

async fn revoke_with<C>(
    keychain: &Keychain,
    account_id: &str,
    client: &GoogleOauthClient,
    http: &C,
) -> Result<(), GoogleError>
where
    C: for<'a> AsyncHttpClient<'a>,
{
    let credentials = load(keychain, account_id)?;
    // Revoking the refresh token invalidates every access token derived from it.
    let request = client
        .revoke_token(RefreshToken::new(credentials.refresh_token).into())
        .map_err(|e| GoogleError::Protocol(e.to_string()))?;

    match request.request_async(http).await {
        Ok(()) => Ok(()),
        Err(e) if already_revoked(&e) => Ok(()),
        Err(e) => Err(generic_token_error(e)),
    }
}

fn load(keychain: &Keychain, account_id: &str) -> Result<GoogleCredentials, GoogleError> {
    let blob = keychain.load(account_id).map_err(|e| {
        if e.is_reconnect_needed() {
            GoogleError::Revoked
        } else {
            GoogleError::Network(e.to_string())
        }
    })?;
    GoogleCredentials::from_blob(&blob)
        .map_err(|e| GoogleError::Protocol(format!("unreadable stored credentials: {e}")))
}

fn token_error<RE>(e: RequestTokenError<RE, BasicErrorResponse>) -> GoogleError
where
    RE: std::error::Error + 'static,
{
    match e {
        // `invalid_grant` covers every dead-grant case — revoked, expired
        // through disuse, or a code already redeemed. None recover without
        // fresh consent.
        RequestTokenError::ServerResponse(resp)
            if matches!(resp.error(), BasicErrorResponseType::InvalidGrant) =>
        {
            GoogleError::Revoked
        }
        other => generic_token_error(other),
    }
}

fn generic_token_error<RE, T>(e: RequestTokenError<RE, T>) -> GoogleError
where
    RE: std::error::Error + 'static,
    T: ErrorResponse + 'static,
{
    match e {
        RequestTokenError::Request(e) => GoogleError::Network(e.to_string()),
        RequestTokenError::ServerResponse(resp) => {
            GoogleError::Protocol(format!("Google rejected the request: {resp}"))
        }
        RequestTokenError::Parse(e, _) => {
            GoogleError::Protocol(format!("unreadable response from Google: {e}"))
        }
        RequestTokenError::Other(message) => GoogleError::Protocol(message),
    }
}

fn already_revoked<RE>(e: &RequestTokenError<RE, BasicRevocationErrorResponse>) -> bool
where
    RE: std::error::Error + 'static,
{
    matches!(e, RequestTokenError::ServerResponse(resp) if resp.error().as_ref() == "invalid_token")
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod auth_tests;
