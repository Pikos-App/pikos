//! The loopback receiver drives a real TCP round-trip on an ephemeral port — the
//! same path the browser takes, so nothing here mocks the transport.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::*;

fn port_of(loopback: &Loopback) -> u16 {
    let uri = loopback.redirect_uri();
    let port = uri
        .strip_prefix("http://127.0.0.1:")
        .expect("redirect URI must be loopback — Google rejects anything else");
    port.parse().expect("redirect URI must end in a port")
}

async fn get(port: u16, target: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream
        .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn the_redirect_hands_back_the_code_and_state() {
    let loopback = Loopback::bind().await.unwrap();
    let port = port_of(&loopback);
    let waiting = tokio::spawn(loopback.wait(Duration::from_secs(5)));

    let response = get(port, "/?code=auth-code&state=csrf-state").await;
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(response.contains("connected"));

    let callback = waiting.await.unwrap().unwrap();
    assert_eq!(callback.code, "auth-code");
    assert_eq!(callback.state, "csrf-state");
}

#[tokio::test]
async fn an_unrelated_request_is_answered_and_the_wait_continues() {
    let loopback = Loopback::bind().await.unwrap();
    let port = port_of(&loopback);
    let waiting = tokio::spawn(loopback.wait(Duration::from_secs(5)));

    let response = get(port, "/favicon.ico").await;
    assert!(response.starts_with("HTTP/1.1 404 Not Found"));

    get(port, "/?code=auth-code&state=csrf-state").await;
    assert_eq!(waiting.await.unwrap().unwrap().code, "auth-code");
}

#[tokio::test]
async fn denied_consent_is_cancelled_not_a_failure() {
    let loopback = Loopback::bind().await.unwrap();
    let port = port_of(&loopback);
    let waiting = tokio::spawn(loopback.wait(Duration::from_secs(5)));

    let response = get(port, "/?error=access_denied").await;
    assert!(response.contains("wasn"));

    assert!(matches!(
        waiting.await.unwrap(),
        Err(GoogleError::Cancelled)
    ));
}

#[tokio::test]
async fn another_google_error_is_not_mistaken_for_cancellation() {
    let loopback = Loopback::bind().await.unwrap();
    let port = port_of(&loopback);
    let waiting = tokio::spawn(loopback.wait(Duration::from_secs(5)));

    get(port, "/?error=invalid_scope").await;

    assert!(matches!(
        waiting.await.unwrap(),
        Err(GoogleError::Protocol(_))
    ));
}

#[tokio::test]
async fn a_code_without_state_is_refused() {
    let loopback = Loopback::bind().await.unwrap();
    let port = port_of(&loopback);
    let waiting = tokio::spawn(loopback.wait(Duration::from_secs(5)));

    get(port, "/?code=auth-code").await;

    assert!(matches!(
        waiting.await.unwrap(),
        Err(GoogleError::Protocol(_))
    ));
}

#[tokio::test]
async fn an_abandoned_authorization_times_out_and_frees_the_port() {
    let loopback = Loopback::bind().await.unwrap();
    let port = port_of(&loopback);

    let result = loopback.wait(Duration::from_millis(50)).await;
    assert!(matches!(result, Err(GoogleError::Cancelled)));

    assert!(tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .is_ok());
}
