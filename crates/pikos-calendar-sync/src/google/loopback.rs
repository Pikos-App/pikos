//! Ephemeral loopback redirect receiver (RFC 8252). Google's Desktop client type
//! accepts no other redirect — custom schemes are rejected, OOB was removed in
//! 2023 — so the grant returns to a `127.0.0.1:0` listener bound for one
//! authorization, then dropped. Loopback binding and PKCE together stop another
//! app from hijacking the redirect.

use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use url::Url;

use super::error::GoogleError;

/// A browser request line longer than this isn't the redirect — stop reading
/// rather than buffer whatever an unrelated local client decided to send.
const MAX_REQUEST_LINE: u64 = 8 * 1024;

/// The query Google appended to the redirect.
pub(crate) struct Callback {
    pub code: String,
    /// Echoed back for comparison against the CSRF token we issued.
    pub state: String,
}

pub(crate) struct Loopback {
    listener: TcpListener,
    port: u16,
}

impl Loopback {
    pub(crate) async fn bind() -> Result<Self, GoogleError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| GoogleError::Network(format!("could not open a local port: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| GoogleError::Network(format!("could not read the local port: {e}")))?
            .port();
        Ok(Self { listener, port })
    }

    /// The `redirect_uri` to hand Google. The port is whatever the OS just gave
    /// us; Google accepts any loopback port for a Desktop client.
    pub(crate) fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Serve until the redirect arrives. Consumes the listener, so the port is
    /// released whether the grant lands, fails, or times out.
    pub(crate) async fn wait(self, timeout: Duration) -> Result<Callback, GoogleError> {
        tokio::time::timeout(timeout, self.accept_callback())
            .await
            .map_err(|_| GoogleError::Cancelled)?
    }

    async fn accept_callback(self) -> Result<Callback, GoogleError> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|e| GoogleError::Network(format!("loopback accept failed: {e}")))?;

            let (read_half, mut write_half) = stream.split();
            let mut request_line = String::new();
            BufReader::new(read_half.take(MAX_REQUEST_LINE))
                .read_line(&mut request_line)
                .await
                .map_err(|e| GoogleError::Network(format!("loopback read failed: {e}")))?;

            let outcome = classify(&request_line);
            let (status, body) = match &outcome {
                Outcome::Redirect(Ok(_)) => ("200 OK", page(CONNECTED)),
                Outcome::Redirect(Err(_)) => ("200 OK", page(NOT_CONNECTED)),
                Outcome::Unrelated => ("404 Not Found", String::new()),
            };
            respond(&mut write_half, status, &body).await?;

            match outcome {
                // Browsers also hit this origin for /favicon.ico; answering and
                // continuing keeps that from being mistaken for the redirect.
                Outcome::Unrelated => continue,
                Outcome::Redirect(result) => return result,
            }
        }
    }
}

enum Outcome {
    Redirect(Result<Callback, GoogleError>),
    Unrelated,
}

fn classify(request_line: &str) -> Outcome {
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return Outcome::Unrelated;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Outcome::Unrelated;
    };

    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }

    if let Some(error) = error {
        return Outcome::Redirect(Err(if error == "access_denied" {
            GoogleError::Cancelled
        } else {
            GoogleError::Protocol(format!("Google refused the authorization: {error}"))
        }));
    }
    match (code, state) {
        (Some(code), Some(state)) => Outcome::Redirect(Ok(Callback { code, state })),
        // A code with no state can't be verified against our CSRF token, so it's
        // not usable even though it looks like the redirect.
        (Some(_), None) => Outcome::Redirect(Err(GoogleError::Protocol(
            "Google's redirect carried no state parameter".into(),
        ))),
        _ => Outcome::Unrelated,
    }
}

async fn respond<W>(writer: &mut W, status: &str, body: &str) -> Result<(), GoogleError>
where
    W: AsyncWriteExt + Unpin,
{
    let response = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    writer
        .write_all(response.as_bytes())
        .await
        .map_err(|e| GoogleError::Network(format!("loopback write failed: {e}")))?;
    writer
        .shutdown()
        .await
        .map_err(|e| GoogleError::Network(format!("loopback close failed: {e}")))
}

/// The tab the user is left looking at — plain, self-contained, and dark-aware,
/// since it renders in whatever browser they happen to use.
fn page(message: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>Pikos</title>\
         <style>:root{{color-scheme:light dark}}body{{margin:0;height:100vh;display:grid;\
         place-items:center;font:16px/1.5 system-ui,sans-serif}}</style><p>{message}"
    )
}

const CONNECTED: &str = "Google Calendar is connected. You can close this tab.";
const NOT_CONNECTED: &str = "Pikos wasn’t connected. You can close this tab and try again.";

#[cfg(test)]
#[path = "loopback_tests.rs"]
mod loopback_tests;
