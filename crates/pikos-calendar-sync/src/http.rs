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

/// Certificates are checked by the OS, not against a root list compiled into the binary:
/// a bundled list rejects any authority the user's Mac trusts and Mozilla doesn't (a work
/// network that inspects TLS, the fixture-recording proxy), failing every connect as
/// "error sending request".
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

/// Never auto-follows redirects: CalDAV discovery follows `.well-known` by hand to
/// re-apply the original scheme when a `Location` downgrades https→http, and reqwest
/// turns a 301/302 on a PROPFIND into a bodyless GET.
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

/// Send `request`, read its body, and log it. A failure comes back without its URL, so a caller
/// can put the error in a message or the log without carrying a query string or an email.
pub(crate) async fn fetch(request: reqwest::RequestBuilder) -> Result<Fetched, reqwest::Error> {
    let (client, request) = request.build_split();
    let request = request.map_err(reqwest::Error::without_url)?;
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
    .await
    .map_err(reqwest::Error::without_url);

    let answer = match &fetched {
        Ok(f) => Ok((f.status, f.body.len())),
        Err(e) => Err(failure(e)),
    };
    log_request(
        method.as_str(),
        url.host_str().unwrap_or_default(),
        url.path(),
        answer,
    );
    fetched
}

/// Why a request got no answer: reqwest's failure class, then the error and each cause under it,
/// so a DNS miss, a refused connection and a certificate rejection read differently. The chain is
/// hyper, io and rustls text, which names a host at most; callers strip the URL first.
pub(crate) fn failure(e: &(dyn std::error::Error + 'static)) -> String {
    // oauth2 boxes its reqwest error, and the box is what sits in the chain.
    let class = causes(e)
        .find_map(|e| {
            e.downcast_ref::<reqwest::Error>()
                .or_else(|| e.downcast_ref::<Box<reqwest::Error>>().map(|b| &**b))
        })
        .map_or("other", |r| failure_class(r, e));
    let chain: Vec<String> = causes(e).map(ToString::to_string).collect();
    format!("{class}: {}", chain.join(": "))
}

fn causes<'a>(
    e: &'a (dyn std::error::Error + 'static),
) -> impl Iterator<Item = &'a (dyn std::error::Error + 'static)> {
    std::iter::successors(Some(e), |e| e.source())
}

fn failure_class(r: &reqwest::Error, whole: &(dyn std::error::Error + 'static)) -> &'static str {
    if r.is_timeout() {
        "timeout"
    } else if causes(whole).any(is_tls) {
        "tls"
    } else if causes(whole).any(|e| e.to_string().starts_with("dns error")) {
        // hyper-util's connect error is private, so its fixed "dns error" text is the only seam.
        "dns"
    } else if r.is_connect() {
        "connect"
    } else if r.is_body() {
        "body"
    } else if r.is_decode() {
        "decode"
    } else if r.is_status() {
        "status"
    } else if r.is_redirect() {
        "redirect"
    } else if r.is_request() {
        "request"
    } else if r.is_builder() {
        "builder"
    } else {
        "other"
    }
}

/// tokio-rustls hands a handshake failure back as an io error wrapping the rustls one, and an io
/// error's `source` skips past what it wraps, so the wrapped error is looked at directly.
fn is_tls(e: &(dyn std::error::Error + 'static)) -> bool {
    e.is::<rustls::Error>()
        || e.downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .is_some_and(|inner| inner.is::<rustls::Error>())
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
            let response = self.0.call(request).await.map_err(|e| match e {
                oauth2::HttpClientError::Reqwest(e) => {
                    oauth2::HttpClientError::Reqwest(Box::new(e.without_url()))
                }
                other => other,
            });
            let answer = match &response {
                Ok(r) => Ok((r.status().as_u16(), r.body().len())),
                Err(e) => Err(failure(e)),
            };
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

/// `answer` is the status and body size, or why no response came back.
fn log_request(method: &str, host: &str, path: &str, answer: Result<(u16, usize), String>) {
    match answer {
        Ok((status, bytes)) => {
            log::info!(
                "request method={method} host={host} path={path} status={status} bytes={bytes}"
            )
        }
        Err(reason) => {
            log::info!("request method={method} host={host} path={path} failed reason={reason}")
        }
    }
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod http_tests;
