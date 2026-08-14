//! Layer-1 auth tests. Google's token and revocation endpoints are scripted
//! through `AsyncHttpClient`; the OAuth client is built here rather than from
//! the build's credentials, so the whole flow runs in a build that ships no
//! Google client at all.

use std::cell::RefCell;
use std::collections::VecDeque;

use oauth2::basic::BasicClient;
use oauth2::{AuthUrl, ClientId, ClientSecret, HttpRequest, HttpResponse, RevocationUrl, TokenUrl};
use url::Url;

use crate::test_support::memory_keychain;

use super::*;

const ACCOUNT: &str = "acct-1";

fn test_client() -> GoogleOauthClient {
    BasicClient::new(ClientId::new("test-client-id".into()))
        .set_client_secret(ClientSecret::new("test-client-secret".into()))
        .set_auth_uri(AuthUrl::new("https://accounts.example/authorize".into()).unwrap())
        .set_token_uri(TokenUrl::new("https://oauth.example/token".into()).unwrap())
        .set_revocation_url(RevocationUrl::new("https://oauth.example/revoke".into()).unwrap())
}

#[derive(Debug, thiserror::Error)]
#[error("scripted transport failure")]
struct TransportDown;

/// Replays canned responses in order and records the form bodies sent, so a test
/// can assert what Pikos actually asked Google for.
struct Scripted {
    responses: RefCell<VecDeque<(u16, String)>>,
    sent: RefCell<Vec<String>>,
}

impl Scripted {
    fn new(responses: impl IntoIterator<Item = (u16, String)>) -> Self {
        Self {
            responses: RefCell::new(responses.into_iter().collect()),
            sent: RefCell::new(Vec::new()),
        }
    }

    fn ok(body: impl Into<String>) -> Self {
        Self::new([(200, body.into())])
    }

    fn failing(status: u16, body: &str) -> Self {
        Self::new([(status, body.to_string())])
    }

    /// No scripted responses — any request the code makes fails the test.
    fn silent() -> Self {
        Self::new([])
    }

