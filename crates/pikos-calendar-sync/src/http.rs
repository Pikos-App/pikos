//! Shared `reqwest::Client` for sync providers to clone — one connection pool,
//! uniform TLS/timeouts/user-agent. No provider logic here.
//!
//! Every request a provider sends goes through [`fetch`] or [`OauthHttp`], which log one INFO
//! line for it, so the log alone answers "what has this app sent, and where". The line carries
//! the method, host, path, status and response size, and never a header, a body or a query
//! string, since tokens travel in all three.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rustls_platform_verifier::BuilderVerifierExt;

const USER_AGENT: &str = concat!("Pikos-CalendarSync/", env!("CARGO_PKG_VERSION"));

/// Certificates are checked by the OS, as Safari and the app's updater do, not against a root list
/// compiled into the binary. A bundled list rejects any certificate authority the user's Mac
/// trusts and Mozilla doesn't: a work network that inspects TLS, or the proxy that records
/// provider fixtures, failed every connect as "error sending request".
fn tls() -> rustls::ClientConfig {
    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("the default protocol versions should always build");
    #[cfg(test)]
    if let Some(roots) = recording_ca() {
        return builder.with_root_certificates(roots).with_no_client_auth();
    }
    builder
        .with_platform_verifier()
        .expect("the platform verifier should always build")
        .with_no_client_auth()
}

/// Test builds only: when `PIKOS_RECORD_CA` names a PEM certificate, trust that alone. The
/// recording test reaches a provider through a proxy that signs every host with it, and the OS
/// refuses that for Apple's servers whatever the Mac trusts, because they are pinned to Apple's
/// own chain.
#[cfg(test)]
fn recording_ca() -> Option<rustls::RootCertStore> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::CertificateDer;

    let path = std::env::var("PIKOS_RECORD_CA").ok()?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_file_iter(&path).expect("read PIKOS_RECORD_CA") {
        roots
            .add(cert.expect("parse PIKOS_RECORD_CA"))
            .expect("trust PIKOS_RECORD_CA");
    }
    Some(roots)
}

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .use_preconfigured_tls(tls())
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
}

pub fn client() -> reqwest::Client {
    builder()
        .build()
        .expect("reqwest rustls client should always build")
}

/// Like [`client`] but never auto-follows redirects. CalDAV discovery follows the
/// `.well-known` redirect by hand, so it can re-apply the original scheme/host when
/// a server's `Location` downgrades https→http — reqwest also turns a 301/302 on a
/// PROPFIND into a bodyless GET, which would silently break discovery.
pub fn client_no_redirect() -> reqwest::Client {
    builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("reqwest rustls client should always build")
}

/// A response with its body read.
pub(crate) struct Fetched {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: String,
}

/// Send `request`, read its body, and log it.
pub(crate) async fn fetch(request: reqwest::RequestBuilder) -> Result<Fetched, reqwest::Error> {
    let (client, request) = request.build_split();
    let request = request?;
    let method = request.method().clone();
    let url = request.url().clone();

    let fetched = async {
        let response = client.execute(request).await?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = response.text().await?;
        Ok(Fetched {
            status,
            headers,
            body,
        })
    }
    .await;

    let answer = fetched.as_ref().ok().map(|f| (f.status, f.body.len()));
    log_request(
        method.as_str(),
        url.host_str().unwrap_or_default(),
        url.path(),
        answer,
    );
    fetched
}

/// The HTTP client the OAuth grant sends through: oauth2's own reqwest adapter, logged as
/// [`fetch`] logs.
pub(crate) struct OauthHttp(reqwest::Client);

pub(crate) fn oauth_http() -> OauthHttp {
    OauthHttp(client())
}

impl<'c> oauth2::AsyncHttpClient<'c> for OauthHttp {
    type Error = oauth2::HttpClientError<reqwest::Error>;
    type Future =
        Pin<Box<dyn Future<Output = Result<oauth2::HttpResponse, Self::Error>> + Send + Sync + 'c>>;

    fn call(&'c self, request: oauth2::HttpRequest) -> Self::Future {
        let method = request.method().clone();
        let uri = request.uri().clone();

        Box::pin(async move {
            let response = self.0.call(request).await;
            let answer = response
                .as_ref()
                .ok()
                .map(|r| (r.status().as_u16(), r.body().len()));
            log_request(
                method.as_str(),
                uri.host().unwrap_or_default(),
                uri.path(),
                answer,
            );
            response
        })
    }
}

/// `answer` is the status and body size, or `None` when no response came back.
fn log_request(method: &str, host: &str, path: &str, answer: Option<(u16, usize)>) {
    match answer {
        Some((status, bytes)) => {
            log::info!(
                "request method={method} host={host} path={path} status={status} bytes={bytes}"
            )
        }
        None => log::info!("request method={method} host={host} path={path} failed"),
    }
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod http_tests;
