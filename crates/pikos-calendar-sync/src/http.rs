//! Shared `reqwest::Client` for sync providers to clone — one connection pool,
//! uniform TLS/timeouts/user-agent. No provider logic here.

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
    builder
        .with_platform_verifier()
        .expect("the platform verifier should always build")
        .with_no_client_auth()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_builds() {
        let _ = client();
    }
}