    /// The form fields of the nth request, as `key=value` pairs.
    fn form(&self, index: usize) -> Vec<(String, String)> {
        let body = &self.sent.borrow()[index];
        Url::parse(&format!("http://form.example/?{body}"))
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    fn field(&self, index: usize, key: &str) -> Option<String> {
        self.form(index)
            .into_iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
}

impl<'c> oauth2::AsyncHttpClient<'c> for Scripted {
    type Error = TransportDown;
    type Future = std::future::Ready<Result<HttpResponse, TransportDown>>;

    fn call(&'c self, request: HttpRequest) -> Self::Future {
        self.sent
            .borrow_mut()
            .push(String::from_utf8_lossy(request.body()).into_owned());
        let Some((status, body)) = self.responses.borrow_mut().pop_front() else {
            return std::future::ready(Err(TransportDown));
        };
        std::future::ready(Ok(oauth2::http::Response::builder()
            .status(status)
            .header(oauth2::http::header::CONTENT_TYPE, "application/json")
            .body(body.into_bytes())
            .unwrap()))
    }
}

const GRANTED_SCOPES: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly \
                              https://www.googleapis.com/auth/calendar.events.readonly";

fn token_json(access: &str, refresh: Option<&str>, expires_in: u32) -> String {
    let refresh = refresh
        .map(|r| format!(r#""refresh_token":"{r}","#))
        .unwrap_or_default();
    format!(
        r#"{{"access_token":"{access}","token_type":"Bearer",{refresh}"expires_in":{expires_in},"scope":"{GRANTED_SCOPES}"}}"#
    )
}

fn stored(keychain: &Keychain) -> GoogleCredentials {
    GoogleCredentials::from_blob(&keychain.load(ACCOUNT).unwrap()).unwrap()
}

fn credentials(access: &str, refresh: &str, expires_at: Option<&str>) -> GoogleCredentials {
    GoogleCredentials {
        access_token: access.into(),
        refresh_token: refresh.into(),
        expires_at: expires_at.map(str::to_string),
        granted_scopes: SCOPES.iter().map(|s| (*s).to_string()).collect(),
    }
}

// The consent URL is the contract with the verified Google app: the scopes it
// carries must match what the consent screen declares.
#[tokio::test]
async fn the_consent_url_asks_for_pkce_offline_access_and_only_the_declared_scopes() {
    let pending = begin_with(test_client()).await.unwrap();
    let url = Url::parse(pending.authorize_url()).unwrap();
    let params: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let get = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };

    assert_eq!(get("code_challenge_method"), "S256");
    assert!(!get("code_challenge").is_empty());
    assert_eq!(get("access_type"), "offline");
    assert_eq!(get("prompt"), "consent");
    assert!(!get("state").is_empty());
    assert!(get("redirect_uri").starts_with("http://127.0.0.1:"));

    let mut requested: Vec<String> = get("scope").split(' ').map(str::to_string).collect();
    requested.sort();
    let mut declared: Vec<String> = SCOPES.iter().map(|s| (*s).to_string()).collect();
    declared.sort();
    assert_eq!(requested, declared);
}

#[tokio::test]
async fn a_spent_access_token_is_refreshed_and_the_new_one_returned() {
    let keychain = memory_keychain();
    store(
        &keychain,
        ACCOUNT,
        &credentials("old-access", "rt", Some("2020-01-01T00:00:00.000Z")),
    )
    .unwrap();
    let http = Scripted::ok(token_json("new-access", None, 3600));

    let token = access_token_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap();

    assert_eq!(token, "new-access");
    assert_eq!(http.field(0, "grant_type").unwrap(), "refresh_token");
    assert_eq!(http.field(0, "refresh_token").unwrap(), "rt");
}

#[tokio::test]
async fn a_live_access_token_is_reused_without_calling_google() {
    let keychain = memory_keychain();
    store(
        &keychain,
        ACCOUNT,
        &credentials("live-access", "rt", Some("2099-01-01T00:00:00.000Z")),
    )
    .unwrap();
    // No scripted responses: any request would fail the test outright.
    let http = Scripted::silent();

    let token = access_token_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap();

    assert_eq!(token, "live-access");
    assert!(http.sent.borrow().is_empty());
}

#[tokio::test]
async fn a_rotated_refresh_token_replaces_the_stored_one() {
    let keychain = memory_keychain();
    store(
        &keychain,
        ACCOUNT,
        &credentials("old-access", "old-refresh", None),
    )
    .unwrap();
    let http = Scripted::ok(token_json("new-access", Some("rotated-refresh"), 3600));

    access_token_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap();

    assert_eq!(stored(&keychain).refresh_token, "rotated-refresh");
}

#[tokio::test]
async fn an_unrotated_refresh_token_survives_the_refresh() {
    let keychain = memory_keychain();
    store(
        &keychain,
        ACCOUNT,
        &credentials("old-access", "keep-me", None),
    )
    .unwrap();
    let http = Scripted::ok(token_json("new-access", None, 3600));

    access_token_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap();

    let after = stored(&keychain);
    assert_eq!(after.refresh_token, "keep-me");
    assert_eq!(after.access_token, "new-access");
    // A refresh that dropped the scopes would read as consent withdrawn.
    assert!(after.missing_scopes().is_empty());
}

// The engine maps Invalid → ReconnectNeeded and Network → Offline. A revoked
// grant read as Offline would poll a dead account forever with no prompt.
#[tokio::test]
async fn a_revoked_grant_is_reconnect_needed_not_a_transient_failure() {
    let keychain = memory_keychain();
    store(&keychain, ACCOUNT, &credentials("old-access", "rt", None)).unwrap();
    let http = Scripted::failing(400, r#"{"error":"invalid_grant"}"#);

    let err = access_token_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap_err();

    assert!(matches!(err, GoogleError::Revoked));
}

#[tokio::test]
async fn a_transport_failure_is_network_so_the_cursor_survives() {
    let keychain = memory_keychain();
    store(&keychain, ACCOUNT, &credentials("old-access", "rt", None)).unwrap();
    let http = Scripted::silent();

    let err = access_token_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap_err();

    assert!(matches!(err, GoogleError::Network(_)));
}

#[tokio::test]
async fn a_missing_keychain_entry_asks_for_a_reconnect() {
    let keychain = memory_keychain();
    let http = Scripted::silent();

    let err = access_token_with(&keychain, "never-connected", &test_client(), &http)
        .await
        .unwrap_err();

    assert!(matches!(err, GoogleError::Revoked));
}

#[tokio::test]
async fn revoke_sends_the_refresh_token_so_the_whole_grant_drops() {
    let keychain = memory_keychain();
    store(&keychain, ACCOUNT, &credentials("access", "rt", None)).unwrap();
    let http = Scripted::ok("");

    revoke_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap();

    assert_eq!(http.field(0, "token").unwrap(), "rt");
    assert_eq!(http.field(0, "token_type_hint").unwrap(), "refresh_token");
}

#[tokio::test]
async fn revoking_an_already_revoked_grant_succeeds() {
    let keychain = memory_keychain();
    store(&keychain, ACCOUNT, &credentials("access", "rt", None)).unwrap();
    let http = Scripted::failing(400, r#"{"error":"invalid_token"}"#);

    revoke_with(&keychain, ACCOUNT, &test_client(), &http)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_second_account_gets_its_own_credentials() {
    let keychain = memory_keychain();
    store(
        &keychain,
        "acct-work",
        &credentials("work-access", "work-rt", None),
    )
    .unwrap();
    store(
        &keychain,
        "acct-personal",
        &credentials("home-access", "home-rt", None),
    )
    .unwrap();

    let http = Scripted::ok(token_json("refreshed", None, 3600));
    access_token_with(&keychain, "acct-work", &test_client(), &http)
        .await
        .unwrap();

    let personal = GoogleCredentials::from_blob(&keychain.load("acct-personal").unwrap()).unwrap();
    assert_eq!(personal.access_token, "home-access");
    assert_eq!(personal.refresh_token, "home-rt");
}

// ─── the redirect leg of the grant ──────────────────────────────────────────────
//
// Everything above starts from stored credentials; these drive the one-shot
// exchange that produces them. The loopback is real (the same TCP round-trip the
// browser makes) and the token endpoint is scripted, so the whole grant runs in a
// build carrying no Google client. `complete_with` consumes the authorization and
// waits on the listener, so the redirect has to be driven concurrently — and on
// this task, since the scripted transport is not `Send`.

fn loopback_port(pending: &PendingAuth) -> u16 {
    pending
        .redirect_uri
        .as_str()
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.trim_end_matches('/').parse().ok())
        .expect("loopback redirect carries a port")
}

/// Answer the pending authorization's redirect the way the browser would.
async fn redirect_with(port: u16, state: &str) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    stream
        .write_all(
            format!("GET /?code=auth-code&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
}

/// The CSRF check is what stops a page the user happens to have open from firing a
/// code of its own at the listener — the loopback answers anything that reaches the
/// port. Rejection has to come *before* the exchange: the scripted transport holds
/// no responses, so a token request at all fails the test.
#[tokio::test]
async fn a_redirect_carrying_someone_elses_state_never_reaches_the_token_endpoint() {
    let pending = begin_with(test_client()).await.unwrap();
    let port = loopback_port(&pending);
    let http = Scripted::silent();

    let (result, ()) = tokio::join!(
        pending.complete_with(test_client(), &http),
        redirect_with(port, "not-the-state"),
    );

    assert!(matches!(result, Err(GoogleError::Protocol(_))));
}

/// Google's granular consent lets the user approve a subset. Syncing on a partial
/// grant would poll calendars it can never read, so connect refuses instead.
#[tokio::test]
async fn a_grant_missing_a_scope_is_refused_rather_than_half_connected() {
    let pending = begin_with(test_client()).await.unwrap();
    let port = loopback_port(&pending);
    let state = pending.csrf.secret().clone();
    let partial = format!(
        r#"{{"access_token":"at","token_type":"Bearer","refresh_token":"rt","expires_in":3600,"scope":"{}"}}"#,
        SCOPES[0]
    );
    let http = Scripted::ok(partial);

    let (result, ()) = tokio::join!(
        pending.complete_with(test_client(), &http),
        redirect_with(port, &state),
    );

    assert!(matches!(result, Err(GoogleError::ScopesWithheld)));
}

#[tokio::test]
async fn a_full_grant_yields_credentials_carrying_both_tokens() {
    let pending = begin_with(test_client()).await.unwrap();
    let port = loopback_port(&pending);
    let state = pending.csrf.secret().clone();
    let http = Scripted::ok(token_json("at", Some("rt"), 3600));

    let (result, ()) = tokio::join!(
        pending.complete_with(test_client(), &http),
        redirect_with(port, &state),
    );

    let credentials = result.unwrap();
    assert_eq!(credentials.access_token, "at");
    assert_eq!(credentials.refresh_token, "rt");
    assert!(credentials.missing_scopes().is_empty());
}
