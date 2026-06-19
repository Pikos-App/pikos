//! Shared `reqwest::Client` for sync providers to clone — one connection pool,
//! uniform TLS/timeouts/user-agent. No provider logic here.

use std::time::Duration;

const USER_AGENT: &str = concat!("Pikos-CalendarSync/", env!("CARGO_PKG_VERSION"));

/// The shared sync HTTP client; providers clone it.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
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
