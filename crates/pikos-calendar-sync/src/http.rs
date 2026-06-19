//! Shared `reqwest::Client` for sync providers to clone — one connection pool,
//! uniform TLS/timeouts/user-agent. No provider logic here.

use std::time::Duration;

const USER_AGENT: &str = concat!("Pikos-CalendarSync/", env!("CARGO_PKG_VERSION"));

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
}

/// The shared sync HTTP client; providers clone it.
pub fn client() -> reqwest::Client {
    builder()
        .build()
        .expect("reqwest rustls client should always build")
}

/// Like [`client`] but never auto-follows redirects. CalDAV discovery follows
/// the `.well-known` redirect by hand so it can re-apply the original scheme/host
/// when a server's `Location` downgrades https→http (reqwest also turns a 301/302
/// on a PROPFIND into a bodyless GET, which would silently break discovery).
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
